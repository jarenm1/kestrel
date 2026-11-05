//! PyPI: simple index pages (`/pypi/simple/<project>/`, HTML or PEP 691 JSON) are cached for the metadata TTL and
//! rewritten so each file link from the files origin points at this cache with its `sha256` fragment. A file
//! (`/pypi/files/<project>/<path>`) is served only through a current project-page link and verified against that `sha256`.

use std::sync::{Arc, LazyLock};

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use regex::{Captures, Regex};
use serde_json::Value;

use crate::cache::{self, Artifact, Rewritten};
use crate::digest::{parse_hex, Algo};
use crate::error::Error;
use crate::store::Cached;
use crate::{accept_header, is_safe_path, AppState, Config};

const LINK_KIND: &str = "pypi-file";
const JSON_TYPE: &str = "application/vnd.pypi.simple.v1+json";
const JSON_ACCEPT: &str = "application/vnd.pypi.simple.v1+json, text/html;q=0.1";
const HTML_ACCEPT: &str = "text/html";

static ANCHOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<a\s+([^>]*)>").expect("anchor regex"));
static HREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"href="([^"]*)""#).expect("href regex"));
/// Metadata siblings of a file (PEP 658). The cache does not serve them, so their attributes are stripped.
static METADATA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\s+(?:data-dist-info-metadata|data-core-metadata|core-metadata)(?:="[^"]*")?"#)
        .expect("metadata regex")
});

pub async fn simple(
    State(state): State<Arc<AppState>>,
    Path(rest): Path<String>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    let project = rest.trim_end_matches('/');
    if !is_safe_path(project) {
        return Err(Error::BadRequest(format!("not a PyPI project: {rest}")));
    }
    let json = accept_header(&headers).contains(JSON_TYPE);
    let cached = fetch_simple(&state, json, project).await?;
    Ok(cache::cached_response(cached))
}

async fn fetch_simple(state: &Arc<AppState>, json: bool, project: &str) -> Result<Cached, Error> {
    let (variant, accept) = if json {
        ("json", JSON_ACCEPT)
    } else {
        ("html", HTML_ACCEPT)
    };
    let upstream = format!("{}/simple/{project}/", state.config.pypi_index);
    cache::metadata(
        state,
        "pypi-simple",
        variant,
        project,
        &upstream,
        accept,
        rewrite_simple,
    )
    .await
}

pub async fn file(
    State(state): State<Arc<AppState>>,
    Path(rest): Path<String>,
) -> Result<Response, Error> {
    if !is_safe_path(&rest) {
        return Err(Error::BadRequest(format!("not a PyPI file path: {rest}")));
    }
    // A file path is `<project>/<path>`. The project names the page that lists the file, so an expired link is
    // refetched from that page.
    let Some((project, _)) = rest.split_once('/') else {
        return Err(Error::BadRequest(format!("not a PyPI file path: {rest}")));
    };
    let project = project.to_owned();
    let link = cache::resolve_link(
        &state,
        LINK_KIND,
        &rest,
        fetch_simple(&state, false, &project),
    )
    .await?;
    let (file, len, pin) = cache::artifact(&state, LINK_KIND, &rest, &link).await?;
    Ok(cache::file_response(file, len, pin))
}

/// The project a simple page describes, from its upstream URL `{pypi_index}/simple/<project>/`.
fn project_of<'a>(config: &Config, upstream: &'a str) -> Option<&'a str> {
    let rest = upstream.strip_prefix(&format!("{}/simple/", config.pypi_index))?;
    let project = rest.strip_suffix('/')?;
    is_safe_path(project).then_some(project)
}

fn rewrite_simple(
    config: &Config,
    upstream: &str,
    body: &[u8],
    content_type: &str,
) -> Result<Rewritten, String> {
    let project = project_of(config, upstream)
        .ok_or_else(|| format!("{upstream} is not a PyPI project page"))?;
    if content_type.contains("json") {
        rewrite_json(config, project, upstream, body, content_type)
    } else {
        rewrite_html(config, project, upstream, body, content_type)
    }
}

/// The cache key (`<project>/<path>`) and artifact of a file link whose URL is on the files origin, has no query, and
/// whose `sha256` is valid.
fn file_link(
    config: &Config,
    project: &str,
    url: &str,
    sha256: &str,
) -> Option<(String, Artifact)> {
    let prefix = format!("{}/", config.pypi_files);
    let path = url.strip_prefix(&prefix)?;
    if path.contains('?') || !is_safe_path(path) {
        return None;
    }
    let expected = parse_hex(Algo::Sha256, sha256)?;
    Some((
        format!("{project}/{path}"),
        Artifact {
            upstream: url.to_owned(),
            expected,
        },
    ))
}

/// The URL a client should fetch a verified file from.
fn public_file_url(config: &Config, key: &str, hex: &str) -> String {
    format!("{}/pypi/files/{key}#sha256={hex}", config.public_base_url)
}

