#!/usr/bin/env bash
# Fails if a zip bound for the Chrome Web Store carries something that must not ship: the
# manifest `key`, which the store refuses outright, or a developer-only file. A build that
# passes the tests but packs either would be refused by the store or would ship developer
# tools, and nothing else would notice. CI checks the store zip with it, and the beta workflow
# checks the beta zip before sending it.
#
#   bash tools/check-zip.sh openposse-0.3.1.zip
set -euo pipefail

zip="${1:?the path of the zip to check}"

unzip -p "$zip" manifest.json | node -e '
  const manifest = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if ("key" in manifest) {
    console.error("the store manifest carries a key, which the Web Store refuses");
    process.exit(1);
  }'

if unzip -Z1 "$zip" | grep -E '(^|/)(spike\.(js|html)|capture\.js|\.DS_Store)$'; then
  echo "the store zip contains a developer-only file, listed above" >&2
  exit 1
fi

echo "$zip: no key, no developer-only files"
