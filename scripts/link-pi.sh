#!/usr/bin/env bash
# Dev only: expose the installed Pi's own packages to tsc and the Pi unit tests under .host/node_modules.
# Pi never reads .host; when it loads the extension it supplies these modules itself.
set -euo pipefail
cd "$(dirname "$0")/.."
cli=$(realpath "$(command -v pi)")
pi_root=${cli%%/dist/*}
[[ -f "$pi_root/package.json" ]] || { echo "Pi's package not found from $cli" >&2; exit 1; }
rm -rf .host
mkdir -p .host/node_modules/@earendil-works
ln -s "$pi_root" .host/node_modules/@earendil-works/pi-coding-agent
ln -s "$pi_root/node_modules/@earendil-works/pi-tui" .host/node_modules/@earendil-works/pi-tui
ln -s "$pi_root/node_modules/typebox" .host/node_modules/typebox
echo "linked Pi $(node -p "require('$pi_root/package.json').version") from $pi_root"
