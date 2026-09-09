import type { BrowserContext } from "@playwright/test";

// Only the external YouTube network response is replaced. The application,
// preload, main gateway, isolated window and bundled adapter remain production code.
export async function installYouTubeProviderFixture(context: BrowserContext, errorCode?: number) {
  await context.route("https://www.youtube.com/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/iframe_api") {
      await route.fulfill({
        contentType: "text/javascript",
        body: `
        window.YT = { Player: function(id, options) {
          const iframe = document.createElement('iframe'); iframe.src = 'https://www.youtube.com/embed/' + options.videoId;
          document.getElementById(id).replaceWith(iframe);
          let seconds = 0, rate = 1;
          this.getCurrentTime = () => seconds; this.getDuration = () => 600; this.getPlaybackRate = () => rate;
          this.playVideo = () => options.events.onStateChange({ data: 1 });
          this.pauseVideo = () => options.events.onStateChange({ data: 2 });
          this.seekTo = value => { seconds = value; }; this.setPlaybackRate = value => { rate = value; };
          setTimeout(() => { options.events.onReady(); ${errorCode === undefined ? "" : errorCode === -1 ? "options.events.onAutoplayBlocked();" : `options.events.onError({ data: ${errorCode} });`} }, 0);
        } }; window.onYouTubeIframeAPIReady();`,
      });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>External provider fixture</title><p>Deterministic provider fixture</p>",
      });
  });
}
