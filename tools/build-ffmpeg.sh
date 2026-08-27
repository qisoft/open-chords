#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: build-ffmpeg.sh <platform-profile> <output-root>" >&2
  exit 2
fi

platform_profile="$1"
output_root="$2"
mkdir -p "${output_root}"
output_root="$(cd "${output_root}" && pwd)"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_manifest="${repository_root}/sidecar/native/ffmpeg-build.json"
manifest_reader="${repository_root}/tools/read-ffmpeg-build-manifest.sh"
version="$(bash "${manifest_reader}" scalar "${build_manifest}" version)"
archive="$(bash "${manifest_reader}" scalar "${build_manifest}" sourceArchive)"
expected_sha256="$(bash "${manifest_reader}" scalar "${build_manifest}" sourceSha256)"
source_url="$(bash "${manifest_reader}" scalar "${build_manifest}" sourceUrl)"
download_root="${output_root}/downloads"
source_root="${output_root}/source"
build_root="${output_root}/build/${platform_profile}-reviewed-v1"
install_root="${output_root}/${platform_profile}"

mkdir -p "${download_root}" "${source_root}" "${build_root}" "${install_root}"
if [[ ! -f "${download_root}/${archive}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 "${source_url}" --output "${download_root}/${archive}"
fi
actual_sha256="$(shasum -a 256 "${download_root}/${archive}" | awk '{print $1}')"
if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
  echo "FFmpeg source archive SHA-256 mismatch" >&2
  exit 1
fi

if [[ ! -f "${source_root}/ffmpeg-${version}/configure" ]]; then
  tar -xf "${download_root}/${archive}" -C "${source_root}"
fi

configure_arguments=("--prefix=${install_root}")
configure_arguments_output="$(
  bash "${manifest_reader}" array "${build_manifest}" configureArguments
)"
while IFS= read -r argument; do
  configure_arguments+=("${argument}")
done <<< "${configure_arguments_output}"
if [[ "${platform_profile}" == "windows-server-2025-x64" ]]; then
  windows_arguments_output="$(
    bash "${manifest_reader}" array "${build_manifest}" windowsConfigureArguments
  )"
  while IFS= read -r argument; do
    configure_arguments+=("${argument}")
  done <<< "${windows_arguments_output}"
fi

pushd "${build_root}" >/dev/null
"${source_root}/ffmpeg-${version}/configure" "${configure_arguments[@]}"
make -j2
make install
popd >/dev/null

"${install_root}/bin/ffmpeg" -version | sed -n '1,4p' > "${install_root}/ffmpeg-version.txt"

if [[ "${platform_profile}" == "windows-server-2025-x64" ]]; then
  python_command=""
  if command -v python3 >/dev/null 2>&1; then
    python_command="python3"
  elif command -v python >/dev/null 2>&1; then
    python_command="python"
  else
    echo "Python is required to mark Windows helpers as AppContainer compatible" >&2
    exit 1
  fi
  runtime_dlls_output="$(
    bash "${manifest_reader}" array "${build_manifest}" windowsRuntimeDlls
  )"
  appcontainer_pe_files=(
    "${install_root}/bin/ffmpeg.exe"
    "${install_root}/bin/ffprobe.exe"
  )
  while IFS= read -r runtime_dll; do
    runtime_source="/ucrt64/bin/${runtime_dll}"
    if [[ ! -f "${runtime_source}" ]]; then
      echo "reviewed Windows runtime DLL is unavailable: ${runtime_dll}" >&2
      exit 1
    fi
    cp "${runtime_source}" "${install_root}/bin/${runtime_dll}"
    appcontainer_pe_files+=("${install_root}/bin/${runtime_dll}")
  done <<< "${runtime_dlls_output}"
  "${python_command}" "${repository_root}/tools/mark-pe-appcontainer.py" \
    "${appcontainer_pe_files[@]}"

  runtime_files_json='[]'
  while IFS= read -r runtime_dll; do
    runtime_sha256="$(shasum -a 256 "${install_root}/bin/${runtime_dll}" | awk '{print $1}')"
    runtime_files_json="$(
      jq -c \
        --arg file "${runtime_dll}" \
        --arg sha256 "${runtime_sha256}" \
        '. + [{file: $file, sha256: $sha256}]' \
        <<< "${runtime_files_json}"
    )"
  done <<< "${runtime_dlls_output}"

  runtime_package="$(
    bash "${manifest_reader}" scalar "${build_manifest}" windowsRuntimePackage
  )"
  runtime_package_url="$(
    bash "${manifest_reader}" scalar "${build_manifest}" windowsRuntimePackageUrl
  )"
  read -r observed_package observed_version <<< "$(pacman -Q "${runtime_package}")"
  if [[ "${observed_package}" != "${runtime_package}" || -z "${observed_version}" ]]; then
    echo "unable to identify reviewed Windows runtime package" >&2
    exit 1
  fi
  runtime_license="/ucrt64/share/licenses/libwinpthread/COPYING"
  if [[ ! -f "${runtime_license}" ]]; then
    echo "winpthreads license notice is unavailable" >&2
    exit 1
  fi
  mkdir -p "${install_root}/licenses"
  cp "${runtime_license}" "${install_root}/licenses/Winpthreads-Licenses.txt"
  jq -n \
    --arg package "${observed_package}" \
    --arg packageUrl "${runtime_package_url}" \
    --arg version "${observed_version}" \
    --argjson nativeFiles "${runtime_files_json}" \
    '{schemaVersion: 1, package: {name: $package, url: $packageUrl, version: $version}, nativeFiles: $nativeFiles}' \
    > "${install_root}/windows-runtime.json"
  bash "${repository_root}/tools/verify-windows-ffmpeg-runtime.sh" \
    "${install_root}/bin" \
    "${build_manifest}"
fi

mkdir -p "${install_root}/licenses"
cp "${source_root}/ffmpeg-${version}/COPYING.LGPLv2.1" "${install_root}/licenses/FFmpeg-LGPL-2.1.txt"
