import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

it("keeps certificate trust and original-host verification across the pinned TCP connection", async () => {
  const fixtures = resolve("tests/fixtures/acquisition-tls");
  let requests = 0;
  const server = createServer(
    {
      key: await readFile(resolve(fixtures, "server-key.pem")),
      cert: await readFile(resolve(fixtures, "server.pem")),
    },
    (_request, response) => {
      requests++;
      response.end("fixture");
    },
  );
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_unavailable");
  try {
    const run = async (url: string, trusted: boolean) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [resolve("tests/helpers/acquisition-tls-client.ts"), String(address.port), url],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: "",
            NODE_EXTRA_CA_CERTS: trusted ? resolve(fixtures, "ca.pem") : "",
          },
          timeout: 15000,
          windowsHide: true,
        },
      );
      return JSON.parse(stdout);
    };
    expect(await run("https://www.youtube.com/watch?v=aqz-KE-bpKQ", true)).toEqual({
      success: true,
      body: "fixture",
    });
    expect(await run("https://www.youtube.com/watch?v=aqz-KE-bpKQ", false)).toEqual({
      success: false,
      code: "network_unavailable",
    });
    expect(
      await run(
        "https://rr1---sn-abcd.googlevideo.com/videoplayback?id=abc123&itag=18&source=youtube&mime=video%2Fmp4",
        true,
      ),
    ).toEqual({ success: false, code: "network_unavailable" });
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}, 20000);
