export const PACKAGED_ARCHIVE_PROOF_ARGUMENT = "--open-chords-archive-proof";

export const ARCHIVE_PROOF_CASES = [
  ["traversal", "unsafe_path"],
  ["link", "link_entry"],
  ["collision", "name_collision"],
  ["executable", "active_content"],
  ["hash", "hash_mismatch"],
  ["future", "unsupported_version"],
  ["size", "size_limit"],
  ["encrypted", "encrypted_entry"],
] as const;
