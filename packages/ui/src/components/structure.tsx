import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../utils";

const stackGap = {
  tight: "gap-3",
  normal: "gap-6",
  loose: "gap-flow",
} as const;

export function Stack({
  gap = "normal",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  gap?: "tight" | "normal" | "loose";
}) {
  return <div className={cn("flex flex-col", stackGap[gap], className)} {...props} />;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <header className="grid gap-3">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h1 className="text-balance text-4xl font-extrabold tracking-tight">{title}</h1>
      {description ? (
        <p className="max-w-prose text-pretty text-lg text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}
