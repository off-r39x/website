import type { ReactNode } from "react";
import { Sticker } from "../decor/sticker";
import { cn } from "./ui/cn";

/**
 * The page's black surface for a state that has no other one (DESIGN 3.2, 7.1): a full-bleed band holding the
 * state's own content. The one sticker crosses the top edge, clear of the text (DESIGN 7.3); it is desktop-only so
 * a narrow viewport stays within two stickers next to the hero's (DESIGN 7.2).
 */
export function InkBand({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("surface-ink bleed section-y relative", className)}>
      <Sticker
        kind="chip"
        color="lemon"
        tilt={-5}
        size={48}
        className="absolute -top-6 right-[max(var(--page-x),calc((100vw-var(--content-max))/2))] hidden md:inline-block"
      />
      <div className="measure flex flex-col items-start gap-6">{children}</div>
    </div>
  );
}
