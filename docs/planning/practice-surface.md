# Practice surface implementation

Implements [practice transport, loops, transpose, and diagrams](https://github.com/qisoft/open-chords/issues/43) on the merged Editor Drafts foundation.

## Observed starting point

The workspace keeps temporary selection and a single loop region in renderer state. Playback resumes inside that loop instead of always starting at its first Bar. Main has no practice mutation command. Active View already contains presentation settings, but the complete transport and diagram surface is absent.

## Confirmed public test seams

Confirmed by the user before implementation.

1. **Domain practice and presentation API.** Explicit loops reference stable Bar identities; boundary moves follow those identities, while structural changes affecting anchors require review. Deterministic transpose, Beginner View, enharmonic spelling, capo guidance, and instrument diagram lookup preserve Original Chord Identities. Unsupported symbols remain visible.
2. **Main Project Library and typed desktop commands.** Main validates and durably publishes playback-affecting practice settings. Stale requests cannot overwrite newer state; reopening restores settings. Structural edits reconcile loop validity atomically with the edited timeline, without changing Analysis Revisions or adding practice changes to Edit Transaction history.
3. **Renderer and installed playback journeys.** Pointer and keyboard actions expose the same outcomes. Play/Space always starts an enabled valid loop at its first Bar. Exercise pitch-preserving speed, count-in cancellation, metronome, previous/next chord and Bar navigation, autoscroll, presentation controls, and guitar/ukulele/piano diagrams through the actual UI and packaged media boundary.

## Delivery order

Work one red-to-green behavior slice at a time: durable loop ownership and reconciliation; transport start/navigation/speed; count-in and metronome; deterministic presentation and data-driven diagrams; keyboard and installed journeys. Use the existing Project Library revision and contract migration mechanisms for persisted additions. Keep temporary selection outside saved practice state.

## Validation

Run relevant public-interface tests for every slice, the full repository validation, and macOS/Windows installed-artifact CI before claiming the implementation ready. Synthetic timing and pitch checks must distinguish observed behavior from perceptual audio quality or native accessibility release claims.
