import { StatusBadge } from "../../presentation/components/status-badge";
import { copy } from "../../presentation/copy/ja";
import { Link } from "../../routing/link";
import type { OrderListRow } from "./order-list-model";

// One Order of a Mypage list (PG-MYP-001 / 003). The state is text; the tone only colours the badge.
// A row carries the Order's own facts and one link to its detail: never a link to a right.

export function OrderRowView({ row, showSummary }: { row: OrderListRow; showSummary: boolean }) {
  return (
    <li className="card items-start">
      <div>
        <StatusBadge tone={row.tone} label={row.stateLabel} />
      </div>
      <p className="card__value">{row.purposeLabel}</p>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {showSummary ? (
          <p className="flex flex-col">
            <span className="card__label">{copy.mypage.orders.itemsLabel}</span> {row.summary}
          </p>
        ) : null}
        <p className="flex flex-col">
          <span className="card__label">{copy.purchase.createdAtLabel}</span>{" "}
          <span className="num">{row.createdAtText}</span>
        </p>
        <p className="flex flex-col">
          <span className="card__label">{copy.purchase.totalLabel}</span>{" "}
          <span className="num">{row.totalText}</span>
        </p>
      </div>
      <Link href={row.href} prefetch={false} className="link inline-flex min-h-11 items-center">
        {row.linkLabel}
      </Link>
    </li>
  );
}
