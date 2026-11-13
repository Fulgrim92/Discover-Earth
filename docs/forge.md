# Forge as a pinned dependency

Forge lives in `Fulgrim92/cardcraft-eternal` (private). Discover Earth only reads it.

- `FORGE_REV` holds the exact commit we build against.
- `scripts/forge.sh` makes a blobless, sparse clone of just the crates we use (listed in the script) into
  `vendor/forge` (git-ignored) and checks out that commit. A few MB, where a Cargo git dependency would clone the whole
  repo (about 9 GB at one commit, mostly Equilibrium's art).
- `Cargo.toml` points at those crates by path; our Bevy is pinned to the same `=0.20.0` as Forge's ECS.
- `scripts/forge.sh --check` (part of `scripts/check.sh`) fails if `vendor/forge` is not at `FORGE_REV`.

To move to a newer Forge: change `FORGE_REV`, run `scripts/forge.sh` and `scripts/check.sh --shots`, and open a PR
for just that. To use another Forge crate, add it to `crates=(...)` in the script and to `[workspace.dependencies]`.

When Forge gets its own repository, point `FORGE_URL` (or the default in the script) at it; nothing else changes.

## CI

The workflow fetches Forge with a token, because the repository is private: add a fine-grained personal access token
with read access to `cardcraft-eternal` (Contents: read) as the secret `FORGE_TOKEN` in this repo's settings.