fn rewrite_html(
    config: &Config,
    project: &str,
    upstream: &str,
    body: &[u8],
    content_type: &str,
) -> Result<Rewritten, String> {
    let page =
        std::str::from_utf8(body).map_err(|_| format!("{upstream} sent a non-UTF-8 index page"))?;
    let mut links = Vec::new();
    let rewritten = ANCHOR.replace_all(page, |caps: &Captures| {
        match rewrite_anchor(config, project, &caps[1]) {
            Some((tag, key, artifact)) => {
                links.push((LINK_KIND, key, artifact));
                tag
            }
            None => caps[0].to_owned(),
        }
    });
    Ok(Rewritten {
        body: rewritten.into_owned().into_bytes(),
        content_type: content_type.to_owned(),
        links,
    })
}

/// Rewrites one `<a>` tag's attributes; `None` leaves the tag as it is.
fn rewrite_anchor(
    config: &Config,
    project: &str,
    attrs: &str,
) -> Option<(String, String, Artifact)> {
    let href = HREF.captures(attrs)?[1].replace("&amp;", "&");
    let (url, fragment) = href.split_once('#')?;
    let sha256 = fragment.strip_prefix("sha256=")?;
    let (key, artifact) = file_link(config, project, url, sha256)?;
    let link = public_file_url(config, &key, &artifact.expected.hex);
    let attrs = METADATA.replace_all(attrs, "");
    let attrs = HREF.replace(&attrs, format!("href=\"{link}\"").as_str());
    Some((format!("<a {attrs}>"), key, artifact))
}

fn rewrite_json(
    config: &Config,
    project: &str,
    upstream: &str,
    body: &[u8],
    content_type: &str,
) -> Result<Rewritten, String> {
    let mut doc: Value =
        serde_json::from_slice(body).map_err(|e| format!("{upstream} sent invalid JSON: {e}"))?;
    let mut links = Vec::new();
    if let Some(files) = doc.get_mut("files").and_then(Value::as_array_mut) {
        for file in files {
            let Some(object) = file.as_object_mut() else {
                continue;
            };
            let url = object.get("url").and_then(Value::as_str).map(str::to_owned);
            let sha256 = object
                .get("hashes")
                .and_then(|hashes| hashes.get("sha256"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let (Some(url), Some(sha256)) = (url, sha256) else {
                continue;
            };
            let Some((key, artifact)) = file_link(config, project, &url, &sha256) else {
                continue;
            };
            object.remove("dist-info-metadata");
            object.remove("data-dist-info-metadata");
            object.remove("core-metadata");
            let link = public_file_url(config, &key, &artifact.expected.hex);
            object.insert("url".to_owned(), Value::String(link));
            links.push((LINK_KIND, key, artifact));
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
    use super::*;

    const GOOD: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[test]
    fn html_links_point_at_the_cache_only_when_verifiable() {
        let config = crate::test_config();
        let page = format!(
            concat!(
                r#"<a href="{files}/packages/aa/six-1.0-py3-none-any.whl#sha256={good}" data-core-metadata="sha256={good}">six</a>"#,
                "\n",
                r#"<a href="https://example.com/x.whl#sha256={good}">x</a>"#,
                "\n",
                r#"<a href="{files}/packages/bb/nohash-1.0.whl">nohash</a>"#,
            ),
            files = config.pypi_files,
            good = GOOD,
        );
        let out = rewrite_html(
            &config,
            "six",
            "https://pypi.org/simple/six/",
            page.as_bytes(),
            "text/html",
        )
        .expect("html");
        let html = String::from_utf8(out.body).expect("utf8");
        assert!(html.contains(&format!(
            r#"<a href="http://169.254.0.1:3141/pypi/files/six/packages/aa/six-1.0-py3-none-any.whl#sha256={GOOD}">six</a>"#
        )));
        assert!(html.contains(&format!(
            r#"<a href="https://example.com/x.whl#sha256={GOOD}">x</a>"#
        )));
        assert!(html.contains(&format!(
            r#"<a href="{}/packages/bb/nohash-1.0.whl">nohash</a>"#,
            config.pypi_files
        )));
        assert_eq!(out.links.len(), 1);
    }

    #[test]
    fn json_files_are_rewritten_and_metadata_links_removed() {
        let config = crate::test_config();
        let doc = serde_json::json!({
            "files": [{
                "filename": "six-1.0-py3-none-any.whl",
                "url": format!("{}/packages/aa/six-1.0-py3-none-any.whl", config.pypi_files),
                "hashes": { "sha256": GOOD },
                "core-metadata": { "sha256": GOOD },
            }]
        });
        let out = rewrite_json(
            &config,
            "six",
            "https://pypi.org/simple/six/",
            doc.to_string().as_bytes(),
            "application/vnd.pypi.simple.v1+json",
        )
        .expect("json");
        let doc: Value = serde_json::from_slice(&out.body).expect("json");
        assert_eq!(
            doc["files"][0]["url"],
            format!("http://169.254.0.1:3141/pypi/files/six/packages/aa/six-1.0-py3-none-any.whl#sha256={GOOD}")
        );
        assert!(doc["files"][0].get("core-metadata").is_none());
        assert_eq!(out.links.len(), 1);
    }
}
