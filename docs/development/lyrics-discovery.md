# Lyrics discovery and document selection

The Project Library owns `project.add_lyrics`. It validates input and the expected Head, creates a new immutable Lyrics Document and initial Lyrics Alignment, and acknowledges only the durable Project Revision. Existing documents, machine analysis and Edit Transactions are retained. This uses the existing 1.2 Project vocabulary; no new persisted fields or migration are required.

## Local text and timing

The lyrics surface accepts pasted plain text, LRC, WebVTT and SRT. Local supplied timing is relative to the Project. Provider timing is relative to the Source and main maps it into the immutable Project Range. Out-of-range text is retained with unmatched timing. Corrections create a new plain document; they never silently reuse old timing against changed words.

The `unicode_letter_number_utf16` projection version 1.0 preserves original Unicode text, original plain-text line separators, and UTF-16 character offsets. Line/token IDs include the document identity and occurrence index; repeated words are distinct. Python validates the same UTF-16 offsets, including supplementary characters. Empty physical lines remain in the immutable text but have no zero-length line occurrence.

LRC supports monotonic single timestamps per line and common descriptive header tags. Line ends derive from the next supplied onset or the Project end. Enhanced word LRC, offset directives and multiple timestamps on one line are rejected explicitly rather than guessed. SRT/WebVTT preserve supplied cue intervals. Multiline cue text preserves line breaks; the first line owns the cue interval and subsequent lines remain unmatched because separate timing was not supplied. Display markup is removed from subtitle cue text and common entities are decoded. Overlapping primary streams, empty cues and invalid intervals are rejected. No supplied line timing invents word intervals or starts MFA.

## Explicit network boundary

Only `lyrics.perform` with its closed action schema reaches discovery. `status` is local. Search, candidate selection/refetch and opening the Genius search link each require an explicit UI action. Offline Mode persists in `network-mode.json`, cancels current transfers/candidates, and prevents every currently implemented network action. Future YouTube/model/update integrations must share this gate. It does not disable local text selection, analysis or practice.

Main uses credential-free requests to fixed HTTPS origins, rejects redirects, bounds responses at 2 MiB and operations at 15 seconds, and accepts at most 20 candidates. The primary renderer receives no fetch capability. YouTube caption URLs must have the exact `https://www.youtube.com/api/timedtext` endpoint and the requested video ID; credentials, alternate hosts and fragments are rejected.

Candidate state is generation/Project scoped and expires after five minutes. LRCLIB search bodies are parsed and discarded; only metadata, record ID and content hash remain. Selecting a candidate refetches that ID and rejects changed content. YouTube signed URLs remain only in temporary main state and never enter Project provenance or the renderer. Cancel, refresh, selection, Offline Mode and renderer revocation discard the candidate set. Failed bodies are not written to disk. Selected lyrics remain in Project-owned revisions and follow existing Library/Trash retention.

Genius is an explicit browser search link only. The application does not fetch Genius pages, lyrics or credentials. Human and automatic YouTube tracks have different provider identities; automatic text carries a notice. Provider errors remain a recoverable lyrics status and do not stop local work.

## Provider evidence and limitations

- [LRCLIB documentation](https://lrclib.net/docs) and [search response implementation](https://github.com/tranxuanthang/lrclib/blob/main/server/src/routes/search_lyrics.rs): search returns metadata plus optional plain/synced text. No candidate is chosen from its title alone.
- [YouTube captions download API](https://developers.google.com/youtube/v3/docs/captions/download): the official download API requires authorization and permission to edit the video; this implementation does not use it.
- [yt-dlp YouTube extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py): public player metadata distinguishes caption tracks and automatic speech-recognition tracks. Open Chords only reads bounded data from an explicit public watch request and, on selection, the validated timedtext endpoint. It does not execute page scripts, launch an extractor, solve challenges or add credential/acquisition fallbacks. Missing metadata, blocked captions and overlapping automatic cues can return unavailable.

Deterministic HTTP fixtures establish policy, parsing and retention behavior; they do not prove current provider availability or lyric correctness. Installed tests establish the local durable UI/IPC path. Alignment accuracy, accessible release claims and official Support Claims remain their separate gates.
