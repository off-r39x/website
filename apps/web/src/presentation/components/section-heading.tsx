import type { ReactNode } from "react";
import { cn } from "./ui/cn";

// A section's heading names its region through aria-labelledby (SPEC-050 25). It does not fade in: DESIGN 9.1 / 13
// keep text still and let only logo-derived decorations move, which SPEC-050 25 allows ("may fade in"). The
// heading therefore stays in the contract's `static` state (tests/contracts/s10-header-float-reveal.md 6).

export function SectionHeading({
  id,
  level = 2,
  children,
  className,
}: {
  id: string;
  level?: 2 | 3;
  children: ReactNode;
  className?: string;
}) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <Tag
      id={id}
      data-reveal="static"
      className={cn(level === 2 ? "text-h2" : "text-h3", className)}
    >
      {children}
    </Tag>
  );
}
