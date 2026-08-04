import { EggoMark } from "@egghead/ui/eggo-mark";
import { ImageResponse } from "next/og";

import { getPublicLearnerProfile } from "../../../profile/data";

export const alt = "Egghead learner profile";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

function imageDisplayName(name: string) {
  const normalizedName = name.trim().replace(/\s+/g, " ");
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const characters = Array.from(segmenter.segment(normalizedName), ({ segment }) => segment);
  return characters.length > 54 ? `${characters.slice(0, 53).join("")}…` : normalizedName;
}

function avatarBackgroundStyle(avatarUrl: string | null) {
  return avatarUrl ? { backgroundImage: `url("${avatarUrl}")` } : {};
}

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const profile = await getPublicLearnerProfile(publicId);
  const displayName = imageDisplayName(profile?.displayName ?? "Egghead learner");

  return new ImageResponse(
    <div
      style={{
        alignItems: "stretch",
        background: "linear-gradient(180deg, #243246 0%, #1e2a38 68%, #18222e 100%)",
        color: "#fdf8ec",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        overflow: "hidden",
        padding: "56px 64px 48px",
        position: "relative",
        width: "100%",
      }}
    >
      <div
        style={{
          background: "#f7c948",
          borderRadius: 999,
          display: "flex",
          height: 430,
          opacity: 0.12,
          position: "absolute",
          right: -155,
          top: -235,
          width: 430,
        }}
      />
      <div
        style={{
          border: "2px solid rgba(247, 201, 72, 0.2)",
          borderRadius: 999,
          bottom: -235,
          display: "flex",
          height: 440,
          left: -180,
          position: "absolute",
          width: 440,
        }}
      />

      <div
        style={{
          alignItems: "center",
          display: "flex",
          fontSize: 28,
          fontWeight: 800,
          gap: 16,
          letterSpacing: -0.5,
        }}
      >
        <EggoMark size={48} />
        <span>egghead</span>
      </div>

      <div style={{ alignItems: "center", display: "flex", flex: 1, gap: 42 }}>
        <div
          style={{
            alignItems: "center",
            background: "#f7c948",
            backgroundPosition: "center",
            backgroundSize: "cover",
            border: "5px solid #fdf8ec",
            borderRadius: 40,
            boxShadow: "0 8px 0 rgba(10, 17, 25, 0.42)",
            display: "flex",
            flexShrink: 0,
            height: 176,
            justifyContent: "center",
            overflow: "hidden",
            width: 176,
            ...avatarBackgroundStyle(profile?.avatarUrl ?? null),
          }}
        >
          {profile?.avatarUrl ? null : <EggoMark size={112} />}
        </div>

        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span
            style={{
              color: "#f7c948",
              display: "flex",
              fontSize: 18,
              fontWeight: 800,
              letterSpacing: 2.4,
              marginBottom: 12,
            }}
          >
            PUBLIC LEARNING PROFILE
          </span>
          <span
            style={{
              display: "flex",
              fontSize: displayName.length > 32 ? 52 : 64,
              fontWeight: 900,
              letterSpacing: -2.5,
              lineHeight: 1.04,
            }}
          >
            {displayName}
          </span>
        </div>
      </div>

      {/* Profile stats are intentionally hidden pending product review. */}
      <div
        style={{
          alignItems: "center",
          borderTop: "1px solid rgba(253, 248, 236, 0.24)",
          display: "flex",
          justifyContent: "space-between",
          paddingTop: 28,
        }}
      >
        <span
          style={{
            background: "#f7c948",
            borderRadius: 999,
            display: "flex",
            height: 5,
            width: 54,
          }}
        />
        <span style={{ color: "#9aabc0", display: "flex", fontSize: 18, fontWeight: 700 }}>
          egghead.io
        </span>
      </div>
    </div>,
    size,
  );
}
