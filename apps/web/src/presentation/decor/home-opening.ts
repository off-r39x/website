"use client";

import { type RefObject, useLayoutEffect } from "react";

// Home opening (DESIGN 9.4): runs only while <html> has .is-intro, set before first paint by public/motion-init.js
// (never under reduced motion or without IntersectionObserver). It measures how far each opening sticker flies from
// the logo centre (--fx / --fy, before the entrance observer marks it .is-in), adds the shockwave diamonds and the
// particles behind the logo, then removes them and marks the opening as seen.

const WAVE_START = 800;
const WAVE_STEP = 200;
const BIT_START = 900;
const OPENING_END = 3200;
const BIT_KINDS = ["star", "kira", "chip"] as const;
const CHIP_COLORS = ["lemon", "mint", "teal", "coral"] as const;
const BIT_SIZES = [28, 42, 56] as const;
const BIT_COUNT = 20;
const SVG_NS = "http://www.w3.org/2000/svg";

function waveSvg(color: "coral" | "ink", delay: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "burst burst--wave");
  svg.setAttribute("style", `overflow:visible;--wave-delay:${delay}ms`);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M50 3 L97 50 L50 97 L3 50 Z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-width", "4");
  path.setAttribute("style", `stroke:var(--${color})`);
  svg.append(path);
  return svg;
}

/** Deterministic particle n of BIT_COUNT: no randomness, the same burst every time (DESIGN 9.4). */
function bitSvg(index: number, logoWidth: number): SVGSVGElement {
  const kind = BIT_KINDS[index % BIT_KINDS.length] ?? "star";
  const size = BIT_SIZES[index % BIT_SIZES.length] ?? 28;
  const angle = (index / BIT_COUNT) * Math.PI * 2 + (index % 2) * 0.2;
  const distance = logoWidth * (0.5 + ((index * 7) % 10) * 0.04);
  const turn = (90 + ((index * 53) % 286)) * (index % 2 === 0 ? 1 : -1);
  const delay = BIT_START + (index % 3) * 80;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "burst burst--bit");
  const chipColor = CHIP_COLORS[Math.floor(index / 3) % CHIP_COLORS.length] ?? "lemon";
  svg.setAttribute(
    "style",
    [
      `--size:${size}px`,
      `--bx:${Math.round(Math.cos(angle) * distance)}px`,
      `--by:${Math.round(Math.sin(angle) * distance)}px`,
      `--br:${turn}deg`,
      `--bit-delay:${delay}ms`,
      "overflow:visible",
      kind === "chip" ? `color:var(--${chipColor})` : "color:var(--ink)",
    ].join(";"),
  );
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${kind}`);
  svg.append(use);
  return svg;
}

export function useHomeOpening(
  stageRef: RefObject<HTMLElement | null>,
  burstRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const stage = stageRef.current;
    const burst = burstRef.current;
    if (!root.classList.contains("is-intro") || stage === null || burst === null) return;

    const box = stage.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    for (const sticker of stage.parentElement?.querySelectorAll<HTMLElement>(
      "[data-intro][data-enter='sticker']",
    ) ?? []) {
      const own = sticker.getBoundingClientRect();
      sticker.style.setProperty("--fx", `${Math.round(cx - (own.left + own.width / 2))}px`);
      sticker.style.setProperty("--fy", `${Math.round(cy - (own.top + own.height / 2))}px`);
    }

    burst.append(waveSvg("coral", WAVE_START), waveSvg("ink", WAVE_START + WAVE_STEP));
    for (let index = 0; index < BIT_COUNT; index += 1) burst.append(bitSvg(index, box.width));

    const done = window.setTimeout(() => {
      burst.replaceChildren();
      root.classList.replace("is-intro", "intro-seen");
    }, OPENING_END);
    return () => {
      window.clearTimeout(done);
      burst.replaceChildren();
      root.classList.replace("is-intro", "intro-seen");
    };
  }, [stageRef, burstRef]);
}
