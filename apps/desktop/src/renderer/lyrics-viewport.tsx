/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions -- A named scroll region needs native keyboard scrolling. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { PlaybackClock } from "./playback-clock.ts";
import type { WorkspaceContent } from "./workspace-content.ts";

export function LyricsViewport({
  content,
  clock,
}: {
  content: WorkspaceContent;
  clock: PlaybackClock | null;
}) {
  const [follow, setFollow] = useState(true);
  const viewportRef = useRef<HTMLElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const timed = useMemo(
    () =>
      [...content.lines, ...content.instrumentals].filter(
        (block) => block.startSample !== null && block.endSample !== null,
      ),
    [content],
  );
  const select = useCallback(
    (position: number) =>
      timed.find((block) => position >= block.startSample! && position < block.endSample!)?.id ??
      null,
    [timed],
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      clock?.subscribeSelection(({ positionSamples }) => select(positionSamples), listener) ??
      (() => undefined),
    [clock, select],
  );
  const getSnapshot = useCallback(
    () => select(clock?.getSnapshot().positionSamples ?? 0),
    [clock, select],
  );
  const currentId = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!follow || currentId === null) return;
    const viewport = viewportRef.current;
    const line = elements.current.get(currentId);
    if (viewport === null || line === undefined) return;
    const outer = viewport.getBoundingClientRect();
    const inner = line.getBoundingClientRect();
    if (inner.top >= outer.top && inner.bottom <= outer.bottom) return;
    viewport.scrollTo({
      top: viewport.scrollTop + inner.top - outer.top - viewport.clientHeight / 3,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, [currentId, follow]);

  const blocks = useMemo(() => {
    let precedingTime = 0;
    return [
      ...content.lines.map((line) => {
        precedingTime = line.startSample ?? precedingTime;
        return { kind: "lyric" as const, value: line, order: precedingTime };
      }),
      ...content.instrumentals.map((section) => ({
        kind: "instrumental" as const,
        value: section,
        order: section.startSample,
      })),
    ].toSorted((left, right) => left.order - right.order);
  }, [content]);

  return (
    <>
      <button
        className="secondary-button lyrics-follow"
        type="button"
        aria-pressed={follow}
        onClick={() => setFollow(!follow)}
      >
        Follow lyrics
      </button>
      <section
        className="lyrics-viewport"
        aria-label="Lyrics viewport"
        tabIndex={0}
        ref={viewportRef}
        onWheel={() => setFollow(false)}
        onPointerDown={() => setFollow(false)}
        onKeyDown={(event) => {
          if (
            ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
          )
            setFollow(false);
        }}
      >
        {content.lines.length === 0 ? (
          <div className="instrumental-message">
            <strong>Instrumental or no Reference Lyrics</strong>
            <p>The chord timeline remains available without fabricating lyrical content.</p>
          </div>
        ) : null}
        {blocks.map((block) => (
          <div
            key={block.value.id}
            className="lyric-block"
            data-current={currentId === block.value.id ? "true" : undefined}
            aria-current={currentId === block.value.id ? "true" : undefined}
            ref={(element) => {
              if (element === null) elements.current.delete(block.value.id);
              else elements.current.set(block.value.id, element);
            }}
          >
            {block.kind === "lyric" ? (
              <>
                <fieldset aria-label={block.value.text} className="lyric-line">
                  {block.value.prefix}
                  {block.value.tokens.map((token) => (
                    <span className="lyric-token" key={token.id}>
                      <span className="word-chords">{token.chordLabels.join(" · ")}</span>
                      <span>
                        {token.text}
                        {token.suffix}
                      </span>
                    </span>
                  ))}
                </fieldset>
                <span className="lyric-timing">
                  {block.value.state === "untimed"
                    ? "Untimed"
                    : block.value.state === "low_confidence"
                      ? "Timing needs review"
                      : "Timed"}
                </span>
              </>
            ) : (
              <>
                <strong>{block.value.label} · chord section</strong>
                <p>{block.value.chordLabels.join(" · ")}</p>
              </>
            )}
            {block.value.startSample !== null ? (
              <button
                type="button"
                className="quiet-button"
                aria-label={`Seek to ${block.kind === "lyric" ? block.value.text : block.value.label}`}
                onClick={() => clock?.seek(block.value.startSample!)}
              >
                Seek here
              </button>
            ) : null}
          </div>
        ))}
      </section>
    </>
  );
}
