#!/bin/bash
set -euo pipefail

# Generate a draft changelog section from git commits.
# Usage: scripts/changelog-draft.sh <version>

VERSION=${1:-}
if [[ -z "$VERSION" ]]; then
  echo "Usage: scripts/changelog-draft.sh <version>" >&2
  exit 1
fi

DATE=$(date -u +%Y-%m-%d)

# Prefer last tag as base; fallback to full history.
BASE_REF=$(git describe --tags --abbrev=0 2>/dev/null || true)
if [[ -n "$BASE_REF" ]]; then
  RANGE="$BASE_REF..HEAD"
else
  RANGE="HEAD"
fi

COMMITS=$(git log $RANGE --no-merges --pretty=format:"- %s (%h)")
if [[ -z "$COMMITS" ]]; then
  COMMITS="- No changes recorded."
fi

cat <<EOF
## [${VERSION}] - ${DATE}

### Changes

${COMMITS}

### Fixes

- N/A

EOF
