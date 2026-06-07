import type { ComponentPropsWithoutRef, ElementType } from "react";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

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

export function Stack({
  gap = "normal",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  gap?: "tight" | "normal" | "loose";
}) {
  return (
    <div
      className={cn("egghead-stack", `egghead-stack-${gap}`, className)}
      {...props}
    />
  );
}
