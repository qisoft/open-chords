import { Resolver } from "node:dns/promises";
import { Agent, request } from "node:https";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { Readable } from "node:stream";

import { z } from "zod";

type BrokerFailure =
  | "endpoint_denied"
  | "network_unavailable"
  | "dns_denied"
  | "cancelled"
  | "budget_exceeded"
  | "deadline"
  | "cleanup_failure";
export class AcquisitionBrokerError extends Error {
  readonly code: BrokerFailure;
  constructor(code: BrokerFailure) {
    super(code);
    this.code = code;
  }
}

// These are external DNS and HTTPS boundaries, never supplied by the renderer or worker.
export interface AcquisitionNetwork {
  close?(): Promise<void>;
  resolve(host: string, signal: AbortSignal): Promise<{ aliases: string[]; addresses: string[] }>;
  request(input: {
    url: URL;
    address: string;
    method: "GET" | "POST" | "HEAD";
    headers: Record<string, string>;
    body?: Uint8Array;
    signal: AbortSignal;
  }): Promise<Response>;
}

export interface AcquisitionRequest {
  url: string;
  method: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: Uint8Array;
}

// Provisional engineering ceilings, not benchmark-derived product claims.
const LimitsSchema = z.strictObject({
  responseBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024 * 1024)
    .default(256 * 1024 * 1024),
  totalBytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024 * 1024)
    .default(512 * 1024 * 1024),
  requests: z.number().int().min(1).max(120).default(120),
  activeRequests: z.number().int().min(1).max(4).default(4),
  idleMilliseconds: z.number().int().min(1).max(20000).default(20000),
  wallMilliseconds: z.number().int().min(1).max(180000).default(180000),
});

