#!/bin/sh
# lab:layout geometry tests: bundle layout.test.ts with the project's rolldown and run it on node. No installs.
set -e
here=$(cd "$(dirname "$0")" && pwd)
web=$(cd "$here/../../.." && pwd)
out=$(mktemp -d)
"$web/node_modules/.bin/rolldown" "$here/layout.test.ts" --file "$out/t.mjs" --format esm --platform node >/dev/null
node "$out/t.mjs"
rm -f "$out/t.mjs"; rmdir "$out"
