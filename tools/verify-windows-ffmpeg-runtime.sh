#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: verify-windows-ffmpeg-runtime.sh <binary-directory> <build-manifest>" >&2
  exit 2
fi

binary_directory="$1"
build_manifest="$2"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest_reader="${repository_root}/tools/read-ffmpeg-build-manifest.sh"
runtime_search_path="${OPEN_CHORDS_MINGW_RUNTIME_SEARCH_PATH:-/ucrt64/bin:/usr/bin}"
IFS=':' read -r -a runtime_search_roots <<< "${runtime_search_path}"
if [[ ${#runtime_search_roots[@]} -eq 0 ]]; then
  echo "MinGW runtime search path must not be empty" >&2
  exit 2
fi
allowed_system_dlls=()
allowed_system_dlls_output="$(
  bash "${manifest_reader}" array "${build_manifest}" windowsSystemDlls
)"
while IFS= read -r dependency; do
  if [[ ! "${dependency}" =~ ^[A-Za-z0-9._-]+\.[Dd][Ll][Ll]$ ]]; then
    echo "invalid reviewed Windows system DLL name" >&2
    exit 2
  fi
  allowed_system_dlls+=("${dependency,,}")
done <<< "${allowed_system_dlls_output}"

packaged_runtime_dlls=()
packaged_runtime_dlls_output="$(
  bash "${manifest_reader}" array "${build_manifest}" windowsRuntimeDlls
)"
while IFS= read -r dependency; do
  if [[ ! "${dependency}" =~ ^[A-Za-z0-9._-]+\.[Dd][Ll][Ll]$ ]]; then
    echo "invalid reviewed packaged Windows runtime DLL name" >&2
    exit 2
  fi
  packaged_runtime_dlls+=("${dependency,,}")
done <<< "${packaged_runtime_dlls_output}"

array_contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "${needle}" == "${item}" ]] && return 0
  done
  return 1
}

violations=()
pending_files=(ffmpeg.exe ffprobe.exe)
inspected_files=()
imported_runtime_dlls=()
while [[ ${#pending_files[@]} -ne 0 ]]; do
  tool="${pending_files[0]}"
  pending_files=("${pending_files[@]:1}")
  tool_lower="${tool,,}"
  if array_contains "${tool_lower}" ${inspected_files[@]+"${inspected_files[@]}"}; then
    continue
  fi
  inspected_files+=("${tool_lower}")
  binary="${binary_directory}/${tool}"
  if [[ ! -f "${binary}" ]]; then
    violations+=("missing reviewed Windows FFmpeg runtime file: ${tool}")
    continue
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
    dependency_lower="${dependency,,}"
    if array_contains "${dependency_lower}" ${packaged_runtime_dlls[@]+"${packaged_runtime_dlls[@]}"}; then
      imported_runtime_dlls+=("${dependency_lower}")
      pending_files+=("${dependency}")
      continue
    fi
    mingw_dependency="$(
      find "${runtime_search_roots[@]}" -maxdepth 1 -type f -iname "${dependency}" -print -quit 2>/dev/null
    )"
    if [[ -n "${mingw_dependency}" ]]; then
      violations+=("${tool} retains an external MinGW runtime dependency: ${dependency}")
      continue
    fi
    dependency_is_allowed=false
    for allowed_dependency in "${allowed_system_dlls[@]}"; do
      if [[ "${dependency_lower}" == "${allowed_dependency}" ]]; then
        dependency_is_allowed=true
        break
      fi
    done
    if [[ "${dependency_is_allowed}" != true ]]; then
      violations+=("${tool} imports an unreviewed Windows DLL: ${dependency}")
    fi
  done
done

for dependency in "${packaged_runtime_dlls[@]}"; do
  if ! array_contains "${dependency}" ${imported_runtime_dlls[@]+"${imported_runtime_dlls[@]}"}; then
    violations+=("reviewed packaged Windows runtime DLL is not imported: ${dependency}")
  fi
done

if [[ ${#violations[@]} -ne 0 ]]; then
  printf '%s\n' "${violations[@]}" >&2
  exit 1
fi
