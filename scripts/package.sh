#!/usr/bin/env bash
# Build dist/minimal-bilingual-translate-<version>.zip from extension/ and print its sha256.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
zip_path="dist/minimal-bilingual-translate-$version.zip"
mkdir -p dist && rm -f "$zip_path"
zip -qrX "$zip_path" extension
sha256sum "$zip_path" | tee "$zip_path.sha256"
