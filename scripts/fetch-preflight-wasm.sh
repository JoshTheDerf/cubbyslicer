#!/usr/bin/env bash
# Stage the preFlight engine (see docs/ENGINE-CONTRACT.md) into public/wasm/preflight/.
#
# Source (first match wins):
#   1. PREFLIGHT_WASM_FORCE_RELEASE=1 -> download from a GitHub release (optional fallback)
#   2. PREFLIGHT_WASM_BUILD=<dir>     -> that build dir (hard requirement)
#   3. ../slicers/preflight-wasm/build-$PREFLIGHT_WASM_VARIANT (default: release)
#   4. otherwise: error (or the release fallback if PREFLIGHT_WASM_ALLOW_RELEASE=1)
#
# Staged:
#   slicer.mjs slicer.wasm schema.json version.json     (from the engine build dir)
#   profiles/orca_system_profiles.json profiles/_index.json
#
# Build the engine first:  (cd ../slicers/preflight-wasm && bash scripts/build-wasm.sh)
#
# Env knobs:
#   PREFLIGHT_WASM_BUILD          explicit build dir
#   PREFLIGHT_WASM_VARIANT        release|debug (default release) for the sibling build dir
#   PREFLIGHT_PROFILES_SRC        profile source dir (default ../slicers/preflight/resources/profiles)
#   PREFLIGHT_WASM_FORCE_RELEASE=1 / PREFLIGHT_WASM_ALLOW_RELEASE=1
#   PREFLIGHT_WASM_VERSION        release tag (default v1.3.0-cs1)
#   PREFLIGHT_WASM_REPO           owner/name (default JoshTheDerf/preFlight-wasm)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/public/wasm/preflight"
PROFILES_DEST="$DEST/profiles"
VARIANT="${PREFLIGHT_WASM_VARIANT:-release}"
SIBLING="$REPO_ROOT/../slicers/preflight-wasm/build-$VARIANT"
PROFILES_SRC="${PREFLIGHT_PROFILES_SRC:-$REPO_ROOT/../slicers/preflight/resources/profiles}"
VERSION="${PREFLIGHT_WASM_VERSION:-v1.3.0-cs1}"
REPO="${PREFLIGHT_WASM_REPO:-JoshTheDerf/preFlight-wasm}"

ASSETS=(slicer.mjs slicer.wasm schema.json version.json)
PROFILES=(orca_system_profiles.json)

mkdir -p "$DEST" "$PROFILES_DEST"
# Artifacts of the old (pre-contract) port.
rm -f "$DEST/slicer.js" "$DEST/slicer.data"

copy_from() {
    local src="$1"
    for a in "${ASSETS[@]}"; do
        [[ -f "$src/$a" ]] || { echo "error: missing $src/$a (run scripts/build-wasm.sh in preflight-wasm)" >&2; exit 1; }
        echo "-> $a  (from $src)"
        cp -f "$src/$a" "$DEST/$a"
    done
}

download_release() {
    local base="https://github.com/$REPO/releases/download/$VERSION"
    echo "Downloading preflight-wasm $VERSION from $REPO"
    for a in "${ASSETS[@]}" "${PROFILES[@]}"; do
        local out="$DEST/$a"
        [[ " ${PROFILES[*]} " == *" $a "* ]] && out="$PROFILES_DEST/$a"
        echo "-> $a"
        curl --fail --location --retry 3 --connect-timeout 20 --silent --show-error -o "$out" "$base/$a" \
            || { echo "error: failed to download $base/$a" >&2; exit 1; }
    done
}

copy_profiles() {
    for p in "${PROFILES[@]}"; do
        [[ -f "$PROFILES_SRC/$p" ]] || { echo "error: profile $PROFILES_SRC/$p not found" >&2; exit 1; }
        echo "-> profiles/$p  (from $PROFILES_SRC)"
        cp -f "$PROFILES_SRC/$p" "$PROFILES_DEST/$p"
    done
}

write_index() {
    # Every bundle in profiles/ must be listed here (see ENGINE-CONTRACT.md "Profiles").
    local list=""
    for p in "${PROFILES[@]}"; do list+="${list:+,}\"$p\""; done
    printf '{"engine":"preflight","format":"orca-flat","bundles":[%s]}\n' "$list" > "$PROFILES_DEST/_index.json"
    echo "-> profiles/_index.json"
}

if [[ "${PREFLIGHT_WASM_FORCE_RELEASE:-0}" == "1" ]]; then
    download_release
elif [[ -n "${PREFLIGHT_WASM_BUILD:-}" ]]; then
    copy_from "$PREFLIGHT_WASM_BUILD"; copy_profiles
elif [[ -f "$SIBLING/slicer.wasm" ]]; then
    copy_from "$SIBLING"; copy_profiles
elif [[ "${PREFLIGHT_WASM_ALLOW_RELEASE:-0}" == "1" ]]; then
    download_release
else
    echo "error: no engine build at $SIBLING." >&2
    echo "  Build it: (cd ../slicers/preflight-wasm && bash scripts/build-wasm.sh)" >&2
    echo "  or set PREFLIGHT_WASM_ALLOW_RELEASE=1 to download release $VERSION." >&2
    exit 1
fi
write_index

echo
echo "Done. Staged at $DEST:"
ls -l "$DEST" "$PROFILES_DEST"
