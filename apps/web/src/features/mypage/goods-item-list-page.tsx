"use client";

import { useCallback } from "react";
import type { ApiPort } from "../../api-client/port";
import { PageState } from "../../presentation/components/page-state";
import { StatusBadge } from "../../presentation/components/status-badge";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Link } from "../../routing/link";
import { buildGoodsItemListModel } from "./goods-item-model";
import { useRead } from "./use-read";

// PG-MYP-011 container (SPEC-050 18.11, 20.4). The main outcome is the display rule's label: an unpaid
// item is never shown as waiting for pickup.

const linkClass = "link inline-flex min-h-11 items-center";

export function GoodsItemListPage() {
  const load = useCallback((api: ApiPort) => api.self.listGoodsItems(), []);
  const { read, reload } = useRead(load);
  const model = buildGoodsItemListModel(read);
  const labels = copy.mypage.goodsItems;

  return (
    <div className="flex flex-col gap-12 pb-16">
      <PageHero title={labels.heading} />
      {model.kind === "loading" ? <PageState state="loading" /> : null}
      {model.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(labels.subject)}
          onRetry={reload}
        />
      ) : null}
      {model.kind === "empty" ? <PageState state="empty" message={labels.empty} /> : null}
      {model.kind === "items" ? (
        <ul className="grid gap-6 md:grid-cols-2">
          {model.items.map((row) => (
            <li key={row.goodsItemRef} className="card items-start">
              <p className="card__value">{row.name}</p>
              <p className="num">{row.quantityText}</p>
              <div>
                <StatusBadge tone={row.tone} label={row.primaryLabel} />
              </div>
              <div className="flex flex-wrap gap-x-8 gap-y-2">
                <p className="flex flex-col">
                  <span className="card__label">{labels.itemStateLabel}</span> {row.itemLabel}
                </p>
                <p className="flex flex-col">
                  <span className="card__label">{labels.handoffStateLabel}</span> {row.handoffLabel}
                </p>
                <p className="flex flex-col">
                  <span className="card__label">{labels.orderStateLabel}</span>{" "}
                  {row.orderStateLabel}
                </p>
              </div>
              <div className="flex flex-wrap gap-x-6">
                <Link href={row.href} prefetch={false} className={linkClass}>
                  {row.linkLabel}
                </Link>
                <Link href={row.orderHref} prefetch={false} className={linkClass}>
                  {labels.orderLink}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
