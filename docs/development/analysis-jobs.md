# Analysis Jobs

`AnalysisJobs` is the Electron-main module for durable analysis intent and execution policy. Its
interface is intentionally small:

- `submit`, `list`, and `get` create and inspect immutable Job identity;
- `runNext`, `cancel`, `retry`, `confirmQueued`, and `moveBefore` control the single global queue;
- `refreshBlockedDependencies` moves a Job out of pre-Attempt dependency blocking;
- `interruptForSleep` and restart recovery prevent an obsolete Attempt from publishing;
- `pruneOperationalEvidence` enforces the seven-day Attempt and Checkpoint retention policy.

The module stores `analysis-jobs/state.json` beneath the main-owned state root with file and parent
directory synchronization. A restart gives the store a new runtime-session identity, converts an
in-flight Attempt to `interrupted`, and requires explicit confirmation for previously queued work.
The same Project, Source Snapshot or canonical-audio fingerprint, and Recipe hash reuse one Job.
Every retry creates a new immutable Attempt.

## Adapter seams

`AnalysisJobRunner` is the cross-process adapter seam. It receives one immutable Job, an abort
signal, exact matching non-media Checkpoints, and bounded callbacks for progress and new
Checkpoints. The callback schemas exclude PCM, media fragments, paths, and arbitrary process state.
Progress is monotonic and explicitly labelled `benchmark_approximate`.

`AnalysisProjectAuthority` is the publication seam. A runner result is only a candidate. The module
captures the current Project Revision before execution and asks the authority to publish against
that exact revision after the declared DAG succeeds. A stale, invalid, cancelled, interrupted, or
late candidate never changes Project Head.

`ProjectLibrary.publishAnalysisRevision` performs the durable publication. The first valid Analysis
Revision atomically receives an empty Edit Layer and becomes Active View. Later valid results remain
Reviewable Revisions and do not move Active View.

Containment, protocol, and integrity failures are forced non-retryable and open the runtime circuit
breaker. Restart clears the breaker as the explicit recovery boundary; queued work still requires
confirmation before it can run.
