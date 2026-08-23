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
version="8.1.2"
archive="ffmpeg-${version}.tar.xz"
expected_sha256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
source_url="https://ffmpeg.org/releases/${archive}"
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

configure_arguments=(
  "--prefix=${install_root}"
  --disable-asm
  --disable-autodetect
  --disable-bsfs
  --disable-debug
  --disable-devices
  --disable-doc
  --disable-encoders
  --disable-everything
  --disable-ffplay
  --disable-gpl
  --disable-hwaccels
  --disable-indevs
  --disable-muxers
  --disable-network
  --disable-nonfree
  --disable-outdevs
  --disable-programs
  --disable-protocols
  --disable-shared
  --disable-version3
  --enable-decoder=aac,alac,flac,mp3,opus,pcm_f32le,pcm_f64le,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32le,vorbis
  --enable-demuxer=flac,matroska,mov,mp3,ogg,wav
  --enable-encoder=pcm_s16le
  --enable-ffmpeg
  --enable-ffprobe
  --enable-filter=aformat,aresample,pan
  --enable-muxer=wav
  --enable-parser=aac,aac_latm,flac,mpegaudio,opus,vorbis
  --enable-protocol=file,pipe
  --enable-static
)

pushd "${build_root}" >/dev/null
"${source_root}/ffmpeg-${version}/configure" "${configure_arguments[@]}"
make -j2
make install
popd >/dev/null

mkdir -p "${install_root}/licenses"
cp "${source_root}/ffmpeg-${version}/COPYING.LGPLv2.1" "${install_root}/licenses/FFmpeg-LGPL-2.1.txt"
"${install_root}/bin/ffmpeg" -version | sed -n '1,4p' > "${install_root}/ffmpeg-version.txt"
