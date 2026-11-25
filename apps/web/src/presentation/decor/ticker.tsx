import { Fragment } from "react";
import { cn } from "../components/ui/cn";

// Only the words written on the logo may run in the band (DESIGN, "このファイルの文章をページに載せない").
const LOGO_WORDS = ["off-r39x", "おふりみっくす", "in 大阪らへん", "2027"] as const;
// One group is wider than the widest screen; the track holds two, so moving it by half loops without a seam.
const RUN = [...LOGO_WORDS, ...LOGO_WORDS, ...LOGO_WORDS];

/**
 * The running band (DESIGN 8.7, 12): a coral band tilted -2deg across a section boundary, the logo words separated
 * by stars, one lap per 80 beats. It stops while hovered or focused and stands still under reduced motion. One per
 * page. Focusable, named by its words; the moving copies are hidden from assistive technology.
 */
export function Ticker({ className }: { className?: string }) {
  return (
    <div className={cn("ticker", className)}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: DESIGN 12 makes the band focusable so focus can stop it */}
      <div role="marquee" tabIndex={0} aria-label={LOGO_WORDS.join(" ")} className="ticker__band">
        <div className="ticker__track" aria-hidden="true">
          {[0, 1].map((group) => (
            <span key={group} className="ticker__group">
              {RUN.map((word, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sequence of words, in order
                <Fragment key={index}>
                  <span>{word}</span>
                  <span>★</span>
                </Fragment>
              ))}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
