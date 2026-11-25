"use client";

import { useCallback, useId } from "react";
import type { ApiPort } from "../../api-client/port";
import type { Ref } from "../../api-client/types";
import { MYPAGE_PATHS } from "../../config/mypage-routes";
import { AccessDeniedView } from "../../presentation/components/access-denied-view";
import { PageState } from "../../presentation/components/page-state";
import { SectionHeading } from "../../presentation/components/section-heading";
import { StatusBadge } from "../../presentation/components/status-badge";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Link } from "../../routing/link";
import { buildGoodsItemDetailModel } from "./goods-item-model";
import { ReceiptLink } from "./receipt-link";
import { useRead } from "./use-read";

// PG-MYP-012 container (SPEC-050 18.12, 20.4). Read-only: a customer can never move a handed-over item
// back to pending, so this page has no control at all. The price is the purchase-time Snapshot.

const linkClass = "link inline-flex min-h-11 items-center";

export function GoodsItemDetailPage({ goodsItemRef }: { goodsItemRef: Ref<"goodsItem"> }) {
  const load = useCallback((api: ApiPort) => api.self.getGoodsItem(goodsItemRef), [goodsItemRef]);
  const { read, reload } = useRead(load);
  const model = buildGoodsItemDetailModel(read);
  const infoId = `${useId()}-info`;
  const labels = copy.mypage.goodsItems;

  // Ownership failure: nothing of the item was rendered before this view (SPEC-050 26.2).
  if (model.kind === "denied") {
    return (
      <AccessDeniedView
        listHref={MYPAGE_PATHS.goodsItems}
        listLabel={copy.accessDenied.goodsItemsLink}
      />
    );
  }

  return (
    <div className="flex flex-col gap-12 pb-16">
      <PageHero title={labels.detail.heading} />
      {model.kind === "loading" ? <PageState state="loading" /> : null}
      {model.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(labels.detail.subject)}
          onRetry={reload}
        />
      ) : null}
      {model.kind === "ready" ? (
        <>
          <section aria-labelledby={infoId} className="flex flex-col gap-6">
            <SectionHeading id={infoId}>{labels.detail.infoHeading}</SectionHeading>
            <div className="card measure items-start gap-4">
              <div>
                <StatusBadge tone={model.tone} label={model.primaryLabel} />
              </div>
              <p>{model.description}</p>
              <p className="flex flex-col">
                <span className="card__label">{labels.detail.nameLabel}</span>{" "}
                <span className="card__value">{model.name}</span>
              </p>
              <p className="num">{model.quantityText}</p>
              <div className="flex flex-wrap gap-x-8 gap-y-4">
                <p className="flex flex-col">
                  <span className="card__label">{copy.cart.unitPriceLabel}</span>{" "}
                  <span className="num">{model.unitPriceText}</span>
                </p>
                <p className="flex flex-col">
                  <span className="card__label">{copy.cart.subtotalLabel}</span>{" "}
                  <span className="card__value num">{model.subtotalText}</span>
                </p>
              </div>
              <p className="flex flex-col">
                <span className="card__label">{labels.itemStateLabel}</span> {model.itemLabel}
              </p>
              <p className="flex flex-col">
                <span className="card__label">{labels.handoffStateLabel}</span> {model.handoffLabel}
              </p>
              {model.pickupNotice === null ? null : <p>{model.pickupNotice}</p>}
              {model.noSecondHandoff === null ? null : <p>{model.noSecondHandoff}</p>}
              <p className="flex flex-col">
                <span className="card__label">{labels.orderStateLabel}</span>{" "}
                {model.orderStateLabel}
              </p>
            </div>
            <p>
              <Link href={model.orderHref} prefetch={false} className={linkClass}>
                {labels.orderLink}
              </Link>
            </p>
            <ReceiptLink href={model.receiptHref} />
          </section>
          <p>
            <Link href={MYPAGE_PATHS.goodsItems} prefetch={false} className={linkClass}>
              {labels.detail.backToList}
            </Link>
          </p>
        </>
      ) : null}
    </div>
  );
}
