"use client";

import { useEffect, useId, useState } from "react";
import { currentNavKey, MYPAGE_NAV_KEYS, MYPAGE_PATHS } from "../../config/mypage-routes";
import { Button } from "../../presentation/components/ui/button";
import { cn } from "../../presentation/components/ui/cn";
import { copy } from "../../presentation/copy/ja";
import { Link } from "../../routing/link";
import { usePathname } from "../../routing/navigation";

// Mypage local navigation (SPEC-050 17.2, 24.1, 25). A landmark with six links and no list markup.
// Desktop shows it permanently; Mobile hides it behind a disclosure that reports its state.

export function MypageNav() {
  const pathname = usePathname();
  const navId = useId();
  const [open, setOpen] = useState(false);
  const current = currentNavKey(pathname);

  // The menu closes after a link was followed (the layout stays mounted across Mypage pages).
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of the pathname is the trigger.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        variant="outline"
        className="w-fit md:hidden"
        aria-expanded={open}
        aria-controls={navId}
        onClick={() => setOpen((value) => !value)}
      >
        {copy.mypage.nav.toggle}
      </Button>
      <nav
        id={navId}
        aria-label={copy.mypage.nav.label}
        className={cn(
          "flex-col items-start gap-2 md:flex md:flex-row md:flex-wrap md:gap-3",
          open ? "flex" : "hidden",
        )}
      >
        {MYPAGE_NAV_KEYS.map((key) => (
          <Link
            key={key}
            href={MYPAGE_PATHS[key]}
            prefetch={false}
            aria-current={current === key ? "page" : undefined}
            className={cn("chip min-h-11 px-4", current === key ? "bg-mint" : "hover:bg-lemon")}
          >
            {/* The selected chip carries the small diamond in front (DESIGN 8.8). */}
            {current === key ? (
              <svg className="diamond-mark" aria-hidden="true" focusable="false">
                <use href="#chip" />
              </svg>
            ) : null}
            {copy.mypage.nav.items[key]}
          </Link>
        ))}
      </nav>
    </div>
  );
}
