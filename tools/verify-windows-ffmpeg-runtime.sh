#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: verify-windows-ffmpeg-runtime.sh <binary-directory>" >&2
  exit 2
fi

binary_directory="$1"
runtime_search_path="${OPEN_CHORDS_MINGW_RUNTIME_SEARCH_PATH:-/ucrt64/bin:/usr/bin}"
IFS=':' read -r -a runtime_search_roots <<< "${runtime_search_path}"
if [[ ${#runtime_search_roots[@]} -eq 0 ]]; then
  echo "MinGW runtime search path must not be empty" >&2
  exit 2
fi

for tool in ffmpeg.exe ffprobe.exe; do
  binary="${binary_directory}/${tool}"
  if [[ ! -f "${binary}" ]]; then
    echo "missing Windows FFmpeg binary: ${tool}" >&2
    exit 1
  fi
  if ! pe_headers="$(objdump -p "${binary}")"; then
    echo "unable to inspect PE imports for ${tool}" >&2
    exit 1
  fi
  dependencies=()
  while IFS= read -r dependency; do
    [[ -n "${dependency}" ]] && dependencies+=("${dependency}")
  done <<< "$(sed -n 's/^[[:space:]]*DLL Name: //p' <<< "${pe_headers}")"
  if [[ ${#dependencies[@]} -eq 0 ]]; then
    echo "${tool} has no inspectable PE imports" >&2
    exit 1
  fi
  for dependency in "${dependencies[@]}"; do
    if [[ ! "${dependency}" =~ ^[A-Za-z0-9._-]+\.[Dd][Ll][Ll]$ ]]; then
      echo "${tool} has an invalid PE import name" >&2
      exit 1
    fi
    mingw_dependency="$(
      find "${runtime_search_roots[@]}" -maxdepth 1 -type f -iname "${dependency}" -print -quit 2>/dev/null
    )"
    if [[ -n "${mingw_dependency}" ]]; then
      echo "${tool} retains an external MinGW runtime dependency: ${dependency}" >&2
      exit 1
    fi
  done
done
