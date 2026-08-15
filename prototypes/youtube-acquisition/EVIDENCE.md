# Prototype evidence

Checked locally on 2026-08-15 on macOS arm64. This evidence belongs only to the throwaway prototype branch.

## Static/runtime self-check

Passed with pinned `yt-dlp` 2026.07.04, `yt-dlp-ejs` 0.8.0, Deno 2.8.3, and Python 3.14.3:

- exactly one request handler: `Broker`;
- exactly one extractor: `Youtube`;
- no plugin directories, remote components, postprocessors, external downloader, cookie file, or browser-cookie source;
- the worker's Python socket guard was active;
- all nine endpoint-policy probes produced the expected allow/deny decision;
- worker exit left zero broker streams and the temporary workspace was removed.

The command was:

```bash
.venv/bin/python prototypes/youtube-acquisition/prototype.py --self-check
```

## Live metadata probes

No media was requested or retained.

1. Official yt-dlp test fixture `BaW_jenozKc`: brokered six requests (583,868 response bytes), all against the exact `www.youtube.com` category. YouTube returned `Video unavailable`. Worker exited with failure, zero streams remained, and the workspace was removed.
2. Pinned extractor test fixture `YE7VzlLtp-4`: brokered six requests (791,686 response bytes), all against the exact `www.youtube.com` category. YouTube returned the bot-check/sign-in requirement. The v1 contract forbids cookies/browser credentials, so the worker failed closed. Zero streams remained and the workspace was removed.

The second fixture is present in the pinned release's `YoutubeIE` test matrix. The first remains widely referenced in official yt-dlp source/tests but is no longer available as a successful fixture.

## Current verdict

The prototype proves that the pinned internal `RequestDirector` seam can run with one broker-only handler and that real extractor traffic crosses the framed broker protocol without Python-worker sockets. It has **not** proved a successful credential-free acquisition, single-stream selection/download, Deno challenge execution, native OS containment, or the future licensed corpus.

The observed bot check is product-significant: v1 must keep the fail-closed behavior and may have unreliable YouTube acquisition unless the authorized corpus succeeds without cookies from the intended user-network environments. This result does not justify adding cookies, account credentials, remote components, or a broad-network compatibility mode.
