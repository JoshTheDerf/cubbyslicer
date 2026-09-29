#!/usr/bin/env bash
# Stage the FullSpectrum engine (ratdoux/OrcaSlicer-FullSpectrum, Snapmaker
# Orca + mixed filaments) into public/wasm/fullspectrum/.
#
# Built by ../slicers/orcaslicer-wasm with the fork checked out at
# ../slicers/orcaslicer-wasm/fullspectrum:
#   emcmake cmake -S wasm -B build-fs -G Ninja -DCMAKE_BUILD_TYPE=Release \
#     -DORCA_SRC_DIR=$PWD/fullspectrum -DCS_ENGINE_ID=fullspectrum
#   cmake --build build-fs --target slicer && node scripts/gen-schema.mjs build-fs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="$REPO_ROOT/../slicers/orcaslicer-wasm"
BUILD="${FS_WASM_BUILD:-$PORT/build-fs}"
PROFILES_SRC="${FS_PROFILES_SRC:-$PORT/fullspectrum/resources/profiles}"
DEST="$REPO_ROOT/public/wasm/fullspectrum"

for f in slicer.mjs slicer.wasm schema.json version.json; do
  [[ -f "$BUILD/$f" ]] || { echo "error: $BUILD/$f missing (build the engine + run gen-schema.mjs)" >&2; exit 1; }
done
mkdir -p "$DEST"
for f in slicer.mjs slicer.wasm schema.json version.json; do cp -f "$BUILD/$f" "$DEST/$f"; done
if [[ -f "$BUILD/slicer.data" ]]; then cp -f "$BUILD/slicer.data" "$DEST/"; else rm -f "$DEST/slicer.data"; fi

if [[ "${FS_SKIP_PROFILES:-0}" != "1" ]]; then
  [[ -d "$PROFILES_SRC" ]] || { echo "error: profiles missing at $PROFILES_SRC" >&2; exit 1; }
  rm -rf "$DEST/profiles"
  mkdir -p "$DEST/profiles"
  cp -R "$PROFILES_SRC/." "$DEST/profiles/"
  find "$DEST/profiles" -maxdepth 1 -type f ! -name '*.json' -delete
  python3 - "$DEST/profiles" <<'PY'
import json, os, sys
dest = sys.argv[1]
ids = sorted(n[:-5] for n in os.listdir(dest)
             if n.endswith('.json') and n != '_index.json' and os.path.isdir(os.path.join(dest, n[:-5])))
json.dump(ids, open(os.path.join(dest, '_index.json'), 'w'))
print(f'profiles: {len(ids)} vendors')
PY
  node "$REPO_ROOT/scripts/dev/build-profile-bundles.mjs" "$DEST/profiles"
fi
echo "Staged $(python3 -c "import json;print(json.load(open('$DEST/version.json'))['version'])") into $DEST"
