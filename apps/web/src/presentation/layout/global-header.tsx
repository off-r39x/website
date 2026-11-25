"use client";

import { useCallback } from "react";
import { assets } from "../../config/assets";
import {
  CTA_HREF,
  GUEST_ACCOUNT_LINKS,
  MYPAGE_HREF,
  PRIMARY_NAV,
  SITE_NAME,
} from "../../config/site";
import { Link } from "../../routing/link";
import { buttonVariants } from "../components/ui/button";
import { copy } from "../copy/ja";
import { AccountMenu } from "./account-menu";
import { CartLink } from "./cart-link";
import { HeaderMenu } from "./header-menu";
import { PrimaryNav } from "./primary-nav";
import { SiteNameLink } from "./site-name-link";

export type HeaderSession = "loading" | "guest" | "authenticated";

type Props = {
  cartCount: number | null;
  session: HeaderSession;
  pathname: string;
  onLogout: () => void;
};

const NAV_ITEMS = PRIMARY_NAV.filter((item) => item.collapsible);
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
 * Global Header (SPEC-050 8.5, DESIGN 8.3): a white bar, 72px (60px narrow). The logo is a 120px sticker 4px from
 * the top, hanging below the bar at the left; it is hidden (slot kept) while the Home hero shows the logo. Wide
 * screens keep the navigation, Cart, the account area and the secondary CTA on the bar, in that Tab order; narrow
 * screens hide them (display: none) and show only the menu button, whose dialog holds the same destinations.
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
              <span className="site-header__name">{SITE_NAME}</span>
            ) : (
              <img
                src={assets.logo.src}
                alt={assets.logo.alt}
                width={assets.logo.width}
                height={assets.logo.height}
                decoding="async"
                className="site-header__logo"
              />
            )}
          </SiteNameLink>
          <div className="site-header__bar">
            <PrimaryNav
              items={NAV_ITEMS}
              label={copy.layout.nav.primaryLabel}
              currentPath={pathname}
              listClassName="flex-nowrap"
              linkClassName="site-nav__link"
            />
            <CartLink count={cartCount} className="site-nav__link" />
            {session === "authenticated" ? (
              <>
                <Link prefetch={false} href={MYPAGE_HREF} className="site-nav__link">
                  {copy.layout.account.mypage}
                </Link>
                <AccountMenu onLogout={onLogout} />
              </>
            ) : null}
            {session === "guest" && LOGIN !== undefined ? (
              <Link prefetch={false} href={LOGIN.href} className="site-nav__link">
                {copy.layout.account.login}
              </Link>
            ) : null}
            {session === "guest" && REGISTER !== undefined ? (
              <Link prefetch={false} href={REGISTER.href} className="site-nav__link">
                {copy.layout.account.register}
              </Link>
            ) : null}
            <Link
              prefetch={false}
              href={CTA_HREF}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {copy.layout.cta.buyTickets}
            </Link>
          </div>
          <HeaderMenu
            currentPath={pathname}
            cartCount={cartCount}
            session={session}
            onLogout={onLogout}
          />
        </div>
      </header>
    </>
  );
}
