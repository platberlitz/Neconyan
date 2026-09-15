#!/usr/bin/env bash
# Force Neconyan to use Node.js instead of Bun.
# Use this if Bun causes high CPU usage on your platform.
unset NECONYAN_USE_BUN SILLYBUNNY_USE_BUN
export NECONYAN_USE_NODE=1
export SILLYBUNNY_USE_NODE=1
export NECONYAN_TERMUX_RUNTIME=node
export SILLYBUNNY_TERMUX_RUNTIME=node
exec "$(dirname "${BASH_SOURCE[0]}")/start.sh" "$@"
