import { randomUUID } from "node:crypto";

import {
  YouTubeActionSchema,
  YouTubePlayerStateSchema,
  type YouTubePlayerState,
} from "@open-chords/contracts";
import { app, BrowserWindow, session, type Session } from "electron";

import type { YouTubePlayer } from "./youtube-service.ts";

const playerSessions = new WeakSet<Session>();
const origin = "open-chords-player://player";
const entry = `${origin}/index.html`;
// YouTube's desktop integration policy requires the installed application's identity.
const appReferer = "https://io.github.qisoft.open-chords/";
export const isYouTubePlayerSession = (value: Session) => playerSessions.has(value);

function providerUrl(raw: string) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ([
        "fonts.gstatic.com",
        "www.gstatic.com",
        "googleads.g.doubleclick.net",
        "static.doubleclick.net",
        "www.google.com",
        "yt3.ggpht.com",
      ].includes(url.hostname) ||
        ["youtube.com", "youtube-nocookie.com", "googlevideo.com", "ytimg.com"].some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        ))
    );
  } catch {
    return false;
  }
}

export class IsolatedYouTubePlayer implements YouTubePlayer {
  #window: BrowserWindow | null = null;
  #videoId: string | null = null;
  #session: Session | null = null;
  #cleanup: Promise<void> = Promise.resolve();
  #epoch = 0;
  #sessionId: string | null = null;
  #pendingState: { window: BrowserWindow; reply: Promise<unknown> } | null = null;

