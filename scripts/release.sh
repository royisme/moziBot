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

DRAFT_FILE=$(mktemp)
printf "%s" "$DRAFT" > "$DRAFT_FILE"

export DRAFT_FILE NOTE NOTE_LINE

node <<'NODE'
const fs = require("fs");
const changelogPath = "CHANGELOG.md";
const draftPath = process.env.DRAFT_FILE;
const note = process.env.NOTE;
const noteLine = process.env.NOTE_LINE;

const draftRaw = fs.readFileSync(draftPath, "utf8");
const draft = note ? draftRaw.replace("### Changes\n\n", `### Changes\n\n${noteLine}\n`) : draftRaw;
const data = fs.readFileSync(changelogPath, "utf8");

const pattern = /## \[Unreleased\]\n\n(?:- .*\n)*/;
if (!pattern.test(data)) {
  throw new Error("CHANGELOG.md missing [Unreleased] section.");
}

const updated = data.replace(pattern, `## [Unreleased]\n\n- N/A\n\n${draft}`);
fs.writeFileSync(changelogPath, updated);
NODE

rm -f "$DRAFT_FILE"

echo "Release prep complete: ${VERSION} (${DATE})"
