#!/usr/bin/env bash
# Builds dist/pwmgr.zip (for "Load unpacked") and dist/pwmgr.crx (signed package).
# Usage: scripts/build.sh [path/to/pwmgr-key.pem]
# The .pem is the private signing key; it must match the "key" in manifest.json
# so the extension ID (and therefore your saved vault) stays the same across versions.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
key="${1:-$root/pwmgr-key.pem}"
chrome="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || ls /opt/pw-browsers/chromium-*/chrome-linux64/chrome 2>/dev/null | head -1 || true)}"
files=(manifest.json src popup options ui icons)

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/pwmgr" "$root/dist"
(cd "$root" && cp -r "${files[@]}" "$stage/pwmgr/")

rm -f "$root/dist/pwmgr.zip"
(cd "$stage" && zip -qr "$root/dist/pwmgr.zip" pwmgr)
echo "Built dist/pwmgr.zip"

if [[ ! -f "$key" ]]; then
  echo "No signing key at $key — skipping .crx" >&2
  exit 0
fi
if [[ -z "$chrome" ]]; then
  echo "No Chrome/Chromium binary found (set CHROME=...) — skipping .crx" >&2
  exit 0
fi
"$chrome" --headless=new --no-sandbox --disable-gpu --user-data-dir="$stage/profile" \
  --pack-extension="$stage/pwmgr" --pack-extension-key="$key" >/dev/null 2>&1 || true
[[ -f "$stage/pwmgr.crx" ]] || { echo "Packing the .crx failed" >&2; exit 1; }
mv "$stage/pwmgr.crx" "$root/dist/pwmgr.crx"
echo "Built dist/pwmgr.crx"
