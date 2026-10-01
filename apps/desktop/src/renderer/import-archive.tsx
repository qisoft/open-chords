import {
  OFFLINE_MEDIA_CACHE_CAPACITY_BYTES,
  OFFLINE_MEDIA_FREE_DISK_RESERVE_BYTES,
} from "@open-chords/contracts";

import type { ArchiveImportMessage } from "./archive-import.ts";

const gibibytes = (bytes: number) => `${String(bytes / 1024 ** 3)} GiB`;

declare namespace ImportArchive {
  export interface Props {
    adoptOfflineMedia: boolean;
    message: ArchiveImportMessage | null;
    onAdoptOfflineMediaChange: (adopt: boolean) => void;
    onImport: () => void;
    pending: boolean;
  }
}

export const ImportArchive = ({
  adoptOfflineMedia,
  message,
  onAdoptOfflineMediaChange,
  onImport,
  pending,
}: ImportArchive.Props) => (
  <div className={"import-archive"}>
    <button
      type={"button"}
      disabled={pending}
      onClick={onImport}
      data-testid={"archives.import.button"}
    >
      Import Project Archive
    </button>
    <label className={"import-archive-option"}>
      <input
        type={"checkbox"}
        checked={adoptOfflineMedia}
        disabled={pending}
        onChange={(event) => onAdoptOfflineMediaChange(event.target.checked)}
        data-testid={"archives.import.adopt-media"}
      />
      Add included media to the Offline Media Cache ({gibibytes(OFFLINE_MEDIA_CACHE_CAPACITY_BYTES)}{" "}
      capacity, {gibibytes(OFFLINE_MEDIA_FREE_DISK_RESERVE_BYTES)} free-disk reserve)
    </label>
    {message?.tone === "alert" ? (
      <p role={"alert"} data-testid={"archives.import.alert"}>
        {message.text}
      </p>
    ) : (
      <output aria-live={"polite"} data-testid={"archives.import.status"}>
        {message?.text ?? ""}
      </output>
    )}
  </div>
);
