import { expect, it } from "vitest";

import { rendererShutdownCollector } from "./support/renderer-shutdown-probe.ts";

it("reassembles split fixed events and never prints private process output", () => {
  const output: string[] = [];
  const collect = rendererShutdownCollector((line) => output.push(line));
  collect("/private/path\nYouTube shutdown ev");
  collect("ent: event=before_quit kind=app\r\n");
  collect("YouTube shutdown event: event=private kind=app\n");
  collect("YouTube shutdown event: event=quit kind=/private/window\n");
  collect("YouTube shutdown event: event=quit kind=app /private/path\n");
  collect("/private/unterminated");
  collect("\nYouTube shutdown event: event=process_exit kind=process\n");
  expect(output).toEqual([
    "YouTube shutdown event: event=before_quit kind=app",
    "YouTube shutdown event: event=process_exit kind=process",
  ]);
});

it("discards an oversized line and its apparently valid suffix, then recovers", () => {
  const output: string[] = [];
  const collect = rendererShutdownCollector((line) => output.push(line));
  const line = "YouTube shutdown event: event=quit kind=app";
  collect("x".repeat(4097));
  collect(line + "\n" + line + "\n");
  expect(output).toEqual([line]);
});

it("bounds retained events even across many chunks", () => {
  const output: string[] = [];
  const collect = rendererShutdownCollector((line) => output.push(line));
  for (let i = 0; i < 50; i++)
    collect("YouTube shutdown event: event=window_closed kind=created\n");
  expect(output).toHaveLength(32);
});
