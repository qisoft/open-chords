import { describe, expect, it } from "vitest";

import { AcquisitionBroker } from "../apps/desktop/src/main/acquisition-broker.ts";

describe("Acquisition Network Broker", () => {
  it("streams an allowed response through a validated pinned address", async () => {
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async ({ url, address, headers }) => {
          if (url.hostname !== "www.youtube.com" || address !== "142.250.74.206")
            throw new Error("Unrecognized external destination");
          if (headers["accept-encoding"] !== "identity") throw new Error("Unexpected compression");
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("abc"));
                controller.enqueue(new TextEncoder().encode("def"));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/html", "content-length": "6" } },
          );
        },
      },
    });
    const response = await broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(await new Response(response.body).text()).toBe("abcdef");
    expect(broker.counters()).toMatchObject({ requests: 1, responseBytes: 6, activeStreams: 0 });
    await broker.close();
  });
  it("rejects every non-global DNS answer and unapproved CNAME before connecting", async () => {
    for (const resolved of [
      { aliases: [], addresses: ["142.250.74.206", "127.0.0.1"] },
      ...[
        "10.1.2.3",
        "169.254.169.254",
        "100.64.0.1",
        "192.168.1.1",
        "198.18.0.1",
        "224.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "fc00::1",
        "fe80::1",
        "2001:db8::1",
        "2002:7f00:1::1",
        "64:ff9b::7f00:1",
        "2607:f8b0:4007:80e::200e%en0",
      ].map((address) => ({ aliases: [], addresses: [address] })),
      { aliases: ["internal.evil.invalid"], addresses: ["142.250.74.206"] },
      ...["bad..google.com", "bad.-label.google.com", `${"x".repeat(64)}.google.com`].map(
        (alias) => ({ aliases: [alias], addresses: ["142.250.74.206"] }),
      ),
    ]) {
      let connected = false;
      const broker = new AcquisitionBroker({
        videoId: "aqz-KE-bpKQ",
        network: {
          resolve: async () => resolved,
          request: async () => {
            connected = true;
            return new Response("forbidden");
          },
        },
      });
      await expect(
        broker.open({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", method: "GET" }),
      ).rejects.toMatchObject({ code: "dns_denied" });
      expect(connected).toBe(false);
      await broker.close();
    }
  });
  it("closes unread streams and rejects new requests after cancellation", async () => {
    let cancelled = false;
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
      },
    });
    const response = await broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    await broker.close();
    expect(cancelled).toBe(true);
    expect(broker.counters().activeStreams).toBe(0);
    await expect(new Response(response.body).text()).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      broker.open({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", method: "GET" }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
  it("enforces actual response bytes even when Content-Length is absent or false", async () => {
    for (const length of [undefined, "2"]) {
      let closed = false;
      const broker = new AcquisitionBroker({
        videoId: "aqz-KE-bpKQ",
        limits: { responseBytes: 4 },
        network: {
          resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
          request: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("12345"));
                },
                cancel() {
                  closed = true;
                },
              }),
              { headers: length ? { "content-length": length } : {} },
            ),
        },
      });
      const response = await broker.open({
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        method: "GET",
      });
      await expect(new Response(response.body).text()).rejects.toMatchObject({
        code: "budget_exceeded",
      });
      expect(closed).toBe(true);
      expect(broker.counters().activeStreams).toBe(0);
      await broker.close();
    }
  });
  it("revalidates a redirect before connecting and never exposes redirect bodies", async () => {
    const visited: string[] = [];
    let closed = false;
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async ({ url }) => {
          visited.push(url.hostname);
          return new Response(
            new ReadableStream({
              cancel() {
                closed = true;
              },
            }),
            {
              status: 302,
              headers: { location: "https://127.0.0.1/private" },
            },
          );
        },
      },
    });
    await expect(
      broker.open({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", method: "GET" }),
    ).rejects.toMatchObject({ code: "endpoint_denied" });
    expect(visited).toEqual(["www.youtube.com"]);
    expect(closed).toBe(true);
    await broker.close();
  });
  it("caps requests across redirects and refuses oversized declared responses", async () => {
    let cancelled = 0;
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      limits: { requests: 2, responseBytes: 4 },
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            {
              headers: { "content-length": "5" },
            },
          ),
      },
    });
    await expect(
      broker.open({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", method: "GET" }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(cancelled).toBe(1);
    await broker.close();
    const redirects = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      limits: { requests: 2 },
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () =>
          new Response(null, { status: 302, headers: { location: "/watch?v=aqz-KE-bpKQ" } }),
      },
    });
    await expect(
      redirects.open({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", method: "GET" }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(redirects.counters().requests).toBe(2);
    await redirects.close();
  });
  it("bounds aggregate bytes and idle streams across the broker lifetime", async () => {
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      limits: { totalBytes: 5 },
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () => new Response("abc"),
      },
    });
    const first = await broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    expect(await new Response(first.body).text()).toBe("abc");
    const second = await broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    await expect(new Response(second.body).text()).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    await broker.close();
    const idle = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      limits: { idleMilliseconds: 20 },
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () => new Response(new ReadableStream()),
      },
    });
    const stalled = await idle.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    await expect(new Response(stalled.body).text()).rejects.toMatchObject({ code: "deadline" });
    expect(idle.counters().activeStreams).toBe(0);
    await idle.close();
  });
  it("returns bounded errors without external DNS or transport details", async () => {
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => {
          throw new Error("private-host signed-url-token secret");
        },
        request: async () => {
          throw new Error("must not connect");
        },
      },
    });
    await expect(
      broker.open({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", method: "GET" }),
    ).rejects.toMatchObject({ code: "network_unavailable", message: "network_unavailable" });
    await broker.close();
  });
  it("reserves request budget before concurrent DNS calls and times out stalled DNS", async () => {
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      limits: { requests: 1, idleMilliseconds: 20 },
      network: {
        resolve: async (_host, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        request: async () => {
          throw new Error("must not connect");
        },
      },
    });
    const first = broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    const firstRejection = first.catch((error: unknown) => error);
    await expect(
      broker.open({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", method: "GET" }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(await firstRejection).toMatchObject({ code: "deadline" });
    expect(broker.counters().requests).toBe(1);
    await broker.close();
  });
  it("waits for the external transport to release its connections", async () => {
    let release: () => void = () => undefined;
    let closing = false;
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () => new Response("complete"),
        close: async () => {
          closing = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    });
    const response = await broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    await new Response(response.body).text();
    let closed = false;
    const close = broker.close().then(() => {
      closed = true;
      return undefined;
    });
    await Promise.resolve();
    expect(closing).toBe(true);
    expect(closed).toBe(false);
    release();
    await close;
    expect(closed).toBe(true);
  });
  it("reports cleanup failure without leaking cancellation errors or permitting handoff", async () => {
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                throw new Error("private signed URL");
              },
            }),
          ),
      },
    });
    const response = await broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    await expect(response.body?.cancel()).rejects.toMatchObject({
      code: "cleanup_failure",
      message: "cleanup_failure",
    });
    await expect(broker.close()).rejects.toMatchObject({
      code: "cleanup_failure",
      message: "cleanup_failure",
    });
    await expect(broker.close()).rejects.toMatchObject({ code: "cleanup_failure" });
  });
  it("bounds concurrent streams and the whole session even when data remains active", async () => {
    for (const limits of [
      { requests: NaN },
      { responseBytes: Infinity },
      { totalBytes: -1 },
      { idleMilliseconds: 0 },
    ]) {
      expect(() => new AcquisitionBroker({ videoId: "aqz-KE-bpKQ", limits })).toThrow(
        "budget_exceeded",
      );
    }
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      limits: { activeRequests: 1, wallMilliseconds: 30, idleMilliseconds: 1000 },
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () => new Response(new ReadableStream()),
      },
    });
    const first = await broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    await expect(
      broker.open({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", method: "GET" }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    await expect(new Response(first.body).text()).rejects.toMatchObject({ code: "deadline" });
    await broker.close();
    expect(broker.counters().activeStreams).toBe(0);
  });
  it("strips response credentials and rejects compressed or manifest media before reading it", async () => {
    let cancelled = 0;
    let responseHeaders: Record<string, string> = {
      "set-cookie": "SID=private",
      "x-provider-secret": "secret",
      "content-type": "text/html",
    };
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { headers: responseHeaders },
          ),
      },
    });
    const page = await broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    expect([...page.headers]).toEqual([["content-type", "text/html"]]);
    await page.body?.cancel();
    for (const headers of [
      { "content-encoding": "gzip", "content-type": "audio/mp4" },
      { "content-type": "application/dash+xml" },
    ]) {
      responseHeaders = headers;
      await expect(
        broker.open({
          url: "https://rr1---sn-abcd.googlevideo.com/videoplayback?id=abc123&itag=140&source=youtube&mime=audio%2Fmp4",
          method: "GET",
        }),
      ).rejects.toMatchObject({ code: "endpoint_denied" });
    }
    expect(cancelled).toBe(3);
    expect(broker.counters().responseBytes).toBe(0);
    await broker.close();
  });
  it("permits range retries for one progressive object and rejects another object or manifest", async () => {
    const ranges: (string | undefined)[] = [];
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async ({ headers }) => {
          ranges.push(headers["range"]);
          return new Response("abc", {
            status: 206,
            headers: { "content-type": "audio/mp4", "content-range": "bytes 0-2/3" },
          });
        },
      },
    });
    const url =
      "https://rr1---sn-abcd.googlevideo.com/videoplayback?id=abc123&itag=140&source=youtube&mime=audio%2Fmp4&sig=ephemeral";
    for (const range of ["bytes=0-2", "bytes=0-"]) {
      const response = await broker.open({ url, method: "GET", headers: { Range: range } });
      expect(await new Response(response.body).text()).toBe("abc");
    }
    expect(ranges).toEqual(["bytes=0-2", "bytes=0-"]);
    for (const changed of [
      { url: url.replace("itag=140", "itag=18") },
      { url: url.replace("id=abc123", "id=other") },
      { url: url.replace("/videoplayback?", "/api/manifest/dash?") },
      { url: url + "&live=1" },
      { url: url + "&sq=0" },
      { url: url.replace("audio%2Fmp4", "application%2Fx-mpegURL") },
      { headers: { Range: "bytes=0-1,2-3" } },
      { headers: { Range: "bytes=3-1" } },
    ])
      await expect(broker.open({ url, method: "GET", ...changed })).rejects.toMatchObject({
        code: "endpoint_denied",
      });
    expect(broker.counters().requests).toBe(2);
    await broker.close();
  });
  it("allows the pinned extractor's watch and player-script endpoints without general site access", async () => {
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({
          aliases: ["youtube-ui.l.google.com"],
          addresses: ["142.250.74.206"],
        }),
        request: async () => new Response("fixture"),
      },
    });
    for (const path of [
      "/watch?v=aqz-KE-bpKQ&bpctr=9999999999&has_verified=1",
      "/iframe_api",
      "/s/player/012abcde/player_ias.vflset/en_US/base.js",
    ]) {
      const response = await broker.open({ url: `https://www.youtube.com${path}`, method: "GET" });
      expect(await new Response(response.body).text()).toBe("fixture");
    }
    for (const path of [
      "/",
      "/channel/secret",
      "/s/player/012abcde/evil.js",
      "/iframe_api?url=secret",
      "/watch?v=aqz-KE-bpKQ&bpctr=1",
    ]) {
      await expect(
        broker.open({ url: `https://www.youtube.com${path}`, method: "GET" }),
      ).rejects.toMatchObject({ code: "endpoint_denied" });
    }
    expect(broker.counters().requests).toBe(3);
    await broker.close();
  });
  it("admits only bounded credential-free player requests for the selected video", async () => {
    const sent: { method: string; body?: Uint8Array; headers: Record<string, string> }[] = [];
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async (input) => {
          sent.push(input);
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      },
    });
    const input = {
      url: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": "1",
        Origin: "https://www.youtube.com",
      },
      body: new TextEncoder().encode(
        JSON.stringify({
          videoId: "aqz-KE-bpKQ",
          context: { client: { clientName: "WEB", clientVersion: "2.0" } },
        }),
      ),
    };
    const response = await broker.open(input);
    expect(await new Response(response.body).text()).toBe("{}");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual(input.body);
    expect(sent[0]?.headers["content-type"]).toBe("application/json");
    for (const changed of [
      { headers: { Cookie: "SID=secret" } },
      { headers: { Authorization: "Bearer secret" } },
      { headers: { Host: "evil.invalid" } },
      { headers: { Origin: "https://evil.invalid" } },
      { headers: { "User-Agent": "safe\r\nCookie: secret" } },
      { body: new TextEncoder().encode('{"videoId":"dQw4w9WgXcQ"}') },
      {
        body: new TextEncoder().encode(
          '{"videoId":"aqz-KE-bpKQ","serviceIntegrityDimensions":{"poToken":"secret"}}',
        ),
      },
      { method: "GET" as const },
      { body: new Uint8Array(1024 * 1024 + 1) },
      { url: "https://www.youtube.com/youtubei/v1/browse" },
    ])
      await expect(broker.open({ ...input, ...changed })).rejects.toMatchObject({
        code: "endpoint_denied",
      });
    expect(sent).toHaveLength(1);
    await broker.close();
  });
  it("waits for a late HTTPS response to be disposed before close completes", async () => {
    let deliver: (value: Response) => void = () => {
      throw new Error("not started");
    };
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let disposed = false;
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async () =>
          new Promise<Response>((resolve) => {
            deliver = resolve;
            started();
          }),
      },
    });
    const opening = broker.open({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET",
    });
    const rejected = opening.catch((error: unknown) => error);
    await ready;
    let closed = false;
    const closing = broker.close().then(() => {
      closed = true;
      return undefined;
    });
    expect(await rejected).toMatchObject({ code: "cancelled" });
    expect(closed).toBe(false);
    deliver(
      new Response(
        new ReadableStream({
          cancel() {
            disposed = true;
          },
        }),
      ),
    );
    await closing;
    expect(disposed).toBe(true);
    expect(broker.counters().activeStreams).toBe(0);
  });
  it("binds watch requests to one canonical identity and rejects malformed input", async () => {
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => {
          throw new Error("unexpected DNS");
        },
        request: async () => {
          throw new Error("unexpected HTTPS");
        },
      },
    });
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PLsecret",
      "https://www.youtube.com/watch?v=aqz-KE-bpKQ&v=dQw4w9WgXcQ",
      " https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      "https://www.youtube.com/watch?v=aqz-KE-bpKQ#fragment",
      "https://www.youtube.com/watch?v=aqz-KE-bpKQ&unknown=token",
    ])
      await expect(broker.open({ url, method: "GET" })).rejects.toMatchObject({
        code: "endpoint_denied",
      });
    const invalidMethod = {
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      method: "GET" as const,
    };
    Reflect.set(invalidMethod, "method", "CONNECT");
    await expect(broker.open(invalidMethod)).rejects.toMatchObject({ code: "endpoint_denied" });
    expect(broker.counters().requests).toBe(0);
    await broker.close();
  });
  it("rejects forbidden destinations before any DNS or network access", async () => {
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => {
          throw new Error("unexpected DNS");
        },
        request: async () => {
          throw new Error("unexpected HTTPS");
        },
      },
    });
    for (const url of [
      "http://www.youtube.com/watch?v=aqz-KE-bpKQ",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://www.youtube.com.evil.invalid/",
      "https://www.youtube.com:8443/",
      "https://user:secret@www.youtube.com/",
      "https://www.youtube.com/redirect?q=https://example.com",
      "https://example.com/",
    ]) {
      await expect(broker.open({ url, method: "GET" })).rejects.toMatchObject({
        code: "endpoint_denied",
      });
    }
    expect(broker.counters()).toMatchObject({ requests: 0, responseBytes: 0, activeStreams: 0 });
    await broker.close();
  });
});
