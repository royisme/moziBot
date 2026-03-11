#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  echo "Usage: scripts/release.sh [patch|minor|major] [note]" >&2
  exit 1
}

BUMP_TYPE="${1:-patch}"
NOTE="${2:-}"

case "$BUMP_TYPE" in
  patch|minor|major) ;;
  "") BUMP_TYPE="patch" ;;
  *)
    echo "Invalid bump type: $BUMP_TYPE" >&2
    usage
    ;;
 esac

CURRENT_VERSION=$(node -p "const pkg=require('./package.json'); if (!pkg.version) throw new Error('package.json version is missing.'); pkg.version")
NEXT_VERSION=$(node -e '
const [currentVersion, bumpType] = process.argv.slice(1);
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(currentVersion);
if (!match) {
  console.error(`Unsupported package.json version: ${currentVersion}`);
  process.exit(1);
}
const [, major, minor, patch] = match;
const next = {
  patch: [Number(major), Number(minor), Number(patch) + 1],
  minor: [Number(major), Number(minor) + 1, 0],
  major: [Number(major) + 1, 0, 0],
}[bumpType];
if (!next) {
  console.error(`Unsupported bump type: ${bumpType}`);
  process.exit(1);
}
console.log(next.join("."));
' "$CURRENT_VERSION" "$BUMP_TYPE")

DATE=$(date -u +%Y-%m-%d)

ROLLBACK_DIR=$(mktemp -d)
cp package.json "$ROLLBACK_DIR/package.json"
cp src/version.ts "$ROLLBACK_DIR/version.ts"
if [[ -f CHANGELOG.md ]]; then
  cp CHANGELOG.md "$ROLLBACK_DIR/changelog.md"
fi

restore_release_files() {
  cp "$ROLLBACK_DIR/package.json" package.json
  cp "$ROLLBACK_DIR/version.ts" src/version.ts
  if [[ -f "$ROLLBACK_DIR/changelog.md" ]]; then
    cp "$ROLLBACK_DIR/changelog.md" CHANGELOG.md
  else
    rm -f CHANGELOG.md
  fi
}

cleanup() {
  local status=$?

  if [[ $status -ne 0 ]]; then
    echo "Release prep failed; restoring release files." >&2
    restore_release_files
  fi

  rm -rf "$ROLLBACK_DIR"
  rm -f "${DRAFT_FILE:-}"
  exit $status
}

trap cleanup EXIT

node - "$NEXT_VERSION" <<'NODE'
const fs = require("node:fs");
const nextVersion = process.argv[2];

const packageJsonPath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

fs.writeFileSync("src/version.ts", `export const APP_VERSION = "${nextVersion}";\n`, "utf8");
NODE

pnpm exec oxfmt --write package.json >/dev/null

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

# Generate draft from git commits
DRAFT=$(bash scripts/changelog-draft.sh "$NEXT_VERSION")

DRAFT_FILE=$(mktemp)
printf "%s\n" "$DRAFT" > "$DRAFT_FILE"

export DRAFT_FILE NOTE NEXT_VERSION

node <<'NODE'
const fs = require("node:fs");

const changelogPath = "CHANGELOG.md";
const changelog = fs.readFileSync(changelogPath, "utf8");
const draft = fs.readFileSync(process.env.DRAFT_FILE, "utf8").trimEnd();
const note = process.env.NOTE?.trim();
const nextVersion = process.env.NEXT_VERSION;

if (!draft.startsWith(`## [${nextVersion}] - `)) {
  throw new Error(`Generated changelog draft did not start with version ${nextVersion}.`);
}

const unreleasedPattern = /^## \[Unreleased\]\n\n(?:- .*\n)*/m;
const unreleasedMatch = changelog.match(unreleasedPattern);
if (!unreleasedMatch) {
  throw new Error("CHANGELOG.md missing [Unreleased] section.");
}

const draftWithNote = note
  ? draft.replace("### Changes\n\n", `### Changes\n\n- ${note}\n`)
  : draft;

const updated = changelog.replace(
  unreleasedPattern,
  `## [Unreleased]\n\n- N/A\n\n${draftWithNote}\n\n`,
);

fs.writeFileSync(changelogPath, updated, "utf8");
NODE

run_step() {
  local label="$1"
  shift

  echo "==> ${label}"
  if ! "$@"; then
    echo "Release prep failed during: ${label}" >&2
    exit 1
  fi
}

run_step "pnpm run check" pnpm run check
run_step "pnpm run test" pnpm run test
run_step "pnpm run build:all" pnpm run build:all
run_step "pnpm run release:check" pnpm run release:check

echo "Release prep complete: ${CURRENT_VERSION} -> ${NEXT_VERSION} (${DATE}, ${BUMP_TYPE})"
echo "Next steps: commit release files, create tag v${NEXT_VERSION}, then push branch and tag."
