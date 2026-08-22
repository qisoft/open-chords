export const APP_ENTRY_URL = "open-chords://app/index.html";

export function parseApplicationUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "open-chords:" &&
      url.host === "app" &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
      ? url
      : null;
  } catch {
    return null;
  }
}
