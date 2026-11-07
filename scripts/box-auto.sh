#!/usr/bin/env bash
# Run an independent box checkout, updating only when idle (or after the configured deadline).
set -euo pipefail

dir="${KESTREL_BOX_DIR:-$HOME/.local/share/kestrel-box}"
repo="${KESTREL_BOX_REPO:-https://github.com/jarenm1/kestrel.git}"
ref="${KESTREL_BOX_REF:-main}"
interval="${KESTREL_BOX_POLL:-60}"
max_defer="${KESTREL_BOX_MAX_DEFER:-21600}"
case "$max_defer" in
  "" | *[!0-9]*) echo "box-auto: KESTREL_BOX_MAX_DEFER must be a whole number of seconds" >&2; exit 1 ;;
esac
if [ ! -d "$dir/.git" ]; then
  git clone -q "$repo" "$dir"
fi
if [ ! -f "$dir/.box.env" ]; then
  if [ -f .box.env ]; then
    install -m 600 .box.env "$dir/.box.env"
  else
    echo "missing $dir/.box.env (CLOUDAGENTS_CONTROL_URL, CLOUDAGENTS_BOX_TOKEN)" >&2
    exit 1
  fi
fi
cd "$dir"
dir="$PWD"
# shellcheck source=/dev/null
data_dir="$(set -a && . ./.box.env && set +a && printf '%s' "${CLOUDAGENTS_DATA_DIR:-$dir/.data}")"
case "$data_dir" in
  /*) ;;
  *) echo "box-auto: CLOUDAGENTS_DATA_DIR must be an absolute path (got $data_dir)" >&2; exit 1 ;;
esac
sock="$data_dir/box.sock"

fetch_target() {
  git fetch -q origin "$ref" && git rev-parse --verify -q 'FETCH_HEAD^{commit}'
}
activity() {
  curl -sf --max-time 5 --unix-socket "$sock" http://box/activity |
    jq -er '"\(.runs | numbers) \(.desktops | numbers)"'
}
child=""
stop() {
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill -TERM -- "-$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  child=""
}
start() {
  echo "box-auto: starting box at $(git rev-parse --short HEAD)" >&2
  bun install --frozen-lockfile >/dev/null
  setsid nix run .#box &
  child=$!
}
trap 'stop; exit 0' INT TERM

if target="$(fetch_target)"; then
  git reset -q --hard "$target"
else
  echo "box-auto: fetch of $ref failed; starting the current checkout" >&2
fi
start
pending=""
pending_since=0
logged=""
while true; do
  sleep "$interval" &
  wait $! || true
  if ! kill -0 "$child" 2>/dev/null; then
    echo "box-auto: box exited; restarting" >&2
    start
    continue
  fi
  if ! target="$(fetch_target)"; then
    echo "box-auto: fetch of $ref failed; will retry" >&2
    continue
  fi
  if [ "$(git rev-parse HEAD)" = "$target" ]; then
    pending=""
    continue
  fi
  if [ -z "$pending" ]; then
    pending_since="$(date +%s)"
  fi
  pending="$target"
  if [ "$max_defer" -gt 0 ] && [ "$(($(date +%s) - pending_since))" -ge "$max_defer" ]; then
    echo "box-auto: $ref waited ${max_defer}s for an idle box; updating now" >&2
  elif counts="$(activity)"; then
    read -r runs desktops <<<"$counts"
    if [ "$runs" -gt 0 ] || [ "$desktops" -gt 0 ]; then
      if [ "$logged" != "$target" ]; then
        echo "box-auto: $ref moved to $(git rev-parse --short "$target"); deferring while busy ($runs runs, $desktops desktops)" >&2
        logged="$target"
      fi
      continue
    fi
  else
    echo "box-auto: no answer from $sock; updating without an idle check" >&2
  fi
  echo "box-auto: $ref moved to $(git rev-parse --short "$target"); updating" >&2
  stop
  git reset -q --hard "$target"
  pending=""
  logged=""
  start
done
