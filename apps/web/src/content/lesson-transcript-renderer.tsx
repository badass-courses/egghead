"use client";

import type { MuxPlayerRefAttributes } from "@mux/mux-player-react";
import React from "react";
import ReactMarkdown from "react-markdown";

import { useMuxPlayer } from "./mux-player-context";

/* Ported from ai-hero's video-transcript-renderer. Renders the stored
   transcript markdown and turns its `[MM:SS]` / `[HH:MM:SS]` timestamps
   into buttons that seek the shared Mux player. */
export function LessonTranscriptBody({ transcript }: { transcript: string }) {
  const muxPlayerRef = useMuxPlayer()?.muxPlayerRef ?? null;

  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => paragraphWithTimestampButtons({ children, muxPlayerRef }),
      }}
    >
      {transcript}
    </ReactMarkdown>
  );
}

const TIMESTAMP = /\[(\d+:\d+(?::\d+)?)\]/g;

function paragraphWithTimestampButtons({
  children,
  muxPlayerRef,
}: {
  children: React.ReactNode;
  muxPlayerRef: React.RefObject<MuxPlayerRefAttributes | null> | null;
}) {
  const elements = React.Children.toArray(children);
  const updatedChildren = elements.map((child) => {
    if (typeof child !== "string") return child;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    for (const match of child.matchAll(TIMESTAMP)) {
      const timestamp = match[1] ?? "";
      const matchIndex = match.index ?? 0;

      const beforeText = child.slice(lastIndex, matchIndex);
      if (beforeText) parts.push(beforeText);

      parts.push(
        <button
          key={`${timestamp}-${matchIndex}`}
          type="button"
          data-timestamp=""
          onClick={() => {
            if (muxPlayerRef?.current) {
              muxPlayerRef.current.currentTime = hmsToSeconds(timestamp);
              void muxPlayerRef.current.play();
              window.scrollTo({ top: 0 });
            }
          }}
        >
          {timestamp}
        </button>,
      );

      lastIndex = matchIndex + match[0].length;
    }

    if (lastIndex === 0) return child;

    const remainder = child.slice(lastIndex);
    if (remainder) parts.push(remainder);

    return <span key={`segment-${child}`}>{parts}</span>;
  });

  return <p>{updatedChildren}</p>;
}

export function hmsToSeconds(value: string) {
  const parts = value.split(":");
  let seconds = 0;
  let multiplier = 1;

  while (parts.length > 0) {
    seconds += multiplier * Number.parseInt(parts.pop() ?? "0", 10);
    multiplier *= 60;
  }

  return seconds;
}
