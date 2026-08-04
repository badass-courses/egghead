"use client";

import { useRef } from "react";

import { useLessonProgress } from "../progress/lesson-progress-provider";
import { usePauseWhenHidden } from "./use-pause-when-hidden";

export function LessonHtmlVideo({
  accessState,
  lessonResourceId,
  poster,
  src,
  title,
}: {
  accessState: "free" | "granted";
  lessonResourceId: string;
  poster: string | undefined;
  src: string;
  title: string;
}) {
  const { completeLesson } = useLessonProgress();
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
      onEnded={() => {
        void completeLesson(lessonResourceId);
      }}
      poster={poster}
      preload="metadata"
      src={src}
    >
      <track kind="captions" />
    </video>
  );
}
