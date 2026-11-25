"use client";

import { useEffect, useId, useRef, useState } from "react";
import { GUEST_ACCOUNT_LINKS, PRIMARY_NAV } from "../../config/site";
import { Link } from "../../routing/link";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { copy } from "../copy/ja";
import { PrimaryNav } from "./primary-nav";

type Props = { currentPath: string; showRegister: boolean };

const REGISTER = GUEST_ACCOUNT_LINKS.find((link) => link.key === "register");

/**
 * Disclosure menu of the primary navigation Links (SPEC-050 8.5, 25), on every viewport. Not a Dialog: no focus
 * trap. CTA, Cart and Login / Mypage stay outside it, in the Header. The panel is positioned against the sticky
 * Header so it never leaves the viewport horizontally.
 */
export function HeaderMenu({ currentPath, showRegister }: Props) {
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(currentPath);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // A route change closes the menu (the layout is not remounted on navigation).
  if (lastPath !== currentPath) {
    setLastPath(currentPath);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={rootRef}>
      {/* A 48px round button on narrow screens, a labelled pill from md (DESIGN 8.3). The icon is speed lines. */}
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn("max-md:size-12 max-md:p-0", open && "bg-mint")}
      >
        <svg viewBox="0 0 24 18" width="22" height="16" aria-hidden="true" focusable="false">
          <path
            d="M0 0 H24 L21 4 H0Z M0 7 H19 L16 11 H0Z M0 14 H14 L11 18 H0Z"
            fill="currentColor"
          />
        </svg>
        <span className="max-md:sr-only">{copy.layout.menu.button}</span>
      </Button>
      {open ? (
        <PrimaryNav
          id={menuId}
          className="menu-panel surface-ink right-(--page-x)"
          listClassName="gap-y-2"
          linkClassName="menu-panel__link"
          items={PRIMARY_NAV.filter((item) => item.collapsible)}
          label={copy.layout.nav.primaryLabel}
          currentPath={currentPath}
          orientation="column"
          onNavigate={() => setOpen(false)}
          extraItems={
            showRegister && REGISTER !== undefined ? (
              <li className="min-[768px]:hidden">
                <Link
                  prefetch={false}
                  href={REGISTER.href}
                  onClick={() => setOpen(false)}
                  className="menu-panel__link"
                >
                  {copy.layout.account.register}
                </Link>
              </li>
            ) : null
          }
        />
      ) : null}
    </div>
  );
}
