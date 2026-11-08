#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
archive="$temporary/nodejs-mobile-android-24.21.0-0.zip"
node ../scripts/fetch-release-asset.js \
    --url 'https://github.com/fogtape/nodejs-mobile/releases/download/v24.21.0-0/nodejs-mobile-android-24.21.0-0.zip' \
    --sha256 'e3cd29a1be03405f11dd5c857af8cd3ad13f84f1409ea648f5328f0bada5bd76' \
    --output "$archive" \
    --label 'Node.js Mobile for Android'
printf '%s  %s\n' 'e3cd29a1be03405f11dd5c857af8cd3ad13f84f1409ea648f5328f0bada5bd76' "$archive" | sha256sum --check
mkdir -p libnode
unzip -q -o "$archive" -d libnode
