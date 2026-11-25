"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ACCOUNT_MENU_ITEMS } from "../../config/site";
import { Link } from "../../routing/link";
import { Button } from "../components/ui/button";
import { copy } from "../copy/ja";

/** Disclosure menu of the Mypage destinations plus Logout (a button, not a Link). */
export function AccountMenu({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        className={open ? "bg-mint" : ""}
      >
        {copy.layout.account.menuButton}
      </Button>
      {open ? (
        <nav
          id={menuId}
          aria-label={copy.layout.account.menuLabel}
          className="menu-panel surface-ink right-(--page-x)"
        >
          <ul className="flex flex-col gap-2">
            {ACCOUNT_MENU_ITEMS.map((item) => (
              <li key={item.key}>
                <Link
                  prefetch={false}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="menu-panel__link"
                >
                  {copy.layout.account[item.key]}
                </Link>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onLogout();
                }}
                className="menu-panel__action"
              >
                {copy.layout.account.logout}
              </button>
            </li>
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