  async open(videoId: string) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("Invalid YouTube video");
    this.close();
    const epoch = this.#epoch;
    await this.#cleanup;
    if (epoch !== this.#epoch) throw new Error("Player cancelled");
    const isolated =
      this.#session ??
      session.fromPartition(`open-chords-player-${randomUUID()}`, { cache: false });
    this.#session = isolated;
    playerSessions.add(isolated);
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    if (isolated.listenerCount("will-download") === 0)
      isolated.on("will-download", (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const local = details.url === entry || details.url === `${origin}/adapter.js`;
      callback({ cancel: !local && !providerUrl(details.url) });
    });
    isolated.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      // Never import account credentials into this disposable playback session.
      for (const name of Object.keys(headers)) {
        if (
          ["cookie", "authorization", "proxy-authorization", "referer"].includes(name.toLowerCase())
        )
          delete headers[name];
      }
      if (providerUrl(details.url)) headers.Referer = appReferer;
      callback({ requestHeaders: headers });
    });
    if (!isolated.protocol.isProtocolHandled("open-chords-player")) {
      // Registration is per Session; the privileged application's protocol is never installed here.
      isolated.protocol.handle("open-chords-player", (request) => {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        const script = request.url === `${origin}/adapter.js`;
        if (!script && request.url !== entry) return new Response(null, { status: 404 });
        return new Response(script ? adapter : html, {
          headers: {
            "Content-Type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'self' https://www.youtube.com; frame-src https://www.youtube.com; style-src 'unsafe-inline'; connect-src https://www.youtube.com; base-uri 'none'; form-action 'none'",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        });
      });
    }
    const window = new BrowserWindow({
      width: 800,
      height: 500,
      minWidth: 500,
      minHeight: 350,
      title: "YouTube — Open Chords",
      show: false,
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged,
        spellcheck: false,
        autoplayPolicy: "document-user-activation-required",
      },
    });
    this.#window = window;
    this.#videoId = videoId;
    this.#sessionId = `playback_${randomUUID().replaceAll("-", "")}`;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.#window === window) this.close();
    });
    try {
      await window.loadURL(entry);
      if (this.#window !== window) throw new Error("Player cancelled");
      await this.#evaluate(window, `window.youtubePlayback.open(${JSON.stringify(videoId)})`);
      window.show();
    } catch {
      if (this.#window === window) this.close();
      throw new Error("YouTube player is unavailable");
    }
  }

  async command(raw: Parameters<YouTubePlayer["command"]>[0]) {
    const action = YouTubeActionSchema.parse(raw);
    if (!("sessionId" in action) || action.sessionId !== this.#sessionId || !this.#window)
      throw new Error("Player is unavailable");
    await this.#evaluate(this.#window, `window.youtubePlayback.command(${JSON.stringify(action)})`);
  }

  async state(): Promise<YouTubePlayerState | null> {
    const window = this.#window;
    const videoId = this.#videoId;
    const sessionId = this.#sessionId;
    if (!window || !videoId || !sessionId) return null;
    try {
      const value = await this.#evaluate(window, "window.youtubePlayback.state()", false);
      if (this.#window !== window) return null;
      return YouTubePlayerStateSchema.parse({
        ...(typeof value === "object" && value !== null ? value : {}),
        videoId,
        sessionId,
      });
    } catch {
      return this.#window === window
        ? {
            videoId,
            sessionId,
            state: "error",
            seconds: 0,
            durationSeconds: 0,
            rate: 1,
            error: "network_unavailable",
          }
        : null;
    }
  }

  close() {
    this.#epoch++;
    const window = this.#window;
    this.#window = null;
    this.#videoId = null;
    this.#sessionId = null;
    this.#pendingState = null;
    if (window && !window.isDestroyed()) window.destroy();
    const isolated = this.#session;
    if (isolated) {
      isolated.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
      this.#cleanup = this.#cleanup
        .then(() =>
          Promise.all([
            isolated.closeAllConnections(),
            isolated.clearStorageData(),
            isolated.clearCache(),
          ]),
        )
        .then(() => undefined);
      void this.#cleanup.catch(() => undefined);
    }
  }
  #evaluate(window: BrowserWindow, script: string, closeOnTimeout = true): Promise<unknown> {
    if (!closeOnTimeout && this.#pendingState?.window === window) return this.#pendingState.reply;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query: Promise<unknown> = window.webContents.executeJavaScript(script);
    const reply = Promise.race([
      query,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (closeOnTimeout && this.#window === window) this.close();
          reject(new Error("Player response timed out"));
        }, 3000);
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
    if (!closeOnTimeout) {
      const pending = { window, reply };
      this.#pendingState = pending;
      const clear = () => {
        if (this.#pendingState === pending) this.#pendingState = null;
        return undefined;
      };
      void query.then(clear, clear);
    }
    return reply;
  }
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>YouTube — Open Chords</title><style>html,body{height:100%;margin:0;background:#111;color:white;font:16px system-ui}#player{width:100%;height:calc(100% - 48px)}p{margin:8px}</style><div id="player"></div><p id="status" role="status">Loading YouTube…</p><script src="/adapter.js"></script></html>`;
const adapter = `(() => {
  let player, videoId, ready = false, timeout, progressAt = Date.now(), lastSeconds = 0;
  let status = { state: 'loading', seconds: 0, durationSeconds: 0, rate: 1 };
  const fail = error => { status = { ...status, state: 'error', error }; document.querySelector('#status').textContent = 'Playback unavailable: ' + error.replaceAll('_', ' ') + '. Use Open on YouTube in Open Chords.'; };
  const load = () => {
    if (!videoId || !window.YT?.Player) return;
    player = new YT.Player('player', { videoId, width: '100%', height: '100%', playerVars: { autoplay: 0, playsinline: 1, origin: location.origin }, events: {
      onReady: () => { ready = true; clearTimeout(timeout); if (status.error) return; status.state = 'ready'; document.querySelector('#status').textContent = 'Use the YouTube controls to start playback.'; },
      onStateChange: event => { const state = { '-1': 'ready', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'ready' }[event.data]; if (state) { if (status.error && state !== 'playing') return; if (!['playing', 'buffering'].includes(status.state)) progressAt = Date.now(); status.state = state; delete status.error; document.querySelector('#status').textContent = 'Playback: ' + state; } },
      onError: event => fail({ 2: 'invalid_video', 5: 'playback_failed', 100: 'unavailable', 101: 'not_embeddable', 150: 'not_embeddable', 153: 'missing_identity' }[event.data] || 'playback_failed'),
      onAutoplayBlocked: () => fail('autoplay_denied'),
    } });
  };
  window.onYouTubeIframeAPIReady = load;
  window.addEventListener('offline', () => fail('network_unavailable'));
  setInterval(() => {
    if (!ready || !['playing', 'buffering'].includes(status.state)) return;
    const seconds = Number(player.getCurrentTime()) || 0;
    if (seconds !== lastSeconds) { lastSeconds = seconds; progressAt = Date.now(); }
    else if (Date.now() - progressAt >= 15000) fail('network_unavailable');
  }, 500);
  window.youtubePlayback = Object.freeze({
    open: id => { if (videoId || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw Error('Invalid playback'); videoId = id; timeout = setTimeout(() => fail('network_unavailable'), 15000); const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.onerror = () => fail('network_unavailable'); document.head.append(script); },
    command: action => { if (!ready) throw Error('Player is not ready'); if (action.type === 'play') player.playVideo(); else if (action.type === 'pause') player.pauseVideo(); else if (action.type === 'seek') player.seekTo(action.seconds, true); else if (action.type === 'set_rate') player.setPlaybackRate(action.rate); else throw Error('Invalid command'); },
    state: () => { if (ready) { status.seconds = Math.max(0, Math.min(86400, Number(player.getCurrentTime()) || 0)); status.durationSeconds = Math.max(0, Math.min(86400, Number(player.getDuration()) || 0)); status.rate = Number(player.getPlaybackRate()) || 1; } return { ...status }; },
  });
})();`;
