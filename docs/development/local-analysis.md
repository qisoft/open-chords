# Local analysis vertical slice

`LocalAnalysisService` is the Electron-main composition boundary for a verified local-file Project.
It submits durable `AnalysisJobs`, reopens and revalidates the Source before every Attempt, stages
only the immutable Project Range as canonical mono PCM16 WAV, and removes the Attempt workspace
after success, failure, cancellation, or deadline termination.

Each Attempt receives a short directory created exclusively beneath the main-owned workspace
root. Durable Job and Attempt identities remain in scheduler state and the Manifest instead of
being repeated in native temporary paths. This keeps Windows workspace paths compact and avoids
reusing leftover directories; every Attempt still owns and removes its complete workspace.

The contained sidecar receives the exact Analysis Recipe beside the staged media. It performs the
manifest-verified canonical FFmpeg decode and weight-free CPU analysis, then atomically writes a
bounded `artifacts/analysis-result.json` descriptor. The sidecar candidate is untrusted: main
requires the declared path, regular-file containment, exact byte count and SHA-256, strict Recipe
and result schemas, matching staged duration/sample rate/Recipe, and complete Musical Timeline
invariants before constructing an Analysis Manifest and candidate Revision.

`AnalysisJobs` remains the publication authority. The first accepted Revision and its empty Edit
Layer become Active View in one Project Library commit. A later accepted Revision remains
Reviewable and cannot move Active View implicitly. Warnings, per-assertion confidence/evidence,
coverage including abstentions, stage outcomes, complete Recipe provenance, and empty Support Claim
IDs are retained with the immutable Revision and Manifest.

Cancellation is persisted before the sidecar is signalled. Deadline, crash, malformed output,
protocol, integrity, and containment failures publish no Revision. The scheduler retains its global
slot until the analyzer confirms disposal of the process domain, and the Attempt workspace is then
removed. The installed-artifact proof runs the same contained decode and CPU analysis twice (cold
and warm) and requires byte-identical candidates after the existing cancel, crash, and adversarial
containment probes on macOS arm64 and Windows x64. It emits cold and warm wall-clock durations in
the CI log. The frozen sidecar preloads the CPU analysis stack on the interpreter's main thread
before starting the decode worker so Windows AppContainer cold starts exercise the same supported
initialization boundary as the standalone frozen-runtime proof. A bounded writer preserves
monotonic protocol heartbeats during that preload, so the host's liveness and absolute session
deadlines remain authoritative.
Analysis failures retain the stable `analysis_failed` protocol code while installed proofs may log
only a bounded exception fingerprint. Permission failures add a coarse path scope and numeric
error codes; exception messages, concrete paths, and media data remain private.

On Windows, result publication reuses the native-validated workspace current directory, just as
canonical decode does. Resolving that absolute root again can require access to private
AppContainer profile ancestors and fail after DSP succeeds. Publication still rejects a symlink
or reparse-point artifacts directory, writes a bounded temporary file, flushes it, and atomically
replaces the final result. Non-native sessions retain absolute-path resolution checks.

The installed-artifact gate also composes `LocalMediaService`, `LocalAnalysisService`, the real
contained analyzer, and `ProjectLibrary`. A main-owned fixture outside the sidecar workspace
produces the first active Revision, retained Recipe/Manifest, and Effective Timeline. A second
profile produces a Reviewable Revision while the first Revision, Manifest, Active View, and Edit
Layer count stay unchanged. The gate requires the `publication_completed` marker as well as a
clean process exit; module tests with a substituted analyzer do not stand in for this journey.
The protocol records completed preflight and canonical-decode stages before the CPU module's
stage outcomes. Main still requires the exact complete pipeline when validating the Manifest;
DSP-only stage evidence cannot be published as a complete Analysis Revision.

The native broker retains its child-process error listener until the process closes, including
abort events emitted after a successful launch. Cancellation remains a session outcome rather
than an uncaught main-process exception. Native attestation is bounded by the request budget
and a 60-second upper limit, with cancellation active throughout acquisition. The cold
adversarial packaged probe uses a 60-second budget after Windows evidence showed its earlier
15-second budget expiring during valid startup. In packaged proof mode only, unexpected main-process
errors emit a bounded error kind/code and exit unsuccessfully instead of opening Electron's
default error dialog. Captured proof output is retained on timeout, and the CI packaged gate
does not automatically retry a failed attempt.
