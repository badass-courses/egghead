import type { ComponentPropsWithoutRef, ElementType } from "react";

import { cn } from "../utils";

type ContainerProps<T extends ElementType> = {
  as?: T;
  size?: "narrow" | "wide";
} & Omit<ComponentPropsWithoutRef<T>, "as">;

/**
 * Page-level content grid. Children land in the reading-measure track by
 * default; opt out per child with `breakout` or `full-width`. Width comes
 * from CSS variables (`--content-max`), not props — `size` only picks a
 * preset. Vertical rhythm between children is built in via gap.
 */
export function Container<T extends ElementType = "div">({
  as,
  size = "narrow",
  className,
  ...props
}: ContainerProps<T>) {
  const Component = as ?? "div";

  return (
    <Component
      className={cn("content-grid gap-y-flow py-section", className)}
      data-width={size}
      {...props}
    />
  );
}
