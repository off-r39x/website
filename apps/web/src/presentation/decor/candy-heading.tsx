"use client";

import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../components/ui/cn";
import { useEnter } from "./use-enter";

type Props = {
  text: string;
  level?: 1 | 2;
  id?: string | undefined;
  className?: string | undefined;
  tabIndex?: number | undefined;
};

function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(
      new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
      (s) => s.segment,
    );
  }
  return Array.from(text);
}

/** True while the heading wraps to three lines or more; re-measured when its box changes (width, font load). */
function useOverTwoLines(ref: { current: HTMLElement | null }, text: string): boolean {
  const [over, setOver] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text must be measured again
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      if (!(lineHeight > 0)) return;
      setOver(Math.round(element.getBoundingClientRect().height / lineHeight) > 2);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text]);
  return over;
}

/**
 * Candy lettering (DESIGN 5.1) for a lower page h1, a big date or one ink-surface h2. The heading element holds the
 * text exactly once, so its accessible name and text stay those of a plain heading; the visible layers (white edge,
 * black line, coral offset, candy face split per character for the gloss) are aria-hidden copies stacked over it.
 * The face never moves; only the offset and the gloss play on entrance (DESIGN 9.5).
 * Candy lettering is for headings of at most two lines (DESIGN 5.1): a longer text (a long announcement title or
 * goods name on a narrow screen) drops the layers and stays a plain display heading of the same size, so the line
 * count measured on the heading itself does not change with the switch.
 */
export function CandyHeading({ text, level = 1, id, className, tabIndex }: Props) {
  const ref = useEnter<HTMLDivElement>();
  const textRef = useRef<HTMLHeadingElement>(null);
  const plain = useOverTwoLines(textRef, text);
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <div ref={ref} className={cn("candy", plain && "candy--plain", className)}>
      <span className="candy__edge" aria-hidden="true">
        {text}
      </span>
      <span className="candy__line candy__line--off" aria-hidden="true">
        {text}
      </span>
      <span className="candy__line" aria-hidden="true">
        {text}
      </span>
      <span className="candy__off" aria-hidden="true">
        {text}
      </span>
      <span className="candy__face" aria-hidden="true">
        {graphemes(text).map((char, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: characters of the text, in order
          <span key={index} style={{ "--i": index } as CSSProperties}>
            {char}
          </span>
        ))}
      </span>
      <Tag ref={textRef} id={id} tabIndex={tabIndex} className="candy__text">
        {text}
      </Tag>
    </div>
  );
}
