// Shared sticker shapes (DESIGN 5.4, 8.6), defined once per document and drawn with <use>. Mounted by the root layout.
// Colours go through style (a var() in an SVG presentation attribute is ignored by some browsers).

export function DecorSymbols() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <g id="note-shape">
          <ellipse cx="34" cy="76" rx="18" ry="13" transform="rotate(-22 34 76)" />
          <path d="M44 12 h9 v62 h-9z" />
          <path d="M44 8 h9 c2 14 24 16 28 36 c2 10 -2 20 -8 26 c2 -14 -6 -24 -20 -28z" />
        </g>
      </defs>
      <symbol id="star" viewBox="-6 -6 112 112">
        <path
          d="M50 4 L61.2 34.6 L93.7 35.8 L68.1 55.9 L77 87.2 L50 69 L23 87.2 L31.9 55.9 L6.3 35.8 L38.8 34.6Z"
          style={{
            fill: "var(--ink)",
            stroke: "var(--paper)",
            strokeWidth: 8,
            strokeLinejoin: "round",
            paintOrder: "stroke",
          }}
        />
      </symbol>
      <symbol id="kira" viewBox="-6 -6 112 112">
        <path
          d="M50 0 C54 36 64 46 100 50 C64 54 54 64 50 100 C46 64 36 54 0 50 C36 46 46 36 50 0Z"
          style={{
            fill: "currentColor",
            stroke: "var(--paper)",
            strokeWidth: 8,
            strokeLinejoin: "round",
            paintOrder: "stroke",
          }}
        />
      </symbol>
      <symbol id="chip" viewBox="-6 -6 112 112">
        <path
          d="M50 4 L96 50 L50 96 L4 50Z"
          style={{
            fill: "currentColor",
            stroke: "var(--ink)",
            strokeWidth: 10,
            strokeLinejoin: "round",
          }}
        />
      </symbol>
      <symbol id="note" viewBox="-14 -6 124 120">
        <use
          href="#note-shape"
          style={{
            fill: "var(--paper)",
            stroke: "var(--paper)",
            strokeWidth: 24,
            strokeLinejoin: "round",
          }}
        />
        <use
          href="#note-shape"
          style={{
            fill: "var(--ink)",
            stroke: "var(--ink)",
            strokeWidth: 8,
            strokeLinejoin: "round",
          }}
        />
        <use href="#note-shape" style={{ fill: "var(--coral)" }} />
      </symbol>
    </svg>
  );
}
