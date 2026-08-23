# Analysis Jobs

`AnalysisJobs` is the Electron-main module for durable analysis intent and execution policy. Its
interface is intentionally small:

- `submit`, `list`, and `get` create and inspect immutable Job identity;
- `runNext`, `cancel`, `retry`, `confirmQueued`, and `moveBefore` control the single global queue;
- `refreshBlockedDependencies` asks main authority to re-evaluate pre-Attempt dependency blocking;
- `interruptForSleep` and restart recovery prevent an obsolete Attempt from publishing;
- `pruneOperationalEvidence` enforces the seven-day Attempt and Checkpoint retention policy.

The module stores `analysis-jobs/state.json` beneath the main-owned state root with file and parent
directory synchronization. A restart gives the store a new runtime-session identity, reconciles a
candidate whose Project publication committed before its acknowledgement was recorded, converts
any other in-flight Attempt to `interrupted`, and requires explicit confirmation for previously
queued work.
The same Project, Source Snapshot or canonical-audio fingerprint, and Recipe hash reuse one Job.
Every retry creates a new immutable Attempt.

## Adapter seams

`AnalysisJobRunner` is the cross-process adapter seam. It receives one immutable Job, an abort
signal, exact matching non-media Checkpoints, and bounded callbacks for progress and new
Checkpoints. The callback schemas exclude PCM, media fragments, paths, and arbitrary process state.
Progress is monotonic and explicitly labelled `benchmark_approximate`.

`AnalysisProjectAuthority` is the dependency and publication seam. It resolves verified blockers at
submission and again immediately before an Attempt. A runner result is only a candidate. Its
manifest must bind the Project, Source Snapshot, canonical-audio fingerprint, Recipe hash, Job Key,
and Attempt. Main derives the manifest hash and Revision ID, captures the current Project Revision
before execution, and asks the authority to publish against that exact revision after the
capability-specific DAG succeeds. The final eligibility check and Project commit are serialized
against cancellation and sleep interruption. A stale, invalid, cancelled, interrupted, or late
candidate never changes Project Head.

`ProjectLibrary.publishAnalysisRevision` performs the durable publication. The first valid Analysis
Revision atomically receives an empty Edit Layer and becomes Active View. Later valid results remain
Reviewable Revisions and do not move Active View. Publication is idempotent for an already committed
candidate with identical content, closing the crash window between Project Head commit and Job state
acknowledgement.

The desktop composition root opens this authority with the Project Library and forwards system
sleep into the durable interruption path. Until the DSP execution slice is installed, the Project
Library reports missing recipe components as model blockers, so no placeholder runner starts an
Attempt.

Containment, protocol, and integrity failures are forced non-retryable and open the runtime circuit
breaker. Restart clears the breaker as the explicit recovery boundary; queued work still requires
confirmation before it can run.
