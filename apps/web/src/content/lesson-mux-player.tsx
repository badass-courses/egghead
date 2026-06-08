"use client";

import MuxPlayer from "@mux/mux-player-react/lazy";

export function LessonMuxPlayer({
  playbackId,
  title,
  videoId,
}: {
  playbackId: string;
  title: string;
  videoId: string;
}) {
  return (
    <MuxPlayer
      className="egghead-video"
      data-video-state="allowed"
      defaultHiddenCaptions
      maxResolution="2160p"
      metadata={{
        video_id: videoId,
        video_title: title,
      }}
      minResolution="540p"
      playbackId={playbackId}
      playbackRates={[0.75, 1, 1.25, 1.5, 1.75, 2]}
      streamType="on-demand"
      thumbnailTime={0}
    />
  );
}
