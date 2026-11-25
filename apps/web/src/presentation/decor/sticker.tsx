"use client";

import type { CSSProperties } from "react";
import { cn } from "../components/ui/cn";
import { useEnter } from "./use-enter";

export type StickerKind = "star" | "kira" | "note" | "chip";
export type ChipColor = "lemon" | "mint" | "teal" | "coral";

type Props = {
  kind: StickerKind;
  /** Tilt in degrees, -15..15; never the same angle twice on one screen (DESIGN 5.4, 8.6). */
  tilt: number;
  /** Order inside its section, for the staggered entrance (DESIGN 9.5). */
  index?: number;
  /** Size in px. */
  size: number;
  /** Kira blink group 0 / 1 / 2 (DESIGN 9.6). */
  group?: 0 | 1 | 2;
  /** Fill of a small diamond sticker. */
  color?: ChipColor;
  className?: string;
  /** Home opening start time in ms (DESIGN 9.4). */
  introDelay?: number;
};

const LOOP: Record<StickerKind, string | undefined> = {
  star: undefined,
  kira: "kira-loop",
  note: "note-loop",
  chip: undefined,
};

/**
 * A decorative sticker: the outer span carries tilt, entrance and hover wobble; the inner svg carries the
 * constant loop (two layers, DESIGN 9.3). Always aria-hidden: it never holds meaning (DESIGN 8.6, 12).
 */
export function Sticker({
  kind,
  tilt,
  index = 0,
  size,
  group,
  color = "lemon",
  className,
  introDelay,
}: Props) {
  const ref = useEnter<HTMLSpanElement>();
  const style = {
    "--tilt": `${tilt}deg`,
    "--i": index,
    width: size,
    height: size,
    ...(introDelay === undefined ? {} : { "--intro-delay": `${introDelay}ms` }),
  } as CSSProperties;
  return (
    <span
      ref={ref}
      className={cn("sticker", className)}
      data-enter="sticker"
      data-intro={introDelay === undefined ? undefined : ""}
      style={style}
      aria-hidden="true"
    >
      <svg
        className={LOOP[kind]}
        style={
          {
            ...(group === undefined ? {} : { "--g": group }),
            ...(kind === "chip" ? { color: `var(--${color})` } : {}),
          } as CSSProperties
        }
        aria-hidden="true"
        focusable="false"
      >
        <use href={`#${kind}`} />
      </svg>
    </span>
  );
}
