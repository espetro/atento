#!/bin/sh
# Install the atento CLI and MCP server from the latest GitHub Release.
#   curl -fsSL https://raw.githubusercontent.com/espetro/atento/main/install.sh | sh
# Env: ATENTO_VERSION (default latest), ATENTO_PREFIX (default ~/.local).
set -eu

repo="espetro/atento"
prefix="${ATENTO_PREFIX:-$HOME/.local}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "atento: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "atento: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

if [ -n "${ATENTO_VERSION:-}" ]; then
  version="${ATENTO_VERSION#v}"
else
  version="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$version" ] || { echo "atento: could not resolve the latest version" >&2; exit 1; }

name="atento-$version-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "==> downloading $name"
curl -fsSL "https://github.com/$repo/releases/download/v$version/$name.tar.gz" -o "$tmp/atento.tar.gz"

dest="$prefix/share/atento"
rm -rf "$dest"
mkdir -p "$dest" "$prefix/bin"
tar -xzf "$tmp/atento.tar.gz" -C "$dest" --strip-components=1
ln -sf "$dest/bin/atento" "$prefix/bin/atento"
ln -sf "$dest/bin/atento-mcp" "$prefix/bin/atento-mcp"

echo "==> installed atento $version to $prefix/bin"
case ":$PATH:" in *":$prefix/bin:"*) ;; *) echo "    add $prefix/bin to your PATH" ;; esac
echo "    try: atento --help   |   claude mcp add atento -- atento-mcp"