export class AcquisitionBroker {
  readonly #network: AcquisitionNetwork;
  readonly #videoId: string;
  readonly #abort = new AbortController();
  #requests = 0;
  #redirects = 0;
  #opening = 0;
  #wallTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #wallMilliseconds: number;
  readonly #activeLimit: number;
  #mediaIdentity: string | undefined;
  #responseBytes = 0;
  readonly #responseLimit: number;
  readonly #requestLimit: number;
  readonly #totalLimit: number;
  readonly #idleMilliseconds: number;
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  #cleanupFailed = false;
  readonly #disposing = new Set<Promise<void>>();
  readonly #streams = new Set<() => Promise<void>>();
  constructor(options: {
    videoId: string;
    network?: AcquisitionNetwork;
    limits?: z.input<typeof LimitsSchema>;
  }) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(options.videoId))
      throw new AcquisitionBrokerError("endpoint_denied");
    this.#videoId = options.videoId;
    const parsed = LimitsSchema.safeParse(options.limits ?? {});
    if (!parsed.success) throw new AcquisitionBrokerError("budget_exceeded");
    const limits = parsed.data;
    this.#responseLimit = limits.responseBytes;
    this.#requestLimit = limits.requests;
    this.#totalLimit = limits.totalBytes;
    this.#idleMilliseconds = limits.idleMilliseconds;
    this.#wallMilliseconds = limits.wallMilliseconds;
    this.#activeLimit = limits.activeRequests;
    this.#network = options.network ?? createNativeAcquisitionNetwork();
  }
  async open(input: AcquisitionRequest) {
    this.#assertOpen();
    if (this.#opening + this.#streams.size >= this.#activeLimit)
      throw new AcquisitionBrokerError("budget_exceeded");
    this.#opening++;
    try {
      return await this.#open(input);
    } catch (error) {
      this.#assertOpen();
      throw error instanceof AcquisitionBrokerError
        ? error
        : new AcquisitionBrokerError("network_unavailable");
    } finally {
      this.#opening--;
    }
  }
  async #open(input: AcquisitionRequest) {
    this.#assertOpen();
    if (!["GET", "HEAD", "POST"].includes(input.method))
      throw new AcquisitionBrokerError("endpoint_denied");
    let url = permittedUrl(input.url, this.#videoId);
    let method = input.method;
    let headers = permittedHeaders(input.headers ?? {}, url);
    let body = permittedBody(input, url, this.#videoId);
    this.#bindMedia(url);
    if (this.#wallTimer === undefined) {
      this.#wallTimer = setTimeout(() => {
        this.#abort.abort(new AcquisitionBrokerError("deadline"));
        void this.close().catch(() => undefined);
      }, this.#wallMilliseconds);
      this.#wallTimer.unref();
    }
    let response: Response;
    for (let hop = 0; ; hop++) {
      this.#assertOpen();
      if (this.#requests >= this.#requestLimit) throw new AcquisitionBrokerError("budget_exceeded");
      this.#requests++;
      const resolved = await this.#timed(() =>
        this.#network.resolve(url.hostname, this.#abort.signal),
      );
      if (
        resolved.aliases.some((alias) => !permittedAlias(alias)) ||
        resolved.addresses.some((address) => !globalAddress(address))
      )
        throw new AcquisitionBrokerError("dns_denied");
      this.#assertOpen();
      const address = resolved.addresses[0];
      if (address === undefined) throw new AcquisitionBrokerError("network_unavailable");
      response = await this.#timed(async () => {
        const receivedResponse = await this.#network.request({
          url,
          address,
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: this.#abort.signal,
        });
        if (this.#abort.signal.aborted) {
          await this.#dispose(async () => {
            await receivedResponse.body?.cancel();
          });
          this.#assertOpen();
        }
        return receivedResponse;
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await this.#dispose(async () => {
        await response.body?.cancel();
      });
      this.#redirects++;
      if (hop >= 8 || this.#redirects > 8) throw new AcquisitionBrokerError("budget_exceeded");
      const location = response.headers.get("location");
      if (!location) throw new AcquisitionBrokerError("endpoint_denied");
      const redirected = permittedUrl(new URL(location, url).href, this.#videoId);
      if (method === "POST" && redirected.origin !== url.origin)
        throw new AcquisitionBrokerError("endpoint_denied");
      if (url.pathname === "/videoplayback" && redirected.pathname !== "/videoplayback")
        throw new AcquisitionBrokerError("endpoint_denied");
      this.#bindMedia(redirected);
      url = redirected;
      if (
        (response.status === 303 && method !== "HEAD") ||
        ([301, 302].includes(response.status) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
      }
      headers = permittedHeaders(headers, url);
      body = permittedBody(
        { url: url.href, method, headers, ...(body === undefined ? {} : { body }) },
        url,
        this.#videoId,
      );
    }
    if (this.#abort.signal.aborted) {
      await this.#dispose(async () => {
        await response.body?.cancel();
      });
      this.#assertOpen();
    }
    const encoding = response.headers.get("content-encoding");
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (
      (encoding !== null && encoding !== "identity") ||
      (url.pathname === "/videoplayback" &&
        response.status < 400 &&
        ![
          "audio/mp4",
          "audio/webm",
          "video/mp4",
          "video/webm",
          "application/octet-stream",
        ].includes(type ?? ""))
    ) {
      await this.#dispose(async () => {
        await response.body?.cancel();
      });
      throw new AcquisitionBrokerError("endpoint_denied");
    }
    const responseHeaders = new Headers();
    for (const key of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "retry-after",
      "last-modified",
      "etag",
      "date",
    ]) {
      const value = response.headers.get(key);
      if (value !== null) responseHeaders.set(key, value);
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > this.#responseLimit)) {
      await this.#dispose(async () => {
        await response.body?.cancel();
      });
      throw new AcquisitionBrokerError("budget_exceeded");
    }
    const reader = response.body?.getReader();
    if (!reader)
      return { url: url.href, status: response.status, headers: responseHeaders, body: null };

    let idle: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        this.#abort.abort(new AcquisitionBrokerError("deadline"));
        void this.close().catch(() => undefined);
      }, this.#idleMilliseconds);
      idle.unref();
    };
    let received = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.#streams.delete(cancel);
      clearTimeout(idle);
    };
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const cancel = async () => {
      if (finished) return;
      finish();
      streamController.error(this.#abort.signal.reason ?? new AcquisitionBrokerError("cancelled"));
      await this.#dispose(async () => {
        await reader.cancel();
      });
    };
    this.#streams.add(cancel);
    touch();
    const responseBody = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
      },
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) {
            finish();
            controller.close();
          } else {
            this.#responseBytes += chunk.value.byteLength;
            received += chunk.value.byteLength;
            touch();
            if (received > this.#responseLimit || this.#responseBytes > this.#totalLimit) {
              this.#abort.abort(new AcquisitionBrokerError("budget_exceeded"));
              await this.close();
              return;
            }
            controller.enqueue(chunk.value);
          }
        } catch {
          if (finished) return;
          finish();
          controller.error(new AcquisitionBrokerError("network_unavailable"));
        }
      },
      cancel: async () => {
        finish();
        await this.#dispose(async () => {
          await reader.cancel();
        });
      },
    });
    return { url: url.href, status: response.status, headers: responseHeaders, body: responseBody };
  }
  #bindMedia(url: URL) {
    if (url.pathname !== "/videoplayback") return;
    const identity = JSON.stringify([url.searchParams.get("id"), url.searchParams.get("itag")]);
    if (this.#mediaIdentity !== undefined && this.#mediaIdentity !== identity)
      throw new AcquisitionBrokerError("endpoint_denied");
    this.#mediaIdentity = identity;
  }
  counters() {
    return {
      requests: this.#requests,
      redirects: this.#redirects,
      responseBytes: this.#responseBytes,
      activeStreams: this.#streams.size,
    };
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    clearTimeout(this.#wallTimer);
    this.#abort.abort(new AcquisitionBrokerError("cancelled"));
    this.#closing = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            this.#dispose(async () => {
              await this.#network.close?.();
            }),
            ...[...this.#pending].map((pending) => pending.catch(() => undefined)),
            ...[...this.#streams].map((cancel) => cancel()),
            ...this.#disposing,
          ]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new AcquisitionBrokerError("cleanup_failure")), 5000);
            timeout.unref();
          }),
        ]);
        if (this.#cleanupFailed) throw new AcquisitionBrokerError("cleanup_failure");
      } catch {
        throw new AcquisitionBrokerError("cleanup_failure");
      } finally {
        clearTimeout(timeout);
      }
    })();
    return this.#closing;
  }
  #dispose(operation: () => Promise<void>): Promise<void> {
    const pending = (async () => {
      try {
        await operation();
      } catch {
        this.#cleanupFailed = true;
        throw new AcquisitionBrokerError("cleanup_failure");
      }
    })();
    this.#disposing.add(pending);
    void pending.finally(() => this.#disposing.delete(pending)).catch(() => undefined);
    return pending;
  }
  async #timed<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout>;
    let abort: () => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => reject(this.#abort.signal.reason);
      this.#abort.signal.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => {
        this.#abort.abort(new AcquisitionBrokerError("deadline"));
        void this.close().catch(() => undefined);
      }, this.#idleMilliseconds);
      timeout.unref();
    });
    const pending = operation();
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending)).catch(() => undefined);
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timeout!);
      this.#abort.signal.removeEventListener("abort", abort);
    }
  }
  #assertOpen() {
    if (this.#abort.signal.aborted) throw this.#abort.signal.reason;
  }
}

