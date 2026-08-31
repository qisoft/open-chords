# Local analysis vertical slice

`LocalAnalysisService` is the Electron-main composition boundary for a verified local-file Project.
It submits durable `AnalysisJobs`, reopens and revalidates the Source before every Attempt, stages
only the immutable Project Range as canonical mono PCM16 WAV, and removes the Attempt workspace
after success, failure, cancellation, or deadline termination.

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
initialization boundary as the standalone frozen-runtime proof.
