import type { ComponentPropsWithoutRef, ElementType } from "react";

import { cn } from "../utils";

type ContainerProps<T extends ElementType> = {
  as?: T;
  size?: "narrow" | "wide";
} & Omit<ComponentPropsWithoutRef<T>, "as">;

export function Container<T extends ElementType = "div">({
  as,
  size = "wide",
  className,
  ...props
}: ContainerProps<T>) {
  const Component = as ?? "div";

  return (
    <Component
      className={cn("egghead-container", `egghead-container-${size}`, className)}
      {...props}
    />
  );
}