function permittedUrl(rawUrl: string, videoId: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.length > 16384 || /[\s\\]/u.test(rawUrl))
    throw new AcquisitionBrokerError("endpoint_denied");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AcquisitionBrokerError("endpoint_denied");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.hostname !== "www.youtube.com" &&
      !/^rr[0-9]+---sn-[a-z0-9-]+\.googlevideo\.com$/u.test(url.hostname))
  )
    throw new AcquisitionBrokerError("endpoint_denied");
  if (url.hostname !== "www.youtube.com") {
    if (
      url.pathname !== "/videoplayback" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(url.searchParams.get("id") ?? "") ||
      !/^[0-9]{1,5}$/.test(url.searchParams.get("itag") ?? "") ||
      url.searchParams.get("source") !== "youtube" ||
      !["audio/mp4", "audio/webm", "video/mp4", "video/webm"].includes(
        url.searchParams.get("mime") ?? "",
      ) ||
      ["live", "sq", "playlist_type", "manifest", "target_duration"].some((key) =>
        url.searchParams.has(key),
      ) ||
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
    )
      throw new AcquisitionBrokerError("endpoint_denied");
    return url;
  }
  if (url.pathname === "/watch") {
    if (
      url.searchParams.get("v") !== videoId ||
      [...url.searchParams].some(([key, value]) =>
        key === "v"
          ? value !== videoId
          : key === "bpctr"
            ? value !== "9999999999"
            : key === "has_verified"
              ? value !== "1"
              : true,
      ) ||
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
    )
      throw new AcquisitionBrokerError("endpoint_denied");
  } else if (url.pathname === "/youtubei/v1/player") {
    if (
      [...url.searchParams].some(([key, value]) => key !== "prettyPrint" || value !== "false") ||
      url.searchParams.getAll("prettyPrint").length > 1
    )
      throw new AcquisitionBrokerError("endpoint_denied");
  } else if (
    url.pathname === "/iframe_api" ||
    /^\/s\/player\/[0-9a-fA-F]{8}\/player_ias\.vflset\/en_US\/base\.js$/u.test(url.pathname)
  ) {
    if (url.search) throw new AcquisitionBrokerError("endpoint_denied");
  } else throw new AcquisitionBrokerError("endpoint_denied");
  return url;
}

