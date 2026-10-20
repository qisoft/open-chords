export function parseWindowsVolumeMeasurement(stdout: string) {
  const invalid = () => new Error("Windows volume measurement evidence invalid");
  if (stdout.length > 128) throw invalid();
  const match = /^([0-6])\|(\d{1,6})\|(\d{1,6})\|(\d{1,6})$/.exec(stdout.trim());
  if (!match) throw invalid();
  const [, driveType, importText, queryText, scriptText] = match;
  const importMs = Number(importText);
  const queryMs = Number(queryText);
  const scriptMs = Number(scriptText);
  if (scriptMs > 100000 || importMs + queryMs > scriptMs) throw invalid();
  return { driveType, importMs, queryMs, scriptMs };
}
