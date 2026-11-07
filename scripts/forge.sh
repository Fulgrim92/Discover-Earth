#!/usr/bin/env bash
# Fetch the Forge engine crates Discover Earth uses, pinned to the commit in FORGE_REV.
#
# Forge lives in Fulgrim92/cardcraft-eternal (private, read-only from here). That repo is
# about 9 GB at one commit, mostly Equilibrium's art, so Cargo's own git dependency would
# clone all of it. Instead this does a blobless, sparse clone of just the crates listed
# below (a few MB) into vendor/forge, which Cargo.toml uses as path dependencies.
#
# Usage: scripts/forge.sh            fetch or update to FORGE_REV
#        scripts/forge.sh --check    exit 1 if vendor/forge is missing or not at FORGE_REV
# Needs read access to the repo (GitHub login, or a token in CI; see docs/forge.md).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rev="$(tr -d '[:space:]' < "$root/FORGE_REV")"
dir="$root/vendor/forge"
url="${FORGE_URL:-https://github.com/Fulgrim92/cardcraft-eternal}"
# The Forge crates we build on. Add one here when a crate starts using it.
crates=(forge_core)

have="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
if [[ "${1:-}" == "--check" ]]; then
  [[ "$have" == "$rev" ]] && exit 0
  echo "vendor/forge is at '${have:-missing}', FORGE_REV is $rev: run scripts/forge.sh" >&2
  exit 1
fi

if [[ ! -d "$dir/.git" ]]; then
  mkdir -p "$root/vendor"
  git clone -q --filter=blob:none --no-checkout --sparse "$url" "$dir"
fi
paths=(/Cargo.toml /Cargo.lock /rustfmt.toml)
for c in "${crates[@]}"; do paths+=("/crates/$c/"); done
git -C "$dir" sparse-checkout set --no-cone "${paths[@]}"
if ! git -C "$dir" cat-file -e "$rev^{commit}" 2>/dev/null; then
  git -C "$dir" fetch -q --filter=blob:none origin "$rev"
fi
git -C "$dir" -c advice.detachedHead=false checkout -q "$rev"
echo "forge at $rev (${crates[*]})"
