//! crates.io: sparse index files (`/crates/index/...`) are cached for the metadata TTL. `config.json` is rewritten so
//! `dl` points at this cache, and each index line's `cksum` names the `.crate` download. A `.crate` is served only
//! through a current index-file link and verified against that `cksum` (SHA-256).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::Response;
use serde_json::Value;

use crate::cache::{self, Artifact, Rewritten};
use crate::digest::{parse_hex, Algo};
use crate::error::Error;
use crate::store::Cached;
use crate::{is_safe_path, AppState, Config};

const LINK_KIND: &str = "crate-dl";
const INDEX_ACCEPT: &str = "text/plain, application/json;q=0.5, */*;q=0.1";

pub async fn index(
    State(state): State<Arc<AppState>>,
    Path(rest): Path<String>,
) -> Result<Response, Error> {
    if !is_safe_path(&rest) {
        return Err(Error::BadRequest(format!(
            "not a crates.io index path: {rest}"
        )));
    }
    let cached = if rest == "config.json" {
        let upstream = format!("{}/config.json", state.config.crates_index);
        cache::metadata(
            &state,
            "crates-config",
            "",
            "config.json",
            &upstream,
            INDEX_ACCEPT,
            rewrite_config,
        )
        .await?
    } else {
        fetch_index_file(&state, &rest).await?
    };
    Ok(cache::cached_response(cached))
}

pub async fn download(
    State(state): State<Arc<AppState>>,
    Path(rest): Path<String>,
) -> Result<Response, Error> {
    let (name, version) = match rest.split('/').collect::<Vec<_>>()[..] {
        [name, version] if is_safe_path(&rest) => (name, version),
        _ => {
            return Err(Error::BadRequest(format!(
                "expected /crates/dl/<name>/<version>, got {rest}"
            )))
        }
    };
    let key = format!("{name}/{version}");
    let link = cache::resolve_link(
        &state,
        LINK_KIND,
        &key,
        fetch_index_file(&state, &index_path(name)),
    )
    .await?;
    let (file, len, pin) = cache::artifact(&state, LINK_KIND, &key, &link).await?;
    Ok(cache::file_response(file, len, pin))
}

async fn fetch_index_file(state: &Arc<AppState>, path: &str) -> Result<Cached, Error> {
    let upstream = format!("{}/{path}", state.config.crates_index);
    cache::metadata(
        state,
        "crates-index",
        "",
        path,
        &upstream,
        INDEX_ACCEPT,
        rewrite_index,
    )
    .await
}

/// The sparse index path of a crate name (lowercased), per the registry index layout.
fn index_path(name: &str) -> String {
    let name = name.to_ascii_lowercase();
    match name.len() {
        1 => format!("1/{name}"),
        2 => format!("2/{name}"),
        3 => format!("3/{}/{name}", &name[..1]),
        _ => format!("{}/{}/{name}", &name[..2], &name[2..4]),
    }
}

fn rewrite_config(
    config: &Config,
    upstream: &str,
    body: &[u8],
    content_type: &str,
) -> Result<Rewritten, String> {
    let mut doc: Value = serde_json::from_slice(body)
        .map_err(|e| format!("{upstream} sent an invalid config.json: {e}"))?;
    let object = doc
        .as_object_mut()
        .ok_or_else(|| format!("{upstream} sent a config.json that is not an object"))?;
    object.insert(
        "dl".to_owned(),
        Value::String(format!(
            "{}/crates/dl/{{crate}}/{{version}}",
            config.public_base_url
        )),
    );
    let body = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
    Ok(Rewritten {
        body,
        content_type: content_type.to_owned(),
        links: Vec::new(),
    })
}

/// Index files are served unchanged; each version line names its `.crate` by `cksum`.
fn rewrite_index(
    config: &Config,
    upstream: &str,
    body: &[u8],
    content_type: &str,
) -> Result<Rewritten, String> {
    let text =
        std::str::from_utf8(body).map_err(|_| format!("{upstream} sent a non-UTF-8 index file"))?;
    let mut links = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let entry: Value = serde_json::from_str(line)
            .map_err(|e| format!("{upstream} sent a bad index line: {e}"))?;
        let (Some(name), Some(version), Some(cksum)) = (
            entry.get("name").and_then(Value::as_str),
            entry.get("vers").and_then(Value::as_str),
            entry.get("cksum").and_then(Value::as_str),
        ) else {
            continue;
        };
        let key = format!("{name}/{version}");
        let Some(expected) = parse_hex(Algo::Sha256, cksum) else {
            continue;
        };
        if !is_safe_path(&key) {
            continue;
        }
        let upstream = format!("{}/{name}/{name}-{version}.crate", config.crates_static);
        links.push((LINK_KIND, key, Artifact { upstream, expected }));
    }
    Ok(Rewritten {
        body: body.to_vec(),
        content_type: content_type.to_owned(),
        links,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_paths_follow_the_sparse_layout() {
        assert_eq!(index_path("a"), "1/a");
        assert_eq!(index_path("ab"), "2/ab");
        assert_eq!(index_path("abc"), "3/a/abc");
        assert_eq!(index_path("Serde"), "se/rd/serde");
    }

    #[test]
    fn index_lines_name_their_crate_by_cksum() {
        let config = crate::test_config();
        let cksum = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        let body = format!("{{\"name\":\"foo\",\"vers\":\"1.0.0\",\"cksum\":\"{cksum}\"}}\n{{\"name\":\"foo\",\"vers\":\"1.1.0\",\"cksum\":\"nope\"}}\n");
        let out = rewrite_index(
            &config,
            "https://index.crates.io/3/f/foo",
            body.as_bytes(),
            "text/plain",
        )
        .expect("index");
        assert_eq!(out.body, body.as_bytes());
        assert_eq!(out.links.len(), 1);
        let (kind, key, artifact) = &out.links[0];
        assert_eq!((*kind, key.as_str()), ("crate-dl", "foo/1.0.0"));
        assert_eq!(
            artifact.upstream,
            "https://static.crates.io/crates/foo/foo-1.0.0.crate"
        );
        assert_eq!(artifact.expected.hex, cksum);
    }

    #[test]
    fn config_dl_points_at_the_cache_with_cargo_markers() {
        let config = crate::test_config();
        let body = br#"{"dl":"https://static.crates.io/crates","api":"https://crates.io"}"#;
        let out = rewrite_config(
            &config,
            "https://index.crates.io/config.json",
            body,
            "application/json",
        )
        .expect("config");
        let doc: Value = serde_json::from_slice(&out.body).expect("json");
        assert_eq!(
            doc["dl"],
            "http://169.254.0.1:3141/crates/dl/{crate}/{version}"
        );
        assert_eq!(doc["api"], "https://crates.io");
    }
}
