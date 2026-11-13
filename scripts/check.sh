#!/usr/bin/env bash
# The one check: run it after every change. Each step logs to out/check/<step>.log and
# out/check/summary.json says which step failed, so a failure can be read from files.
#
#   scripts/check.sh                 fmt, clippy, tests, content validation
#   scripts/check.sh --shots         also capture content/shots/smoke.json into out/shots
#   scripts/check.sh --shots --ref <dir>
#                                    and compare every shot with <dir>/<name>.png (FLIP; heatmaps
#                                    and before|after sheets in out/compare/)
# --shots also writes a sensor pack per shot; read out/shots/sense.md first.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
shots=0
ref=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --shots) shots=1 ;;
    --ref) ref="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
log="$root/out/check"
rm -rf "$log" && mkdir -p "$log"
results=()
failed=""

step() {
  local name="$1"; shift
  printf '%-10s ' "$name"
  if "$@" > "$log/$name.log" 2>&1; then
    echo ok; results+=("\"$name\":\"ok\"")
  else
    echo "FAILED (out/check/$name.log)"; results+=("\"$name\":\"failed\"")
    [[ -z "$failed" ]] && failed="$name"
  fi
}

compare() {
  # Perceptual compare (NVIDIA FLIP), so it holds across GPUs and drivers. Heatmaps and
  # before|after sheets for every shot go to out/compare/; changed shots fail this step.
  cargo run -q -p de_cli -- compare "$ref" "$root/out/shots" --out "$root/out/compare"
}

step fmt     cargo fmt --check
step clippy  cargo clippy --workspace --all-targets -- -D warnings
step test    cargo test --workspace
step content cargo run -q -p de_cli -- validate
if [[ $shots == 1 ]]; then
  rm -rf "$root/out/shots"
  step shots cargo run -q -p de_client --bin de-shot -- content/shots/smoke.json out/shots
  # A shader that fails to compile only logs an error and draws nothing, so the capture still
  # "passes". Fail on it here.
  step shaders bash -c "! grep -E 'failed to create shader module|Shader .* parsing error' '$log/shots.log'"
  [[ -n "$ref" ]] && step diff compare
fi

printf '{"ok":%s,"first_failure":%s,"steps":{%s}}\n' \
  "$([[ -z "$failed" ]] && echo true || echo false)" \
  "$([[ -z "$failed" ]] && echo null || echo "\"$failed\"")" \
  "$(IFS=,; echo "${results[*]}")" > "$log/summary.json"
[[ -z "$failed" ]]
