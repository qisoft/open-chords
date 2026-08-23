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

pushd "${build_root}" >/dev/null
"${source_root}/ffmpeg-${version}/configure" "${configure_arguments[@]}"
make -j2
make install
popd >/dev/null

mkdir -p "${install_root}/licenses"
cp "${source_root}/ffmpeg-${version}/COPYING.LGPLv2.1" "${install_root}/licenses/FFmpeg-LGPL-2.1.txt"
"${install_root}/bin/ffmpeg" -version | sed -n '1,4p' > "${install_root}/ffmpeg-version.txt"
