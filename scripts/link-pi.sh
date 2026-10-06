#!/usr/bin/env bash
# Dev only: expose the installed Pi's own packages to tsc and the Pi unit tests under .host/node_modules.
# Pi never reads .host; when it loads the extension it supplies these modules itself.
set -euo pipefail
cd "$(dirname "$0")/.."
cli=$(realpath "$(command -v pi)")
# Managed installs put a shell launcher in <agent-dir>/bin, not a symlink to the JS CLI.
version_file="$(dirname "$(dirname "$cli")")/install/current-version"
if [[ -f "$version_file" ]]; then
  IFS= read -r version < "$version_file"
  case "$version" in
    ""|.|..|*[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._+-]*)
      echo "Invalid managed Pi version in $version_file" >&2; exit 1 ;;
  esac
  release_cli="${version_file%/*}/releases/$version/node_modules/.bin/pi"
  [[ -x "$release_cli" ]] || { echo "Managed Pi executable is missing: $release_cli" >&2; exit 1; }
  cli=$(realpath "$release_cli")
fi

# Resolve from Pi itself: dependencies may be nested (npm global) or hoisted (managed).
# Resolve and validate everything before replacing the existing dev links.
node --input-type=commonjs - "$cli" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const { createRequire } = require("node:module")

function packageRoot(entry, name) {
  let dir = path.dirname(entry)
  while (true) {
    const manifest = path.join(dir, "package.json")
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`Package ${name} not found from ${entry}`)
    dir = parent
  }
}

const cli = process.argv[2]
const hostRequire = createRequire(cli)
const piRoot = packageRoot(cli, "@earendil-works/pi-coding-agent")
const links = [
  ["@earendil-works/pi-coding-agent", piRoot],
  ...["@earendil-works/pi-tui", "typebox"].map(name => [name, packageRoot(hostRequire.resolve(name), name)]),
]
const version = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8")).version
fs.rmSync(".host", { recursive: true, force: true })
fs.mkdirSync(".host/node_modules/@earendil-works", { recursive: true })
for (const [name, root] of links) fs.symlinkSync(root, `.host/node_modules/${name}`)
console.log(`linked Pi ${version} from ${piRoot}`)
NODE
