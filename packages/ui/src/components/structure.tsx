import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../utils";

const stackGap = {
  loose: "gap-10",
  normal: "gap-6",
  tight: "gap-3",
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
    <header className="grid gap-4">
      {eyebrow ? (
        <p className="m-0 text-[0.8125rem] font-semibold leading-tight tracking-normal text-muted-foreground uppercase">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="m-0 max-w-4xl text-3xl font-semibold leading-tight tracking-normal text-foreground sm:text-4xl">
        {title}
      </h1>
      {description ? (
        <p className="m-0 max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg">
          {description}
        </p>
      ) : null}
    </header>
  );
}
