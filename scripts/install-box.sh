#!/bin/sh
# Downloads the kestrel-box binary, pairs this machine, and starts the box as a user service.
# Usage: install-box.sh [--no-login] [--no-install]
set -eu

BASE_URL="${KESTREL_BOX_BASE_URL:-https://github.com/jarenm1/kestrel/releases/latest/download}"
RUN_LOGIN=1
RUN_INSTALL=1

usage() {
  cat <<'EOF'
Usage: install-box.sh [--no-login] [--no-install]
  --no-login     download the binary only; skip pairing
  --no-install   download and pair; skip installing the service
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-login) RUN_LOGIN=0 ;;
    --no-install) RUN_INSTALL=0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "install-box.sh: unknown option $arg" >&2; usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "install-box.sh: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "install-box.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "install-box.sh: curl is required" >&2
  exit 1
fi

bin_dir="$HOME/.local/bin"
target="$bin_dir/kestrel-box"
mkdir -p "$bin_dir"

echo "downloading kestrel-box ($os-$arch)"
curl -fsSL "$BASE_URL/kestrel-box-$os-$arch" -o "$target.new"
chmod 755 "$target.new"
mv -f "$target.new" "$target"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "warning: $bin_dir is not on PATH; add it to your shell profile" ;;
esac

if [ "$RUN_LOGIN" = 1 ]; then
  "$target" login
fi
if [ "$RUN_INSTALL" = 1 ]; then
  "$target" install
fi
echo "kestrel-box installed at $target"
