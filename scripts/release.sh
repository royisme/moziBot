#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=${1:-}
NOTE=${2:-}

if [[ -z "$VERSION" ]]; then
  echo "Usage: scripts/release.sh <version> [note]"
  exit 1
fi

DATE=$(date -u +%Y-%m-%d)

# Update package.json version
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='${VERSION}';fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');"

# Update runtime version constant for compiled binaries
cat > src/version.ts <<EOF
export const APP_VERSION = "${VERSION}";
EOF

# Ensure CHANGELOG exists
if [[ ! -f CHANGELOG.md ]]; then
  cat > CHANGELOG.md <<EOF
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- N/A
EOF
fi

NOTE_LINE="- ${NOTE:-Released version ${VERSION}.}"

# Generate draft from git commits
DRAFT=$(bash scripts/changelog-draft.sh "${VERSION}")

# Insert release section after Unreleased
perl -0777 -i -pe "s/## \[Unreleased\]\n\n(?:- .*\n)*/## [Unreleased]\n\n- N/A\n\n${DRAFT}/" CHANGELOG.md

# If a manual note is provided, add it to Changes
if [[ -n "$NOTE" ]]; then
  perl -0777 -i -pe "s/### Changes\n\n/### Changes\n\n${NOTE_LINE}\n/" CHANGELOG.md
fi

echo "Release prep complete: ${VERSION} (${DATE})"
