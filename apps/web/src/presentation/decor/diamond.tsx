"use client";

import { type CSSProperties, useId } from "react";
import { cn } from "../components/ui/cn";
import { useEnter } from "./use-enter";

const PATH = "M50 3 L97 50 L50 97 L3 50 Z";

/**
 * The broken double-line diamond frame (DESIGN 5.3, 9.5): black line plus the grey line shifted up-right, drawn in
 * from a gap when it enters the view. Written in place (not <use>) so the ink surface can recolour it and each mask
 * id stays unique. Always decorative.
 */
export function Diamond({
  className,
  parallax = false,
  introDelay,
}: {
  className?: string;
  parallax?: boolean;
  introDelay?: number;
}) {
  const ref = useEnter<SVGSVGElement>();
  // useId may contain characters that url(#…) would need escaped.
  const maskId = `dm${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const svg = (
    <svg
      ref={ref}
      className={cn("diamond", !parallax && className)}
      viewBox="0 0 100 100"
      data-enter="draw"
      data-intro={introDelay === undefined ? undefined : ""}
      style={
        introDelay === undefined
          ? undefined
          : ({ "--intro-delay": `${introDelay}ms` } as CSSProperties)
      }
      aria-hidden="true"
      focusable="false"
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
        <path className="draw" d={PATH} pathLength={100} fill="none" strokeWidth={14} />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          className="diamond__back"
          d={PATH}
          fill="none"
          strokeWidth={5}
          transform="translate(3 -3)"
        />
        <path
          className="diamond__front"
          d={PATH}
          pathLength={100}
          fill="none"
          strokeWidth={5}
          strokeDasharray="0 4 30 6 40 5 15"
        />
      </g>
    </svg>
  );
  // The parallax drift moves a wrapper, never the drawn svg itself (DESIGN 9.3, 9.6).
  if (!parallax) return svg;
  return (
    <span className={cn("parallax block", className)} aria-hidden="true">
      {svg}
    </span>
  );
}
