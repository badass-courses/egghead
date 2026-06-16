"use client";

import MuxPlayer from "@mux/mux-player-react";
import { useRef, type ComponentRef } from "react";

import { useMuxPlayer } from "./mux-player-context";
import { usePauseWhenHidden } from "./use-pause-when-hidden";

export function LessonMuxPlayer({
  playbackId,
  poster,
  title,
  videoId,
}: {
  playbackId: string;
  poster: string | null;
  title: string;
  videoId: string;
}) {
  const localPlayerRef = useRef<ComponentRef<typeof MuxPlayer>>(null);
  // Prefer the shared ref (so the transcript can seek this player); fall
  // back to a local ref on pages rendered without the provider.
  const playerRef = useMuxPlayer()?.muxPlayerRef ?? localPlayerRef;

  usePauseWhenHidden(playerRef);

  return (
    <MuxPlayer
      ref={playerRef}
      // Remount per video: client-side navigation between lessons can
      // reuse this component instance, and mux-player keeps the old
      // stream's audio running when playback-id changes mid-playback.
      key={playbackId}
      className="egghead-video breakout"
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
      {...(poster ? { placeholder: poster, poster } : {})}
      preload="metadata"
      streamType="on-demand"
      thumbnailTime={0}
    />
  );
}
