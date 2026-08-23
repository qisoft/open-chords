#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verifier="${repository_root}/tools/verify-windows-ffmpeg-runtime.sh"
fixture_root="$(mktemp -d)"
trap 'rm -rf "${fixture_root}"' EXIT

mkdir -p "${fixture_root}/bin" "${fixture_root}/runtime" "${fixture_root}/tools"
touch "${fixture_root}/bin/ffmpeg.exe" "${fixture_root}/bin/ffprobe.exe"
printf '%s\n' '{"windowsSystemDlls":["KERNEL32.dll","USER32.dll"]}' > "${fixture_root}/manifest.json"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'case "${FAKE_OBJDUMP_RESULT}" in' \
  '  system) printf "%s\n" "DLL Name: KERNEL32.dll" "DLL Name: USER32.dll" ;;' \
  '  mingw) printf "%s\n" "DLL Name: KERNEL32.dll" "DLL Name: libwinpthread-1.dll" ;;' \
  '  unknown) printf "%s\n" "DLL Name: unexpected-runtime.dll" ;;' \
  '  multiple) printf "%s\n" "DLL Name: libwinpthread-1.dll" "DLL Name: unexpected-runtime.dll" ;;' \
  '  malformed) printf "%s\n" "DLL Name: ../runtime.dll" ;;' \
  '  empty) ;;' \
  '  failure) exit 1 ;;' \
  'esac' > "${fixture_root}/tools/objdump"
chmod +x "${fixture_root}/tools/objdump"

run_verifier() {
  PATH="${fixture_root}/tools:${PATH}" \
    OPEN_CHORDS_MINGW_RUNTIME_SEARCH_PATH="${fixture_root}/runtime" \
    FAKE_OBJDUMP_RESULT="$1" \
    bash "${verifier}" "${fixture_root}/bin" "${fixture_root}/manifest.json"
}

run_verifier system

touch "${fixture_root}/runtime/libwinpthread-1.dll"
for rejected_result in mingw unknown malformed empty failure; do
  if run_verifier "${rejected_result}" >/dev/null 2>&1; then
    echo "expected PE import verification to reject ${rejected_result}" >&2
    exit 1
  fi
done

multiple_errors="$(run_verifier multiple 2>&1 || true)"
[[ "${multiple_errors}" == *"external MinGW runtime dependency: libwinpthread-1.dll"* ]]
[[ "${multiple_errors}" == *"unreviewed Windows DLL: unexpected-runtime.dll"* ]]

rm "${fixture_root}/bin/ffprobe.exe"
if run_verifier system >/dev/null 2>&1; then
  echo "expected a missing FFprobe binary to be rejected" >&2
  exit 1
fi
