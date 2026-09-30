import type { ArchiveImportMessage } from "./archive-import.ts";

declare namespace ImportArchive {
  export interface Props {
    message: ArchiveImportMessage | null;
    onImport: () => void;
    pending: boolean;
  }
}

export const ImportArchive = ({ message, onImport, pending }: ImportArchive.Props) => (
  <div className={"import-archive"}>
    <button
      type={"button"}
      disabled={pending}
      onClick={onImport}
      data-testid={"archives.import.button"}
    >
      Import Project Archive
    </button>
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
