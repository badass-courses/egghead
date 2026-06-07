import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../utils";

export function Stack({
  gap = "normal",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  gap?: "tight" | "normal" | "loose";
}) {
  return <div className={cn("egghead-stack", `egghead-stack-${gap}`, className)} {...props} />;
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
    <header className="egghead-section-header">
      {eyebrow ? <p className="egghead-eyebrow">{eyebrow}</p> : null}
      <h1>{title}</h1>
      {description ? <p className="egghead-section-description">{description}</p> : null}
    </header>
  );
}
