import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../utils";

/*
 * Tactile brand button from egghead-brand/components.html. The asymmetric
 * vertical padding compensates for the 3px bottom bevel in the shadow so
 * the label sits optically centered.
 */

const buttonVariant = {
  yolk: "bg-yolk-grad text-yolk-foreground border-yolk-shadow/40 shadow-btn hover:shadow-btn-hover",
  navy: "bg-navy-grad text-cream border-black/40 shadow-btn-navy",
  ghost: "bg-surface-grad text-foreground border-border-strong shadow-btn-ghost",
  rust: "bg-rust-grad text-cream border-rust-deep shadow-btn-rust",
} as const;

const buttonSize = {
  sm: "rounded-lg px-4 py-2 text-sm",
  default: "rounded-xl px-7 pt-[15px] pb-[13px]",
  lg: "rounded-full px-9 pt-[17px] pb-[15px] text-lg",
  icon: "size-12 rounded-xl",
} as const;

export type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: keyof typeof buttonVariant;
  size?: keyof typeof buttonSize;
};

export function Button({
  variant = "yolk",
  size = "default",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "press inline-flex cursor-pointer items-center justify-center gap-2.5 border font-extrabold",
        "disabled:cursor-not-allowed disabled:border-border-strong disabled:bg-well disabled:bg-none disabled:text-foreground/35 disabled:shadow-well",
        buttonVariant[variant],
        buttonSize[size],
        className,
      )}
      type={type}
      {...props}
    />
  );
}
