"use client";

import type { CSSProperties } from "react";
import { cn } from "../components/ui/cn";
import { useEnter } from "./use-enter";

// Tapered parallel lines, shorter from top to bottom, slanted tips (DESIGN 5.5). One polygon per line so each one
// flies in on its own (DESIGN 9.5).
const LINES = [
  "M0 0 H200 L190 8 H0Z",
  "M0 14 H160 L150 22 H0Z",
  "M0 28 H120 L110 36 H0Z",
  "M0 42 H80 L70 50 H0Z",
];

export function SpeedLines({
  className,
  width = 160,
  introDelay,
}: {
  className?: string;
  width?: number;
  introDelay?: number;
}) {
  const ref = useEnter<SVGSVGElement>();
  return (
    <svg
      ref={ref}
      className={cn("speed", className)}
      viewBox="0 0 200 50"
      width={width}
      height={width / 4}
      data-enter="speed"
      data-intro={introDelay === undefined ? undefined : ""}
      style={
        introDelay === undefined
          ? undefined
          : ({ "--intro-delay": `${introDelay}ms` } as CSSProperties)
      }
      aria-hidden="true"
      focusable="false"
    >
      {LINES.map((d, index) => (
        <path key={d} d={d} style={{ "--i": index } as CSSProperties} />
      ))}
    </svg>
  );
}
