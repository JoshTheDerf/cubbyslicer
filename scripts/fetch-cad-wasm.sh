#!/usr/bin/env bash
# Stage the Design-tab CAD kernel module into public/wasm/cad/ (not committed).
#
# Source (first match wins):
#   $CAD_WASM_BUILD                             explicit build dir
#   ../slicers/orcaslicer-wasm/build-cad        (local build; that repo's scripts/build-cad.sh)
#
# Staged (contract: docs/CAD-KERNEL-CONTRACT.md):
#   cad.mjs cad.wasm     OrcaSlicer 2.5 libslic3r/CAD on OpenCASCADE 8.0.1 (lazy-loaded; never
#                        needed by Prepare/Preview)
#   version.json         cad_version()
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="$REPO_ROOT/../slicers/orcaslicer-wasm"
BUILD="${CAD_WASM_BUILD:-$PORT/build-cad}"
DEST="$REPO_ROOT/public/wasm/cad"

for f in cad.mjs cad.wasm version.json; do
  [[ -f "$BUILD/$f" ]] || { echo "error: $BUILD/$f missing (bash $PORT/scripts/build-cad.sh)" >&2; exit 1; }
done

python3 - "$BUILD/version.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
if v.get("module") != "orca-cad" or v.get("abi") != 1:
    sys.exit(f"error: {sys.argv[1]} is not an orca-cad ABI 1 module: {v}")
PY

mkdir -p "$DEST"
# Atomic per file (copy beside, then rename): a page loading the kernel meanwhile never reads a
# half-written file. The wasm goes first, the glue and version last.
for f in cad.wasm cad.mjs version.json; do cp -f "$BUILD/$f" "$DEST/.$f.staging"; done
for f in cad.wasm cad.mjs version.json; do mv -f "$DEST/.$f.staging" "$DEST/$f"; done
echo "Staged $(python3 -c "import json;v=json.load(open('$DEST/version.json'));print(v['module'], 'orca', v['orca'], 'occt', v['occt'])") into $DEST"
node -e '
const fs = require("fs"), z = require("zlib");
const b = fs.readFileSync(process.argv[1]);
const gz = z.gzipSync(b, { level: 9 }).length;
const br = z.brotliCompressSync(b, { params: { [z.constants.BROTLI_PARAM_QUALITY]: 11, [z.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;
console.log(`  cad.wasm ${b.length} B (gzip -9 ${gz} B, brotli 11 ${br} B), cad.mjs ${fs.statSync(process.argv[2]).size} B`);
' "$DEST/cad.wasm" "$DEST/cad.mjs"
