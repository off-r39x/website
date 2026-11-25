"use client";

import { type CSSProperties, useRef, useState } from "react";
import {
  ACCOUNT_MENU_ITEMS,
  CTA_HREF,
  GUEST_ACCOUNT_LINKS,
  MYPAGE_HREF,
  PRIMARY_NAV,
} from "../../config/site";
import { Link } from "../../routing/link";
import { buttonVariants } from "../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "../components/ui/dialog";
import { copy } from "../copy/ja";
import { Diamond } from "../decor/diamond";
import { CartLink } from "./cart-link";
import type { HeaderSession } from "./global-header";
import { PrimaryNav } from "./primary-nav";

type Props = {
  currentPath: string;
  cartCount: number | null;
  session: HeaderSession;
  onLogout: () => void;
};

const NAV_ITEMS = PRIMARY_NAV.filter((item) => item.collapsible);
const LOGIN = GUEST_ACCOUNT_LINKS.find((link) => link.key === "login");
const REGISTER = GUEST_ACCOUNT_LINKS.find((link) => link.key === "register");

/**
 * The narrow-screen menu (SPEC-050 8.5, DESIGN 8.3): one 48px round button on the bar opens a full-screen black
 * dialog holding the navigation, Cart, the account links and, last, the CTA. Focus moves to the close button and
 * stays inside (Base UI Dialog); Escape or the close button returns it to the menu button. Choosing a link closes
 * the menu and leaves focus to the destination.
 */
export function HeaderMenu({ currentPath, cartCount, session, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(currentPath);
  const [origin, setOrigin] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const leavingRef = useRef(false);
  // A route change closes the menu (the layout is not remounted on navigation).
  if (lastPath !== currentPath) {
    setLastPath(currentPath);
    if (open) {
      leavingRef.current = true;
      setOpen(false);
    }
  }
  const leave = (): void => {
    leavingRef.current = true;
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          leavingRef.current = false;
          // The black surface opens as a diamond from the menu button (DESIGN 8.3).
          const box = triggerRef.current?.getBoundingClientRect();
          if (box !== undefined) {
            setOrigin({
              "--mx": `${box.left + box.width / 2}px`,
              "--my": `${box.top + box.height / 2}px`,
            } as CSSProperties);
          }
        }
        setOpen(next);
      }}
    >
      <DialogTrigger ref={triggerRef} className="menu-button site-header__menu-button">
        <svg viewBox="0 0 24 18" width="22" height="16" aria-hidden="true" focusable="false">
          <path
            d="M0 0 H24 L21 4 H0Z M0 7 H19 L16 11 H0Z M0 14 H14 L11 18 H0Z"
            fill="currentColor"
          />
        </svg>
        <span className="sr-only">{copy.layout.menu.button}</span>
      </DialogTrigger>
      <DialogContent
        side="full"
        aria-label={copy.layout.menu.button}
        initialFocus={closeRef}
        finalFocus={() => !leavingRef.current}
        style={origin}
        className="mobile-menu surface-ink z-(--z-overlay) gap-0 border-0 bg-ink p-0 text-paper"
      >
        <span className="mobile-menu__backdrop" aria-hidden="true">
          <Diamond className="mobile-menu__diamond" />
        </span>
        <div className="mobile-menu__bar">
          <DialogClose ref={closeRef} className="menu-button menu-button--close">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M2 2 L18 18 M18 2 L2 18"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
              />
            </svg>
            <span className="sr-only">{copy.layout.menu.close}</span>
          </DialogClose>
        </div>
        <div className="mobile-menu__body">
          <PrimaryNav
            items={NAV_ITEMS}
            label={copy.layout.nav.primaryLabel}
            currentPath={currentPath}
            orientation="column"
            listClassName="mobile-menu__list gap-y-1"
            linkClassName="mobile-menu__link"
            onNavigate={leave}
            extraItems={
              <>
                <li>
                  <CartLink count={cartCount} className="mobile-menu__link" onNavigate={leave} />
                </li>
                {session === "guest" && LOGIN !== undefined ? (
                  <li>
                    <Link
                      prefetch={false}
                      href={LOGIN.href}
                      onClick={leave}
                      className="mobile-menu__link"
                    >
                      {copy.layout.account.login}
                    </Link>
                  </li>
                ) : null}
                {session === "guest" && REGISTER !== undefined ? (
                  <li>
                    <Link
                      prefetch={false}
                      href={REGISTER.href}
                      onClick={leave}
                      className="mobile-menu__link"
                    >
                      {copy.layout.account.register}
                    </Link>
                  </li>
                ) : null}
                {session === "authenticated" ? (
                  <li>
                    <Link
                      prefetch={false}
                      href={MYPAGE_HREF}
                      onClick={leave}
                      className="mobile-menu__link"
                    >
                      {copy.layout.account.mypage}
                    </Link>
                  </li>
                ) : null}
              </>
            }
          />
          {session === "authenticated" ? (
            <nav aria-label={copy.layout.account.menuLabel} className="mobile-menu__account">
              <ul className="mobile-menu__list">
                {ACCOUNT_MENU_ITEMS.map((item) => (
                  <li key={item.key}>
                    <Link
                      prefetch={false}
                      href={item.href}
                      onClick={leave}
                      className="mobile-menu__sublink"
                    >
                      {copy.layout.account[item.key]}
                    </Link>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      leave();
                      onLogout();
                    }}
                    className="mobile-menu__sublink"
                  >
                    {copy.layout.account.logout}
                  </button>
                </li>
              </ul>
            </nav>
          ) : null}
          <p className="mobile-menu__cta mobile-menu__enter">
            <Link prefetch={false} href={CTA_HREF} onClick={leave} className={buttonVariants()}>
              {copy.layout.cta.buyTickets}
            </Link>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
