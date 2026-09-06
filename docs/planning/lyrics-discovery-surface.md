# Lyrics discovery and immutable document surface

Implements [lyrics discovery and immutable Lyrics Documents](https://github.com/qisoft/open-chords/issues/56) from merged main `b38dfac457dbf053ead73fc1f7dc7734b2260304`.

## Observed starting point

The domain already represents immutable Lyrics Documents, distinct line/token occurrences and Lyrics Alignments. The workspace renders a selected document, but main exposes no document-selection mutation or lyrics discovery capability. There is no application Offline Mode control. YouTube player/acquisition work remains separate and unimplemented.

## Confirmed public test seams

Confirmed by the user before implementation under the TDD skill.

1. **Domain document creation and timed import API.** Preserve original Unicode text, line boundaries, language, attribution and notices. Assign distinct occurrence identities to repeated words and lines through a versioned projection. Corrections create another document; validated LRC/subtitle timing does not trigger forced alignment or invent word timing.
2. **Main lyrics discovery, Project Library and typed desktop commands.** Only explicit commands may request provider data. Offline Mode performs no network activity. Bounded candidate lookup, selection, refresh/cancellation and failures discard unselected/failed text; selection durably retains immutable text only with the Project. Test provider HTTP at its external boundary, including ambiguous results, subtitle-kind provenance, malformed/oversized responses and stale selection. The renderer receives named capabilities, never generic URLs or fetch authority.
3. **Renderer and installed application journeys.** Paste/import text, explicitly search, choose among candidates, correct text as a new revision and reopen the Project through actual UI/IPC. Offline/failing lookup leaves local chord analysis and practice available. Verify retained selection after abrupt termination and ensure candidate bodies do not persist.

## Delivery order

Implement one red-to-green behavior slice at a time: local document creation and durable selection; validated supplied timing; explicit discovery and candidate lifecycle; accessible selection/correction/Offline Mode controls; installed recovery and network-denial journeys. Extend persisted contracts through the existing migration mechanism only where required.

Inspect the provider documentation and existing resolved privacy/source decisions before adding network code. LRCLIB supplies lyric candidates; Genius remains metadata/link only. Human and automatic YouTube subtitles remain distinct. Verify a bounded credential-free subtitle retrieval path compatible with the pending YouTube work; if evidence contradicts the normative boundary, record the conflict explicitly rather than introducing a broader fallback. No background lookup, scraping Genius lyrics, credentials, remote execution, or automatic alignment belongs in this ticket.

## Validation

Run the relevant interface tests per slice, full repository validation and installed-artifact checks. Record macOS/Windows CI evidence against the final commit. Provider availability is best effort; feature completion does not establish lyric accuracy, alignment quality or release Support Claims.
