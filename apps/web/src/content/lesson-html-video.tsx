"use client";

import { useRef } from "react";

import { usePauseWhenHidden } from "./use-pause-when-hidden";

export function LessonHtmlVideo({
  accessState,
  poster,
  src,
  title,
}: {
  accessState: "free" | "granted";
  poster: string | undefined;
  src: string;
  title: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  usePauseWhenHidden(videoRef);

  return (
    <video
      ref={videoRef}
      aria-label={`${title} video`}
      className="egghead-video"
      controls
      data-access-state={accessState}
      data-video-state="allowed"
      poster={poster}
      preload="metadata"
      src={src}
    >
      <track kind="captions" />
    </video>
  );
}
