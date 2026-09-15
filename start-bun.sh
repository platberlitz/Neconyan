#!/usr/bin/env bash
# Force Neconyan to use Bun instead of Node.js.
# Use this when you specifically want Bun behavior on a platform that may prefer Node.js.
unset NECONYAN_USE_NODE SILLYBUNNY_USE_NODE
export NECONYAN_USE_BUN=1
export SILLYBUNNY_USE_BUN=1
export NECONYAN_TERMUX_RUNTIME=bun
export SILLYBUNNY_TERMUX_RUNTIME=bun
exec "$(dirname "${BASH_SOURCE[0]}")/start.sh" "$@"
