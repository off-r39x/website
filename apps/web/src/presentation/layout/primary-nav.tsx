import type { ReactNode } from "react";
import type { PrimaryNavItem } from "../../config/site";
import { Link } from "../../routing/link";
import { cn } from "../components/ui/cn";
import { copy } from "../copy/ja";

type Props = {
  items: readonly PrimaryNavItem[];
  label: string;
  currentPath: string;
  orientation?: "row" | "column";
  className?: string;
  id?: string;
  onNavigate?: () => void;
  /** Extra list items after the navigation Links (for example a Link only some visitors need). */
  extraItems?: ReactNode;
  listClassName?: string;
  linkClassName?: string;
};

function isCurrent(currentPath: string, href: string): boolean {
  if (href === "/") return currentPath === "/";
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

/** A named navigation landmark of Links (navigation is a Link, never a button: SPEC-050 25). */
export function PrimaryNav({
  items,
  label,
  currentPath,
  orientation = "row",
  className,
  id,
  onNavigate,
  extraItems,
  listClassName,
  linkClassName = "link inline-flex min-h-11 items-center",
}: Props) {
  return (
    <nav id={id} aria-label={label} className={className}>
      <ul
        className={cn(
          "flex flex-wrap gap-x-6 gap-y-1",
          orientation === "column" && "flex-col",
          listClassName,
        )}
      >
        {items.map((item) => (
          <li key={item.key}>
            <Link
              prefetch={false}
              href={item.href}
              aria-current={isCurrent(currentPath, item.href) ? "page" : undefined}
              onClick={() => onNavigate?.()}
              className={cn(linkClassName, "aria-[current=page]:font-black")}
            >
              {copy.layout.nav.items[item.key]}
            </Link>
          </li>
        ))}
        {extraItems}
      </ul>
    </nav>
  );
}