const TextHeader = z
  .string()
  .max(2048)
  .regex(/^[\x20-\x7e]*$/u);
function permittedHeaders(input: Record<string, string>, url: URL): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 16)
    throw new AcquisitionBrokerError("endpoint_denied");
  const allowed = new Set([
    "accept",
    "accept-language",
    "accept-encoding",
    "user-agent",
    "content-type",
    "origin",
    "referer",
    "x-youtube-client-name",
    "x-youtube-client-version",
    "x-goog-visitor-id",
    "sec-fetch-mode",
    "range",
  ]);
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    if (!allowed.has(name) || seen.has(name) || !TextHeader.safeParse(value).success)
      throw new AcquisitionBrokerError("endpoint_denied");
    seen.add(name);
    if (name === "range") {
      const match = /^bytes=([0-9]{1,12})-([0-9]{1,12})?$/.exec(value);
      if (
        url.pathname !== "/videoplayback" ||
        !match ||
        (match[2] !== undefined && Number(match[2]) < Number(match[1]))
      )
        throw new AcquisitionBrokerError("endpoint_denied");
    }
    if (
      url.pathname === "/videoplayback" &&
      [
        "origin",
        "referer",
        "content-type",
        "x-youtube-client-name",
        "x-youtube-client-version",
        "x-goog-visitor-id",
      ].includes(name)
    )
      throw new AcquisitionBrokerError("endpoint_denied");
    if (name === "origin" && value !== url.origin)
      throw new AcquisitionBrokerError("endpoint_denied");
    if (name === "referer" && value !== "https://www.youtube.com/")
      throw new AcquisitionBrokerError("endpoint_denied");
    if (name === "content-type" && value !== "application/json")
      throw new AcquisitionBrokerError("endpoint_denied");
    if (name !== "accept-encoding") headers[name] = value;
  }
  return headers;
}
const PlayerBody = z.strictObject({
  videoId: z.string(),
  context: z.object({
    client: z.object({
      clientName: z.enum(["WEB", "WEB_SAFARI"]),
      clientVersion: TextHeader,
      hl: TextHeader.optional(),
      gl: TextHeader.optional(),
      visitorData: TextHeader.optional(),
      userAgent: TextHeader.optional(),
      timeZone: TextHeader.optional(),
      utcOffsetMinutes: z.number().int().min(-1440).max(1440).optional(),
    }),
  }),
  playbackContext: z
    .strictObject({
      contentPlaybackContext: z.strictObject({
        html5Preference: z.literal("HTML5_PREF_WANTS"),
        signatureTimestamp: z.number().int().nonnegative().optional(),
      }),
    })
    .optional(),
  contentCheckOk: z.boolean().optional(),
  racyCheckOk: z.boolean().optional(),
  params: TextHeader.optional(),
});
function permittedBody(
  input: AcquisitionRequest,
  url: URL,
  videoId: string,
): Uint8Array | undefined {
  if (url.pathname !== "/youtubei/v1/player") {
    if (input.method === "POST" || input.body !== undefined)
      throw new AcquisitionBrokerError("endpoint_denied");
    return undefined;
  }
  if (
    input.method !== "POST" ||
    !(input.body instanceof Uint8Array) ||
    input.body.byteLength > 1024 * 1024
  )
    throw new AcquisitionBrokerError("endpoint_denied");
  try {
    const body = PlayerBody.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body)),
    );
    if (body.videoId !== videoId) throw new Error();
    return new TextEncoder().encode(JSON.stringify(body));
  } catch {
    throw new AcquisitionBrokerError("endpoint_denied");
  }
}

