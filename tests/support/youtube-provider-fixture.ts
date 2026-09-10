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
          setTimeout(() => { options.events.onReady(); const code = ${errorCode ?? "null"} ?? (/^error[0-9]{6}$/.test(options.videoId) ? Number(options.videoId.slice(5)) : null); if (code === -1 || code === 1) options.events.onAutoplayBlocked(); else if (code !== null) options.events.onError({ data: code }); if (code !== null) options.events.onStateChange({ data: -1 }); }, 0);
        } }; window.onYouTubeIframeAPIReady();`,
      });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>External provider fixture</title><p>Deterministic provider fixture</p>",
      });
  });
}

// Exercise Chromium's real unmuted media policy across the external iframe boundary.
export async function installYouTubeMediaFixture(context: BrowserContext) {
  const samples = 48000 * 4;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(Math.round(1000 * Math.sin((i * Math.PI) / 60)), 44 + i * 2);
  await context.route("https://www.youtube.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixture.wav") {
      await route.fulfill({ contentType: "audio/wav", body: wav });
    } else if (path === "/iframe_api") {
      await route.fulfill({
        contentType: "text/javascript",
        body: `
        window.YT = { Player: function(id, options) {
          const iframe = document.createElement('iframe');
          iframe.allow = 'autoplay'; iframe.src = 'https://www.youtube.com/embed/' + options.videoId;
          document.getElementById(id).replaceWith(iframe);
          let seconds = 0;
          this.getCurrentTime = () => seconds; this.getDuration = () => 4; this.getPlaybackRate = () => 1;
          this.playVideo = () => iframe.contentWindow.postMessage('play', 'https://www.youtube.com');
          window.addEventListener('message', event => {
            if (event.source !== iframe.contentWindow || event.origin !== 'https://www.youtube.com') return;
            if (event.data === 'ready') options.events.onReady();
            else if (event.data === 'blocked') options.events.onAutoplayBlocked();
            else if (event.data === 'playing') options.events.onStateChange({ data: 1 });
            else if (typeof event.data === 'number') seconds = event.data;
          });
        } }; window.onYouTubeIframeAPIReady();`,
      });
    } else {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html>
        <audio src="https://www.youtube.com/fixture.wav"></audio><script>
        const audio = document.querySelector('audio');
        window.addEventListener('message', event => {
          if (event.source === parent && event.data === 'play')
            audio.play().then(() => parent.postMessage('playing', '*'), () => parent.postMessage('blocked', '*'));
        });
        audio.ontimeupdate = () => parent.postMessage(audio.currentTime, '*');
        parent.postMessage('ready', '*');
        </script>`,
      });
    }
  });
}
