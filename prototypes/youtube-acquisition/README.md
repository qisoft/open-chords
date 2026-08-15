# Brokered YouTube acquisition prototype

> **THROWAWAY PROTOTYPE — not product code and not a security boundary.**

## Question

Can pinned `yt-dlp` 2026.07.04 plus `yt-dlp-ejs` 0.8.0 and Deno 2.8.3 operate with exactly one broker-backed request handler, no direct Python network path, only the `Youtube` extractor, no plugins/remote components/postprocessors/external downloaders, and a single progressive HTTPS media object?

The prototype uses a separate worker process with length-prefixed stdio IPC. Its custom `BrokerRH` turns every `yt-dlp` request into broker messages; the parent broker owns DNS, TLS, redirects, endpoint policy, streaming, and byte/request budgets. The worker monkeypatches Python socket entry points to prove the exercised Python path does not need them. That monkeypatch is **not containment**.

## Run

From the repository root:

```bash
python3 prototypes/youtube-acquisition/run.py
```

The first run creates an ignored prototype venv and installs the exact versions in `requirements.txt`. The TUI always renders its full state. Live metadata/acquisition probes require a user-authorized public YouTube video ID; the repository intentionally contains no corpus URLs.

Noninteractive configuration/policy evidence:

```bash
python3 prototypes/youtube-acquisition/run.py --self-check
```

An explicitly authorized live acquisition:

```bash
python3 prototypes/youtube-acquisition/run.py --acquire VIDEO_ID
```

## What this can decide

- Whether the pinned `YoutubeDL` internal seam can contain exactly one custom `RequestHandler`.
- Whether extraction/download uses broker IPC without Python-worker sockets.
- Whether one progressive HTTPS audio-only or combined stream is available for an authorized probe.
- Which endpoint categories and request shapes the exact release actually exercises.
- Whether worker exit closes broker streams and removes the disposable workspace.

## What it cannot decide locally

- Native macOS XPC App Sandbox, Windows AppContainer/Job Object, or Linux Landlock/seccomp/cgroup enforcement.
- Signed/frozen packaging and hostile descendant-tree cleanup.
- Deno child containment beyond its measured command/permission flags.
- Coverage of the future licensed 30–50-track benchmark corpus.
- Production-ready DNS CNAME/rebinding handling or final endpoint and numeric budget policies.

Those gaps are displayed by the prototype and remain release gates. A passing self-check is evidence that the broker adapter seam is technically exercisable, not evidence that the whole cross-platform security contract is shipped.
