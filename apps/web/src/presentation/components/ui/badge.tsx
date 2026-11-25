import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

// A Badge always carries text: colour (the tone) is never the only signal (SPEC-050 25).
export const badgeVariants = cva("chip shrink-0", {
  variants: {
    tone: {
      success: "bg-tone-success-bg text-tone-success-fg",
      pending: "bg-tone-pending-bg text-tone-pending-fg",
      failure: "bg-tone-failure-bg text-tone-failure-fg",
      neutral: "bg-tone-neutral-bg text-tone-neutral-fg",
      review: "bg-tone-review-bg text-tone-review-fg",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}
