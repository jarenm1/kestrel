/**
 * The `gh` agents run inside the sandbox. It holds no GitHub credential: it sends the command line, the working
 * directory and the contents of the files the command reads (`--body-file`/`-F` for `gh pr`, `--input` and
 * `-F key=@file` for `gh api`) to the box with the run's broker token, then replays what the box says the command
 * printed and its exit code. Needs bash, curl and coreutils, which every sandbox level has.
 *
 * Request body (`kestrel-gh/1`): NUL-terminated fields `kestrel-gh/1`, cwd, argc, each argument, file count, then per
 * file its path and byte length (-1 when unreadable), then the file bytes back to back.
 * Response: stderr bytes then stdout bytes; `x-gh-exit` and `x-gh-stderr-bytes` say where they split.
 */
export const GH_SHIM_SCRIPT = `#!/usr/bin/env bash
# gh for Kestrel agents: runs GitHub CLI commands through the Kestrel box, with the thread owner's GitHub
# connection. The box writes this file for every run.
set -u
if [ -z "\${KESTREL_GH_URL:-}" ] || [ -z "\${KESTREL_GH_TOKEN:-}" ]; then
  echo "gh: only available inside a Kestrel agent run" >&2
  exit 1
fi
tmp="$(mktemp -d)" || exit 1
trap 'rm -rf "$tmp"' EXIT

# Files the command reads are read here, inside the sandbox, where their paths make sense.
files=()
next=""
# gh api -F key=@path reads path ("-" is standard input).
field_file() { local value="\${1#*=}"; if [ "$value" != "$1" ] && [ "\${value#@}" != "$value" ]; then files+=("\${value#@}"); fi; }
mode=pr
if [ "\${1:-}" = api ]; then mode=api; fi
for arg in "$@"; do
  case "$next" in
    file) files+=("$arg"); next=""; continue ;;
    field) field_file "$arg"; next=""; continue ;;
  esac
  if [ "$mode" = api ]; then
    case "$arg" in
      --) break ;;
      --input) next=file ;;
      --input=*) files+=("\${arg#--input=}") ;;
      -F|--field) next=field ;;
      --field=*) field_file "\${arg#--field=}" ;;
      -F=*) field_file "\${arg#-F=}" ;;
      -F?*) field_file "\${arg#-F}" ;;
    esac
  else
    case "$arg" in
      --) break ;;
      --body-file|-F) next=file ;;
      --body-file=*) files+=("\${arg#--body-file=}") ;;
      -F=*) files+=("\${arg#-F=}") ;;
      -F?*) files+=("\${arg#-F}") ;;
    esac
  fi
done

source_of() { if [ "$1" = "-" ]; then printf '%s' "$tmp/stdin"; else printf '%s' "$1"; fi; }
for f in "\${files[@]}"; do
  if [ "$f" = "-" ] && [ ! -e "$tmp/stdin" ]; then cat > "$tmp/stdin"; fi
done

{
  printf 'kestrel-gh/1\\0%s\\0%s\\0' "$PWD" "$#"
  for arg in "$@"; do printf '%s\\0' "$arg"; done
  printf '%s\\0' "\${#files[@]}"
  for f in "\${files[@]}"; do
    src="$(source_of "$f")"
    if [ -f "$src" ] && [ -r "$src" ]; then
      printf '%s\\0%s\\0' "$f" "$(wc -c < "$src" | tr -d ' ')"
    else
      printf '%s\\0-1\\0' "$f"
    fi
  done
  for f in "\${files[@]}"; do
    src="$(source_of "$f")"
    if [ -f "$src" ] && [ -r "$src" ]; then cat "$src"; fi
  done
} > "$tmp/request"

status="$(curl -sS -o "$tmp/response" -D "$tmp/headers" -w '%{http_code}' \\
  -H "authorization: Bearer $KESTREL_GH_TOKEN" -H 'content-type: application/octet-stream' \\
  --data-binary @"$tmp/request" "$KESTREL_GH_URL")" || { echo "gh: could not reach the Kestrel box" >&2; exit 1; }
if [ "$status" != 200 ]; then
  echo "gh: the Kestrel box refused the command (HTTP $status)" >&2
  cat "$tmp/response" >&2
  exit 1
fi
header() { tr -d '\\r' < "$tmp/headers" | awk -v name="$1" 'BEGIN { FS = ": *" } tolower($1) == name { value = $2 } END { print value }'; }
code="$(header x-gh-exit)"
errlen="$(header x-gh-stderr-bytes)"
head -c "\${errlen:-0}" "$tmp/response" >&2
tail -c +"$(( \${errlen:-0} + 1 ))" "$tmp/response"
exit "\${code:-1}"
`
