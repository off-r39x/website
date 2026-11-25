import type { ReactNode } from "react";
import { cn } from "../components/ui/cn";
import { CandyHeading } from "./candy-heading";
import { Diamond } from "./diamond";
import { SpeedLines } from "./speed-lines";
import { Sticker } from "./sticker";

/**
 * Lower page hero (DESIGN 6.4): half a diamond frame peeking at the top right, the page title in candy lettering,
 * speed lines under it and at most two stickers kept away from the text. `children` is the short description.
 */
export function PageHero({
  title,
  titleId,
  titleTabIndex,
  children,
  className,
}: {
  title: string;
  titleId?: string;
  titleTabIndex?: number;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("page-hero", className)}>
      <Diamond className="page-hero__diamond" parallax />
      <div className="page-hero__stickers">
        <Sticker
          kind="kira"
          tilt={-12}
          index={0}
          size={44}
          group={0}
          className="absolute top-2 right-0 md:right-24"
        />
        <Sticker
          kind="star"
          tilt={9}
          index={1}
          size={40}
          className="absolute right-12 bottom-0 hidden md:inline-block"
        />
      </div>
      <CandyHeading text={title} id={titleId} tabIndex={titleTabIndex} />
      <SpeedLines />
      {children === undefined ? null : (
        <div className="measure flex flex-col gap-3">{children}</div>
      )}
    </div>
  );
}
