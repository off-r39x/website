import { CART_HREF } from "../../config/site";
import { Link } from "../../routing/link";
import { cn } from "../components/ui/cn";
import { copy } from "../copy/ja";

/** Cart link: the quantity is text and part of the accessible name, only when it is 1 or more. */
export function CartLink({
  count,
  className,
  onNavigate,
}: {
  count: number | null;
  className?: string;
  onNavigate?: () => void;
}) {
  const hasCount = count !== null && count >= 1;
  return (
    <Link
      prefetch={false}
      href={CART_HREF}
      aria-label={hasCount ? copy.layout.cart.labelWithCount(count) : undefined}
      onClick={onNavigate}
      className={cn("inline-flex items-center gap-1", className)}
    >
      <span>{copy.layout.cart.label}</span>
      {hasCount ? <span className="count-seal">{count}</span> : null}
    </Link>
  );
}
