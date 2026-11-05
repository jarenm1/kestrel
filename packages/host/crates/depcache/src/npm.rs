//! npm: packuments (`/npm/<name>`) are fetched, cached for the metadata TTL, and rewritten so each verifiable tarball
//! URL points at this cache. A tarball (`/npm/<name>/-/<file>.tgz`) is served only through a current packument link
//! and verified against its `dist.integrity`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::Value;

use crate::cache::{self, Artifact, Rewritten};
use crate::digest::parse_sri;
use crate::error::Error;
use crate::store::Cached;
use crate::{accept_header, is_safe_path, AppState, Config};

const LINK_KIND: &str = "npm-tarball";
const ABBREVIATED_ACCEPT: &str =
    "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const FULL_ACCEPT: &str = "application/json";
const ABBREVIATED_TYPE: &str = "application/vnd.npm.install-v1+json";

pub async fn serve(
    State(state): State<Arc<AppState>>,
    Path(rest): Path<String>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    if !is_safe_path(&rest) {
        return Err(Error::BadRequest(format!("not an npm path: {rest}")));
    }
    match rest.split_once("/-/") {
        Some((name, _)) => {
            let link = cache::resolve_link(
                &state,
                LINK_KIND,
                &rest,
                fetch_packument(&state, name, true),
            )
            .await?;
            let (file, len, pin) = cache::artifact(&state, LINK_KIND, &rest, &link).await?;
            Ok(cache::file_response(file, len, pin))
        }
        None => {
            let abbreviated = accept_header(&headers).contains(ABBREVIATED_TYPE);
            let cached = fetch_packument(&state, &rest, abbreviated).await?;
            Ok(cache::cached_response(cached))
        }
    }
}

async fn fetch_packument(
    state: &Arc<AppState>,
    name: &str,
    abbreviated: bool,
) -> Result<Cached, Error> {
    let (variant, accept) = if abbreviated {
        ("abbreviated", ABBREVIATED_ACCEPT)
    } else {
        ("full", FULL_ACCEPT)
    };
    let upstream = format!("{}/{}", state.config.npm_registry, name.replace('/', "%2F"));
    cache::metadata(
        state,
        "npm-packument",
        variant,
        name,
        &upstream,
        accept,
        rewrite_packument,
    )
    .await
}

/// Points every version whose tarball is on the registry and has a usable digest at this cache. Other versions are
/// left as they are, so clients fetch them from the origin.
pub fn rewrite_packument(
    config: &Config,
    upstream: &str,
    body: &[u8],
    content_type: &str,
) -> Result<Rewritten, String> {
    let mut doc: Value = serde_json::from_slice(body)
        .map_err(|e| format!("{upstream} did not send a packument: {e}"))?;
    let registry_prefix = format!("{}/", config.npm_registry);
    let mut links = Vec::new();
    if let Some(versions) = doc.get_mut("versions").and_then(Value::as_object_mut) {
        for version in versions.values_mut() {
            let Some(dist) = version.get_mut("dist").and_then(Value::as_object_mut) else {
                continue;
            };
            let Some(tarball) = dist
                .get("tarball")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            let Some(rest) = tarball.strip_prefix(&registry_prefix) else {
                continue;
            };
            if !is_safe_path(rest) {
                continue;
            }
            let Some(expected) = dist
                .get("integrity")
                .and_then(Value::as_str)
                .and_then(parse_sri)
            else {
                continue;
            };
            let public = format!("{}/npm/{rest}", config.public_base_url);
            links.push((
                LINK_KIND,
                rest.to_owned(),
                Artifact {
                    upstream: tarball,
                    expected,
                },
            ));
            dist.insert("tarball".to_owned(), Value::String(public));
        }
    }
    let body = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
    Ok(Rewritten {
        body,
        content_type: content_type.to_owned(),
        links,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::digest::Algo;

    #[test]
    fn packument_rewrites_only_verifiable_registry_tarballs() {
        let config = crate::test_config();
        let sha512 = format!("sha512-{}", base64_of(&[7u8; 64]));
        let doc = json!({
            "name": "pkg",
            "versions": {
                "1.0.0": { "dist": {
                    "tarball": "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
                    "integrity": sha512,
                }},
                "1.1.0": { "dist": {
                    "tarball": "https://registry.npmjs.org/pkg/-/pkg-1.1.0.tgz",
                    "shasum": "a9993e364706816aba3e25717850c26c9cd0d89d",
                }},
                "1.2.0": { "dist": {
                    "tarball": "https://registry.npmjs.org/pkg/-/pkg-1.2.0.tgz",
                    "integrity": "md5-AAAAAAAAAAAAAAAAAAAAAA==",
                }},
                "1.3.0": { "dist": {
                    "tarball": "https://elsewhere.example/pkg/-/pkg-1.3.0.tgz",
                    "integrity": sha512,
                }},
            }
        });
        let out = rewrite_packument(
            &config,
            "https://registry.npmjs.org/pkg",
            doc.to_string().as_bytes(),
            "application/json",
        )
        .expect("packument");
        let doc: Value = serde_json::from_slice(&out.body).expect("json");
        let tarball = |v: &str| {
            doc["versions"][v]["dist"]["tarball"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(
            tarball("1.0.0"),
            "http://169.254.0.1:3141/npm/pkg/-/pkg-1.0.0.tgz"
        );
        assert_eq!(
            tarball("1.1.0"),
            "https://registry.npmjs.org/pkg/-/pkg-1.1.0.tgz"
        );
        assert_eq!(
            tarball("1.2.0"),
            "https://registry.npmjs.org/pkg/-/pkg-1.2.0.tgz"
        );
        assert_eq!(
            tarball("1.3.0"),
            "https://elsewhere.example/pkg/-/pkg-1.3.0.tgz"
        );
        let algos: Vec<Algo> = out
            .links
            .iter()
            .map(|(_, _, artifact)| artifact.expected.algo)
            .collect();
        assert_eq!(algos, vec![Algo::Sha512]);
    }

    fn base64_of(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
}
