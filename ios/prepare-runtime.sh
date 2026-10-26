#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
version=24.22.1-0
checksum=3fa1b8fb0720768b01c2e0dae3a17e788476e8c1613a1d9a54e206793b45326e
mkdir -p vendor
archive="vendor/nodejs-mobile-ios-$version.zip"
if ! test -f "$archive"; then
    curl --fail --location --retry 3 "https://github.com/fogtape/nodejs-mobile/releases/download/v$version/nodejs-mobile-ios-$version.zip" -o "$archive"
fi
actual=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
test "$actual" = "$checksum" || { echo 'Node runtime checksum mismatch' >&2; exit 1; }
unzip -oq "$archive" 'NodeMobile.xcframework/*' -d vendor
