#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: test-ffmpeg-build-manifest-reader.sh <python3|python|jq>" >&2
  exit 2
fi

reader="$1"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest_reader="${repository_root}/tools/read-ffmpeg-build-manifest.sh"
fixture_root="$(mktemp -d)"
trap 'rm -rf "${fixture_root}"' EXIT

assert_array_rejected() {
  local fixture="$1"
  if bash "${manifest_reader}" array "${fixture}" configureArguments "${reader}" >/dev/null 2>&1; then
    echo "expected invalid configureArguments to be rejected: ${fixture}" >&2
    exit 1
  fi
}

assert_scalar_rejected() {
  local fixture="$1"
  if bash "${manifest_reader}" scalar "${fixture}" version "${reader}" >/dev/null 2>&1; then
    echo "expected invalid version to be rejected: ${fixture}" >&2
    exit 1
  fi
}

printf '%s\n' '{"version":"8.1.2","configureArguments":["--disable-network","--disable-doc"]}' > "${fixture_root}/valid.json"
printf '%s\n' '{"version":"8.1.2"}' > "${fixture_root}/missing.json"
printf '%s\n' '{"configureArguments":[]}' > "${fixture_root}/empty.json"
printf '%s\n' '{"configureArguments":["--disable-network",42]}' > "${fixture_root}/non-string.json"
printf '%s\n' '{"configureArguments":["--disable-network",""]}' > "${fixture_root}/empty-string.json"
printf '%s\n' '{"configureArguments":["--disable-network","bad\u0000flag"]}' > "${fixture_root}/nul.json"
printf '%s\n' '{"configureArguments":["--disable-network","bad\rflag"]}' > "${fixture_root}/carriage-return.json"
printf '%s\n' '{"configureArguments":["--disable-network","bad\u0085flag"]}' > "${fixture_root}/c1-control.json"
printf '%s\n' '{"version":"8.1.2\u0000changed"}' > "${fixture_root}/nul-scalar.json"
printf '%s\n' '{"version":"8.1.2\rchanged"}' > "${fixture_root}/carriage-return-scalar.json"
printf '%s\n' '{"version":"8.1.2\u0085changed"}' > "${fixture_root}/c1-control-scalar.json"

scalar="$(bash "${manifest_reader}" scalar "${fixture_root}/valid.json" version "${reader}")"
[[ "${scalar}" == "8.1.2" ]]

array="$(bash "${manifest_reader}" array "${fixture_root}/valid.json" configureArguments "${reader}")"
[[ "${array}" == $'--disable-network\n--disable-doc' ]]

assert_array_rejected "${fixture_root}/missing.json"
assert_array_rejected "${fixture_root}/empty.json"
assert_array_rejected "${fixture_root}/non-string.json"
assert_array_rejected "${fixture_root}/empty-string.json"
assert_array_rejected "${fixture_root}/nul.json"
assert_array_rejected "${fixture_root}/carriage-return.json"
assert_array_rejected "${fixture_root}/c1-control.json"
assert_scalar_rejected "${fixture_root}/nul-scalar.json"
assert_scalar_rejected "${fixture_root}/carriage-return-scalar.json"
assert_scalar_rejected "${fixture_root}/c1-control-scalar.json"
