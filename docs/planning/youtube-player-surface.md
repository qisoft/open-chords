# YouTube metadata and isolated player surface

Implementation issue: [Implement YouTube metadata and the isolated player surface](https://github.com/qisoft/open-chords/issues/59).

## Scope and authority

Add canonical YouTube Source identity, explicit public metadata observations and isolated online playback. Metadata and playback never imply that media acquisition is available. Local-file ingestion remains the guaranteed analysis path. Acquisition belongs to its separate dependency-ordered issue.

The normative specification sections 3, 6 and 13 and the implementation plan define the boundary. Electron main owns Source/Project authority. Remote player code receives no Project, filesystem, sidecar, generic IPC or local-media capability.

## Confirmed public test seams

The user confirmed all three seams on 2026-09-09.

1. **Source and metadata API.** Canonicalize supported YouTube URL forms to provider plus video ID, discard playlist/radio/query state, and reject unsupported inputs. Explicit metadata refresh creates immutable, timestamped observations without changing Source identity, old Snapshots, Project Range or a user Project name. Offline Mode prevents requests. Failure and cancellation publish no partial observation; metadata success supplies no acquisition verdict.
2. **Desktop API and isolated player.** Exercise the actual named renderer/preload/main path and sandboxed player adapter. Commands and events are restricted to a current playback session and validated. Remote content cannot invoke Project operations, read local media, navigate the privileged surface, open arbitrary windows, use filesystem/process APIs or reach generic IPC. User-visible playback errors and Open on YouTube remain explicit; network activity stops when the player closes or Offline Mode is enabled.
3. **Installed macOS and Windows artifacts.** Prove the exact player origin/Referer behavior, including error 153, play/pause/seek/rate, autoplay denial, network loss and non-embeddable video behavior. Separate deterministic security/error fixtures from observed live-provider evidence. A metadata response, DOM fixture or successful player initialization is not proof of actual online playback.

## Integration constraints

- The privileged application renderer currently denies all frames and external requests. Add a separate unprivileged session/surface; do not allow YouTube in the privileged renderer's policy.
- Source metadata records already exist in the Project Library model. Extend their public authority rather than creating a parallel persistence store.
- The static player adapter may use a hardened random-port loopback origin only if packaged custom-scheme identity fails, as permitted by the specification. Validate Host/origin/path and expose no local-file or general proxy surface.
- No cookie import, credentials, extractor process, acquisition bypass or background metadata refresh is in scope.
- Unfinished native accessibility evidence remains tracked by the workspace gate. Merging its implementation does not close that gate or unblock its release dependants.

## Implementation order

After seam confirmation, establish red tests at the Source/metadata interface, implement bounded explicit metadata observation, then add and adversarially test the isolated player bridge. Integrate keyboard-accessible controls and explicit recovery states. Verify live player identity in the exact installed artifact before treating online playback as supported; preserve observed failures and limitations.
