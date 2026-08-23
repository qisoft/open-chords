#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: read-ffmpeg-build-manifest.sh <scalar|array> <manifest> <key> [python3|python|jq]" >&2
  exit 2
fi

mode="$1"
manifest="$2"
key="$3"
reader="${4:-}"

if [[ -z "${reader}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    reader="python3"
  elif command -v python >/dev/null 2>&1; then
    reader="python"
  elif command -v jq >/dev/null 2>&1; then
    reader="jq"
  else
    echo "Python or jq is required to read the reviewed FFmpeg build manifest" >&2
    exit 1
  fi
fi

case "${reader}" in
  python3 | python)
    if [[ "${mode}" == "scalar" ]]; then
      "${reader}" -c '
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    value = json.load(manifest_file)[sys.argv[2]]
if (
    not isinstance(value, str)
    or not value
    or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in value)
):
    raise ValueError("manifest value must be a non-empty string without control characters")
print(value)
' "${manifest}" "${key}"
    elif [[ "${mode}" == "array" ]]; then
      "${reader}" -c '
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    value = json.load(manifest_file)[sys.argv[2]]
if (
    not isinstance(value, list)
    or not value
    or any(
        not isinstance(item, str)
        or not item
        or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in item)
        for item in value
    )
):
    raise ValueError(
        "manifest value must be a non-empty array of non-empty strings without control characters"
    )
print("\n".join(value))
' "${manifest}" "${key}"
    else
      echo "unsupported manifest value mode: ${mode}" >&2
      exit 2
    fi
    ;;
  jq)
    if [[ "${mode}" == "scalar" ]]; then
      jq -er --arg key "${key}" '
        .[$key] as $value
        | if (($value | type) != "string"
            or ($value | length) == 0
            or ($value | explode | any(. < 32 or (. >= 127 and . <= 159))))
          then error("manifest value must be a non-empty string without control characters")
          else $value
          end
      ' "${manifest}"
    elif [[ "${mode}" == "array" ]]; then
      jq -er --arg key "${key}" '
        .[$key] as $value
        | if (($value | type) != "array"
            or ($value | length) == 0
            or any(
              $value[];
              (type != "string")
              or (length == 0)
              or (explode | any(. < 32 or (. >= 127 and . <= 159)))
            ))
          then error("manifest value must be a non-empty array of non-empty strings without control characters")
          else $value[]
          end
      ' "${manifest}"
    else
      echo "unsupported manifest value mode: ${mode}" >&2
      exit 2
    fi
    ;;
  *)
    echo "unsupported manifest reader: ${reader}" >&2
    exit 2
    ;;
esac
