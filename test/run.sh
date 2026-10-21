#!/usr/bin/env bash
# Offline end-to-end test: starts the mock API and the test site, then drives headless Chrome.
# usage: test/run.sh [path/to/chrome]   (or set CHROME; Chrome / Chromium 116+, e.g. Chrome for Testing)
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="${1:-${CHROME:-}}"
if [[ -z "$chrome" ]]; then
  echo "usage: test/run.sh <path/to/chrome>  (or set CHROME)" >&2
  exit 2
fi
out=test/out
rm -rf "$out" && mkdir -p "$out"
python3 -I test/mock_openai.py 18080 "$out/mock.log" &
mock=$!
python3 -I -m http.server 18081 --bind 127.0.0.1 --directory test/site >/dev/null 2>&1 &
site=$!
trap 'kill $mock $site 2>/dev/null || true' EXIT
sleep 1
node test/cdp_test.mjs "$chrome" extension "$out/result.json"
