import { EVENT_NAME, PRIMARY_NAV } from "../../config/site";
import { cn } from "../components/ui/cn";
import { copy } from "../copy/ja";
import { Sticker } from "../decor/sticker";
import { StretchText } from "../decor/stretch-text";
import { isFloatingTicketVisible } from "./floating-ticket-visibility";
import { PrimaryNav } from "./primary-nav";
import type { SponsorAreaModel } from "./sponsor-area-model";
import { SponsorLogos } from "./sponsor-logos";

type Props = { sponsors: SponsorAreaModel; pathname: string };

// The wordmark is a word written on the logo (DESIGN 8.4, the only text DESIGN lets decoration carry).
const WORDMARK = "off-r39x";

/**
 * Global Footer (SPEC-050 8.5, DESIGN 8.4): black surface with the event name, the five navigation links and,
 * when there is any, the Sponsor Logo area; the mint stretch wordmark is cut at the bottom.
 */
export function GlobalFooter({ sponsors, pathname }: Props) {
  return (
    <footer
      className={cn(
        "site-footer surface-ink",
        // Room for the Floating Ticket Button so it never covers a footer control.
        isFloatingTicketVisible(pathname) && "pb-[calc(4.5rem+env(safe-area-inset-bottom))]",
      )}
    >
      <Sticker
        kind="star"
        tilt={-9}
        size={56}
        className="absolute -top-7 right-[max(var(--page-x),calc((100vw-var(--content-max))/2))]"
      />
      <div className="mx-auto grid max-w-[calc(var(--content-max)+var(--page-x)*2)] grid-cols-2 gap-8 px-(--page-x) pt-16 pb-12 md:grid-cols-3">
        <p className="footer-heading col-span-2 md:col-span-1">{EVENT_NAME}</p>
        <PrimaryNav
          items={PRIMARY_NAV}
          label={copy.layout.nav.footerLabel}
          currentPath={pathname}
          orientation="column"
          listClassName="gap-y-0"
          linkClassName="link footer-link"
        />
        {sponsors.kind === "visible" ? (
          <div className="col-span-2 md:col-span-1">
            <SponsorLogos items={sponsors.items} />
          </div>
        ) : null}
      </div>
      <div className="mx-auto max-w-[calc(var(--content-max)+var(--page-x)*2)] px-(--page-x)">
        <StretchText text={WORDMARK} className="wordmark" />
      </div>
    </footer>
  );
}
