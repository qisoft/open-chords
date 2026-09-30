import type {
  ArchiveImportRejection,
  ArchiveImportResponse,
  OpenChordsDesktopApi,
} from "@open-chords/contracts";
import { useRef, useState } from "react";

export type ArchiveImportMessage = { text: string; tone: "alert" | "status" };

const rejectionLabels: Record<ArchiveImportRejection, string> = {
  active_content: "it contains executable or script content",
  compression_ratio: "an entry expands far beyond its compressed size",
  declaration_mismatch: "its contents do not match the manifest declarations",
  encrypted_entry: "it contains encrypted entries",
  hash_mismatch: "a file does not match its recorded hash",
  identity_exhausted: "too many Projects already use its identity",
  invariant_invalid: "the Project history is internally inconsistent",
  link_entry: "it contains links or special files",
  malformed_zip: "it is not a well-formed Open Chords archive",
  missing_entry: "a required file is missing",
  name_collision: "two entries have colliding names",
  reference_invalid: "it references records that do not exist",
  schema_invalid: "its Project data is not valid",
  size_limit: "it exceeds the archive size limits",
  source_conflict: "it redefines a Source already in this Library",
  undeclared_entry: "it contains files its manifest does not declare",
  unreadable_archive: "the selected file could not be read as a regular file",
  unsafe_path: "it contains unsafe file paths",
  unsupported_version: "it was written by a newer or unsupported version",
  unsupported_zip_feature: "it uses ZIP features Open Chords does not accept",
};

export function archiveImportMessage(
  result: ArchiveImportResponse["result"],
): ArchiveImportMessage {
  if (result.state === "cancelled") return { text: "Import cancelled", tone: "status" };
  if (result.state === "rejected")
    return {
      text: `Archive rejected because ${rejectionLabels[result.reason]}. Nothing was imported.`,
      tone: "alert",
    };
  const media =
    result.offlineMedia === "cached"
      ? " Its Project Range media is available in the Offline Media Cache."
      : "";
  if (result.state === "already_present")
    return {
      text: `This Library already contains this exact Project history.${media}`,
      tone: "status",
    };
  return {
    text: result.importedCopy
      ? `Imported as a separate Project copy because this Library already has a different history with the same identity.${media}`
      : `Project imported.${media}`,
    tone: "status",
  };
}

export function useArchiveImport(
  api: OpenChordsDesktopApi | undefined,
  openProject: (projectId: string) => Promise<unknown>,
) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<ArchiveImportMessage | null>(null);
  const running = useRef(false);
  const run = async () => {
    if (api === undefined || running.current) return;
    running.current = true;
    setPending(true);
    setMessage({ text: "Choose a Portable Project Archive…", tone: "status" });
    try {
      const response = await api.archives.import();
      if (response.type === "desktop.error") {
        setMessage({ text: response.message, tone: "alert" });
        return;
      }
      setMessage(archiveImportMessage(response.result));
      if ("projectId" in response.result) await openProject(response.result.projectId);
    } catch {
      setMessage({ text: "Archive import unavailable. Try again.", tone: "alert" });
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return { message, pending, run };
}
