#!/usr/bin/env bash
# Stops the push service in a booted simulator before the UI tests start.
# On the GitHub macOS runner it reconnects to Apple's sandbox push server in a
# loop and logs well over a thousand lines a second, and collecting that log
# takes a large share of the runner's three cores. Neconyan schedules only
# local notifications, which do not go through this service.
set -uo pipefail
device="${1:?usage: quieten-simulator.sh <simulator udid>}"
xcrun simctl spawn "$device" launchctl bootout system/com.apple.apsd 2>&1 || true
xcrun simctl spawn "$device" launchctl disable system/com.apple.apsd 2>&1 || true
if xcrun simctl spawn "$device" launchctl print system/com.apple.apsd 2>&1 | grep -q 'Could not find service'; then
  echo "Stopped the push service in simulator $device"
else
  echo "::warning::The push service is still loaded in simulator $device"
fi
