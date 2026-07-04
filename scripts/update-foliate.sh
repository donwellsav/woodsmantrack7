#!/usr/bin/env bash
# Re-vendor foliate-js into public/foliate-js/.
#
# Why this script exists: the README documents that foliate-js is vendored
# intentionally so its dynamic imports resolve under Vite (which blocks
# `import()` from `public/`). Vendoring creates a refresh-discipline problem —
# upstream security releases will not reach this project without a manual step.
#
# Run this when upgrading to a new foliate-js release, or monthly at minimum
# to verify we haven't drifted behind a security fix.
#
# Usage: scripts/update-foliate.sh [version]
#   version: optional npm version tag (e.g. 1.2.3); defaults to "latest"
#
# After running: review `git diff public/foliate-js/`, run `npm run dev`, and
# confirm the EPUB still opens and chapter navigation still works (the audit
# 2026-07-04 broke at runtime when section offsets drifted from the hard-coded
# CFI map, so this is non-trivial).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/public/foliate-js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

VERSION="${1:-latest}"

echo "Fetching foliate-js@$VERSION into $TMP ..."
npm pack --pack-destination "$TMP" "foliate-js@$VERSION" >/dev/null
tar -xzf "$TMP"/*.tgz -C "$TMP"

# The npm package places its files under package/. Copy only what we vendored.
SRC="$TMP/package"

echo "Replacing $TARGET with upstream ..."
rm -rf "$TARGET"
mkdir -p "$TARGET"
# The foliate npm package exposes only the .js modules under its root.
cp "$SRC"/*.js "$TARGET/"
# Vendor the small vendor/ subset we currently use (zip.js + fflate + pdfjs).
# Adjust here when trimming per PERF-4 / PERF-14.
if [ -d "$SRC/vendor" ]; then
  cp -R "$SRC/vendor" "$TARGET/"
fi

# Strip the README and package.json — they are not needed at runtime and would
# only inflate the precache.
rm -f "$TARGET/README.md" "$TARGET/rollup.config.js" "$TARGET/eslint.config.js"

# Touch every file to the current time so downstream mtime-based checks
# (the audit uses `stat -c %y public/foliate-js/*.js` to detect vendored drift)
# show a uniform timestamp.
find "$TARGET" -type f -exec touch {} \;

echo
echo "Done. Review diff:"
echo "  git diff --stat public/foliate-js/"
echo
echo "Then smoke-test:"
echo "  cd $ROOT && npm run dev"
echo "  open http://localhost:5173/  (or whichever port vite logs)"
echo
echo "Announce the new vendored version in the README under 'Security notes'."
