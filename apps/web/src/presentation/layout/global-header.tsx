"use client";

import { useCallback } from "react";
import { assets } from "../../config/assets";
import { CTA_HREF, GUEST_ACCOUNT_LINKS, MYPAGE_HREF, SITE_NAME } from "../../config/site";
import { Link } from "../../routing/link";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { copy } from "../copy/ja";
import { AccountMenu } from "./account-menu";
import { CartLink } from "./cart-link";
import { HeaderMenu } from "./header-menu";
import { SiteNameLink } from "./site-name-link";

export type HeaderSession = "loading" | "guest" | "authenticated";

type Props = {
  cartCount: number | null;
  session: HeaderSession;
  pathname: string;
  onLogout: () => void;
};

const plainLinkClass = "site-header__plain text-small md:text-body";

const LOGIN = GUEST_ACCOUNT_LINKS.find((link) => link.key === "login");
const REGISTER = GUEST_ACCOUNT_LINKS.find((link) => link.key === "register");

/** Sets <html data-scrolled> once the page has left its top, from a sentinel (IntersectionObserver, DESIGN 8.3). */
function useScrolledSentinel() {
  return useCallback((element: HTMLSpanElement | null) => {
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const root = document.documentElement;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) delete root.dataset.scrolled;
      else root.dataset.scrolled = "true";
    });
    io.observe(element);
    return () => {
      io.disconnect();
      delete root.dataset.scrolled;
    };
  }, []);
}

/**
 * Global Header (SPEC-050 8.5, DESIGN 8.3). DOM order is the Tab order: site name, the menu button, the main CTA,
 * Cart, then the account area. The logo is a 120px sticker hanging below the bar at the left; CTA, Cart and the
 * account links stay on the bar on every viewport (SPEC-050 8.5), so on a narrow screen the bar wraps instead of
 * hiding them behind the menu as DESIGN 8.3 would.
 */
export function GlobalHeader({ cartCount, session, pathname, onLogout }: Props) {
  const sentinel = useScrolledSentinel();
  return (
    <>
      <span
        ref={sentinel}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 h-px w-px"
      />
      <header className="site-header">
        <div className="site-header__inner">
          <SiteNameLink pathname={pathname} className="site-header__home">
            {assets.logo === null ? (
              SITE_NAME
            ) : (
              <>
                <img
                  src={assets.logo.src}
                  alt={assets.logo.alt}
                  width={assets.logo.width}
                  height={assets.logo.height}
                  decoding="async"
                  className="site-header__logo"
                />
                <span className="site-header__name">{SITE_NAME}</span>
              </>
            )}
          </SiteNameLink>
          <HeaderMenu currentPath={pathname} showRegister={session !== "authenticated"} />
          <Link
            prefetch={false}
            href={CTA_HREF}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-md:px-2 max-md:text-small max-md:tracking-normal")}
          >
            {copy.layout.cta.buyTickets}
          </Link>
          <CartLink count={cartCount} className={plainLinkClass} />
          {session === "authenticated" ? (
            <>
              <Link prefetch={false} href={MYPAGE_HREF} className={plainLinkClass}>
                {copy.layout.account.mypage}
              </Link>
              <AccountMenu onLogout={onLogout} />
            </>
          ) : null}
          {session === "guest" && LOGIN !== undefined ? (
            <Link prefetch={false} href={LOGIN.href} className={plainLinkClass}>
              {copy.layout.account.login}
            </Link>
          ) : null}
          {session === "guest" && REGISTER !== undefined ? (
            <Link
              prefetch={false}
              href={REGISTER.href}
              className={cn(plainLinkClass, "hidden md:inline-flex")}
            >
              {copy.layout.account.register}
            </Link>
          ) : null}
        </div>
      </header>
    </>
  );
}
