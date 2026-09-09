import type { BrowserContext } from "@playwright/test";

// Only the external YouTube network response is replaced. The application,
// preload, main gateway, isolated window and bundled adapter remain production code.
export async function installYouTubeProviderFixture(context: BrowserContext, errorCode?: number) {
  await context.route("https://www.youtube.com/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/fixture-media") {
      await route.abort("internetdisconnected");
      return;
    }
    if (new URL(route.request().url()).pathname === "/iframe_api") {
      await route.fulfill({
        headers: { "Cache-Control": "no-store" },
        contentType: "text/javascript",
        body: `
        window.YT = { Player: function(id, options) {
          const iframe = document.createElement('iframe'); iframe.src = 'https://www.youtube.com/embed/' + options.videoId;
          document.getElementById(id).replaceWith(iframe);
          let seconds = 0, rate = 1;
          let delayed = false;
          this.getCurrentTime = () => { if (options.videoId === 'slow0000000' && !delayed) { delayed = true; const deadline = Date.now() + 4000; while (Date.now() < deadline) {} } return seconds; }; this.getDuration = () => 600; this.getPlaybackRate = () => rate;
          this.playVideo = () => { options.events.onStateChange({ data: 1 }); if (options.videoId === 'stall000000') { seconds = 1; setTimeout(() => { fetch('https://www.youtube.com/fixture-media').catch(() => options.events.onStateChange({ data: 3 })); }, 100); } };
          this.pauseVideo = () => options.events.onStateChange({ data: 2 });
          this.seekTo = value => { seconds = value; }; this.setPlaybackRate = value => { rate = value; };
          setTimeout(() => { options.events.onReady(); const code = ${errorCode ?? "null"} ?? (/^error[0-9]{6}$/.test(options.videoId) ? Number(options.videoId.slice(5)) : null); if (code === -1 || code === 1) options.events.onAutoplayBlocked(); else if (code !== null) options.events.onError({ data: code }); }, 0);
        } }; window.onYouTubeIframeAPIReady();`,
      });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>External provider fixture</title><p>Deterministic provider fixture</p>",
      });
  });
}
