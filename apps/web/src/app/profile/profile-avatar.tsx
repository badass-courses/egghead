"use client";

import Image from "next/image";
import { useState } from "react";

type ProfileAvatarProps = {
  alt: string;
  fallback: string;
  src: string;
};

function InitialAvatar({ initial }: { initial: string }) {
  return (
    <div className="grid size-16 shrink-0 place-items-center rounded-2xl border border-border-strong bg-navy-grad text-2xl font-black text-cream shadow-btn-navy sm:size-20 sm:text-3xl">
      {initial}
    </div>
  );
}

export function ProfileAvatar({ alt, fallback, src }: ProfileAvatarProps) {
  const [hasError, setHasError] = useState(false);

  if (hasError) return <InitialAvatar initial={fallback} />;

  return (
    <div className="relative size-16 shrink-0 overflow-hidden rounded-2xl border border-border-strong bg-navy-grad shadow-btn-navy sm:size-20">
      <Image
        alt={alt}
        className="size-full object-cover"
        height={80}
        onError={() => setHasError(true)}
        sizes="(min-width: 640px) 80px, 64px"
        src={src}
        width={80}
      />
    </div>
  );
}
