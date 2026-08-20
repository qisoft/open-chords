import type { OpenChordsDesktopApi } from "@open-chords/contracts";

declare global {
  interface Window {
    readonly openChords: OpenChordsDesktopApi;
  }
}

export {};