/** The injectable boundary is the external TCP peer; TLS policy stays owned here. */
export function createNativeAcquisitionNetwork(
  connectTcp: (address: string, port: number) => Socket = (address, port) =>
    connect({ host: address, port }),
): AcquisitionNetwork {
  const connections = new Map<Agent, Promise<void>>();
  let closed = false;
  return {
    async close() {
      closed = true;
      const pending = [...connections.values()];
      for (const agent of connections.keys()) agent.destroy();
      await Promise.all(pending);
    },
    async resolve(host, signal) {
      signal.throwIfAborted();
      const resolver = new Resolver();
      const abort = () => resolver.cancel();
      signal.addEventListener("abort", abort, { once: true });
      const missing = (error: unknown): string[] => {
        if (error instanceof Error && "code" in error && error.code === "ENODATA") return [];
        throw error;
      };
      try {
        const aliases: string[] = [];
        let current = host;
        for (let hop = 0; ; hop++) {
          signal.throwIfAborted();
          const next = await resolver.resolveCname(current).catch(missing);
          if (next.length === 0) break;
          if (next.length !== 1 || hop >= 8) throw new AcquisitionBrokerError("dns_denied");
          const alias = next[0]!.toLowerCase().replace(/\.$/, "");
          if (!permittedAlias(alias) || alias === host || aliases.includes(alias))
            throw new AcquisitionBrokerError("dns_denied");
          aliases.push(alias);
          current = alias;
        }
        const [ipv4, ipv6] = await Promise.all([
          resolver.resolve4(current).catch(missing),
          resolver.resolve6(current).catch(missing),
        ]);
        signal.throwIfAborted();
        return { aliases, addresses: [...ipv4, ...ipv6] };
      } finally {
        signal.removeEventListener("abort", abort);
        resolver.cancel();
      }
    },
    request({ url, address, method, headers, body, signal }) {
      return new Promise((resolve, reject) => {
        if (closed || signal.aborted) {
          reject(new AcquisitionBrokerError("cancelled"));
          return;
        }
        const agent = new Agent({ keepAlive: false, maxCachedSessions: 0, proxyEnv: {} });
        const secureConnection = agent.createConnection.bind(agent);
        agent.createConnection = (options, callback) => {
          const connection = {
            ...options,
            socket: connectTcp(address, 443),
            servername: url.hostname,
            rejectUnauthorized: true,
          };
          return secureConnection(connection, callback);
        };
        let released: () => void = () => undefined;
        connections.set(
          agent,
          new Promise<void>((resolveConnection) => {
            released = resolveConnection;
          }),
        );
        const finish = () => {
          agent.destroy();
          connections.delete(agent);
          released();
        };
        let outgoing;
        try {
          outgoing = request(
            {
              protocol: "https:",
              hostname: url.hostname,
              servername: url.hostname,
              port: 443,
              path: url.pathname + url.search,
              method,
              headers,
              signal,
              agent,
              rejectUnauthorized: true,
              family: isIP(address),
              lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
            },
            (incoming) => {
              try {
                const responseHeaders = new Headers();
                for (const [key, value] of Object.entries(incoming.headers)) {
                  if (typeof value === "string") responseHeaders.set(key, value);
                }
                incoming.once("close", () => agent.destroy());
                const responseBody: unknown =
                  method === "HEAD" || [204, 205, 304].includes(incoming.statusCode ?? 0)
                    ? null
                    : Readable.toWeb(incoming);
                if (responseBody !== null && !(responseBody instanceof ReadableStream))
                  throw new Error("invalid_response_body");
                resolve(
                  new Response(responseBody, {
                    status: incoming.statusCode ?? 502,
                    headers: responseHeaders,
                  }),
                );
                if (method === "HEAD" || [204, 205, 304].includes(incoming.statusCode ?? 0))
                  incoming.resume();
              } catch {
                incoming.destroy();
                reject(new AcquisitionBrokerError("network_unavailable"));
              }
            },
          );
        } catch {
          finish();
          reject(new AcquisitionBrokerError("network_unavailable"));
          return;
        }
        outgoing.once("close", finish);
        outgoing.once("error", () => {
          agent.destroy();
          reject(new AcquisitionBrokerError("network_unavailable"));
        });
        outgoing.end(body);
      });
    },
  };
}

const specialV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  specialV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  specialV6.addSubnet(address, prefix, "ipv6");
function globalAddress(address: string): boolean {
  if (address.includes("%")) return false;
  return isIP(address) === 4
    ? !specialV4.check(address, "ipv4")
    : isIP(address) === 6 && globalV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
}
function permittedAlias(host: string): boolean {
  return (
    host.length <= 253 &&
    host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    [".google.com", ".youtube.com", ".googlevideo.com"].some((suffix) => host.endsWith(suffix))
  );
}
