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
The Job Key explicitly selects either Source Snapshot identity or canonical-audio fingerprint
identity, then hashes that alternative with Project and Recipe. Cancellation does not release the
key: resubmission returns the same Job, and explicit retry creates a new immutable Attempt.

## Adapter seams

`AnalysisJobRunner` is the cross-process adapter seam. It receives one immutable Job, an abort
signal, exact matching non-media Checkpoints, and bounded callbacks for progress and new
Checkpoints. Main validates the bounded checkpoint document, derives its hash and size from the
actual bytes, stores it durably, and reopens and rehashes it before reuse. The callback schemas
are strict stage-specific structures for shared chroma/onset features, rhythm beats, harmony
regions, or section boundaries; they have no field capable of carrying PCM, media fragments, paths,
or arbitrary process state. Progress is monotonic and explicitly labelled
`benchmark_approximate`. Every Attempt persists a main-owned deadline; a timer races the runner and
aborts a hung execution with the stable `deadline` failure class. Cancellation, sleep, and deadline
paths retain the global slot until the runner adapter confirms escalated process termination and
cleanup.

The main-owned dependency authority resolves verified media, Model Store artifacts, dictionaries,
licenses, and consent at submission and again immediately before an Attempt. Project Library owns
Source/Snapshot verification and delegates recipe artifact availability to a Model Store authority;
it never treats acquisition provenance as installed model provenance.

`AnalysisProjectAuthority` is the publication seam. A runner result is only a candidate. Its
portable Analysis Manifest binds the complete Recipe, Project, selected Source identity,
canonical-audio fingerprint, Job Key, Attempt, accepted timeline/support-claim hashes,
reproducibility conditions, capability-specific stage outcomes, and warnings. Main recomputes those
hashes before deriving the manifest hash and Revision ID, captures the current Project Revision
before execution, and asks the authority to publish against that exact revision. The final
eligibility check and Project commit are serialized against cancellation and sleep interruption. A
stale, invalid, cancelled, interrupted, or late candidate never changes Project Head.

`ProjectLibrary.publishAnalysisRevision` performs the durable publication. The first valid Analysis
Revision atomically receives an empty Edit Layer and becomes Active View. Later valid results remain
Reviewable Revisions and do not move Active View. Publication is idempotent for an already committed
candidate with identical content, closing the crash window between Project Head commit and Job state
acknowledgement. The complete content-addressed Analysis Manifest is stored in Project-owned records
with the Revision, rehashed on reopen, and survives operational Attempt/Checkpoint pruning as
permanent portable provenance.

The runner and dependency types remain module-private until the DSP slice supplies a real production
sidecar and Model Store adapter. There is deliberately no placeholder production runner: tests use
the same `AnalysisJobs.open` boundary while production composition is deferred to that dependent
slice.

Containment, protocol, and integrity failures are forced non-retryable and open the runtime circuit
breaker. Restart clears the breaker as the explicit recovery boundary; queued work still requires
confirmation before it can run.
