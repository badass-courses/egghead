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
  const sizeClass = size === "narrow" ? "max-w-3xl" : "max-w-6xl";

  return (
    <Component
      className={cn("mx-auto w-full px-4 py-12 sm:px-6 sm:py-16 lg:px-8", sizeClass, className)}
      {...props}
    />
  );
}
