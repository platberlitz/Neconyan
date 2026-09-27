#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl --fail --location --show-error 'https://github.com/fogtape/nodejs-mobile/releases/download/v24.21.0-0/nodejs-mobile-android-24.21.0-0.zip' --output "$archive"
printf '%s  %s\n' 'e3cd29a1be03405f11dd5c857af8cd3ad13f84f1409ea648f5328f0bada5bd76' "$archive" | sha256sum --check
mkdir -p libnode
unzip -q -o "$archive" -d libnode
