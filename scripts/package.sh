#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64) ARCH="x64";;
  aarch64|arm64) ARCH="arm64";;
  *) echo "Unsupported arch: $ARCH"; exit 1;;
 esac

mkdir -p dist/release

pnpm run build:all

TARBALL="$ROOT_DIR/dist/release/mozi-${VERSION}-${OS}-${ARCH}.tar.gz"

# Package binaries
mkdir -p dist/release/tmp
cp dist/mozi.mjs dist/release/tmp/
cp dist/mozi-runtime.mjs dist/release/tmp/
cp package.json dist/release/tmp/
cp release/README.md dist/release/tmp/README.md
cp release/config.example.jsonc dist/release/tmp/

( cd dist/release/tmp && tar -czf "$TARBALL" mozi.mjs mozi-runtime.mjs package.json README.md config.example.jsonc )

rm -rf dist/release/tmp

echo "Package created: $TARBALL"
