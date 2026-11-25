"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ApiPort } from "../../api-client/port";
import { useApi } from "../../api-client/provider";
import { settleRead } from "../../api-client/settle-read";
import type { GoodsDetail, Ref } from "../../api-client/types";
import { type SessionState, useSession } from "../../auth/use-session";
import { GOODS_HREF } from "../../config/public-routes";
import { CART_HREF } from "../../config/site";
import { InkBand } from "../../presentation/components/ink-band";
import type { Loadable } from "../../presentation/components/list-state";
import { NotFoundView } from "../../presentation/components/not-found-view";
import { PageState } from "../../presentation/components/page-state";
import { PlainText } from "../../presentation/components/plain-text";
import { StatusBadge } from "../../presentation/components/status-badge";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Sticker } from "../../presentation/decor/sticker";
import { Link } from "../../routing/link";
import { type AddResult, AddResultNotice, AddToCartForm } from "../cart/add-to-cart-form";
import {
  type EligibilityInput,
  type EligibilityMode,
  eligibilityForSession,
  eligibilityMode,
} from "../purchase/eligibility-model";
import { readEligibilityOf } from "../purchase/read-eligibility";
import {
  buildGoodsDetailModel,
  type GoodsDetailModel,
  goodsEligibilityTarget,
} from "./goods-detail-model";

const linkClass = "link";

function GoodsReady({
  goods,
  eligibilityFailed,
  onRetry,
}: {
  goods: Extract<GoodsDetailModel, { kind: "ready" }>;
  eligibilityFailed: boolean;
  onRetry: () => void;
}) {
  const [result, setResult] = useState<AddResult>({ kind: "idle" });
  const reasonId = `${useId()}-reason`;
  return (
    <div className="flex flex-col gap-12">
      <PageHero title={goods.name}>
        <PlainText>{goods.description}</PlainText>
      </PageHero>
      <div className="grid gap-6 md:grid-cols-3">
        <p className="card">
          <span className="card__label">{copy.sales.priceLabel}</span>{" "}
          <span className="card__value num">{goods.priceText}</span>
        </p>
        <p className="card">
          <span className="card__label">{copy.sales.periodLabel}</span>{" "}
          <span className="num">{goods.salesPeriodText}</span>
        </p>
        <div className="card items-start">
          <span className="card__label">{copy.sales.statusLabel}</span>
          <StatusBadge tone={goods.status.tone} label={goods.status.label} />
          <span id={reasonId} className="card__note">
            {goods.status.description}
          </span>
        </div>
      </div>
      <div className="surface-ink bleed section-y relative">
        <Sticker
          kind="chip"
          color="teal"
          tilt={5}
          size={48}
          className="absolute -top-6 right-[max(var(--page-x),calc((100vw-var(--content-max))/2))]"
        />
        <p className="measure">{goods.pickupNotice}</p>
      </div>
      <div className="flex flex-col gap-6">
        {eligibilityFailed ? (
          <PageState
            state="unavailable"
            message={copy.pageState.unavailable(copy.entry.eligibilitySubject)}
            onRetry={onRetry}
          />
        ) : null}
        <AddResultNotice result={result} />
        <AddToCartForm
          buildLine={(quantity) => ({ kind: "GOODS", goodsRef: goods.goodsRef, quantity })}
          unitPrice={goods.unitPrice}
          maxSelectableQuantity={goods.maxSelectableQuantity}
          addable={goods.addable}
          reasonId={reasonId}
          onResult={setResult}
        />
        <p className="flex flex-wrap gap-x-6 gap-y-3">
          <Link href={CART_HREF} prefetch={false} className={linkClass}>
            {copy.sales.viewCart}
          </Link>
          <Link href={GOODS_HREF} prefetch={false} className={linkClass}>
            {copy.goods.detail.backToList}
          </Link>
        </p>
      </div>
    </div>
  );
}

type GoodsState = {
  /** The session state the eligibility was read under (null before the first read). */
  session: SessionState | null;
  goods: Loadable<GoodsDetail>;
  /** The owner-scoped eligibility read together with the Goods. Kept in memory only (SEC-API-029). */
  eligibility: EligibilityInput;
};

const INITIAL_STATE: GoodsState = {
  session: null,
  goods: { kind: "loading" },
  eligibility: { kind: "loading" },
};

/** Reads the eligibility (quantity 1) of a Goods that is on sale publicly; verified owners only. */
async function readEligibility(
  api: ApiPort,
  mode: Exclude<EligibilityMode, "wait">,
  goods: Loadable<GoodsDetail>,
): Promise<EligibilityInput> {
  if (mode === "not_applicable") return { kind: "not_applicable" };
  if (mode === "unavailable") return { kind: "unavailable" };
  const target = goodsEligibilityTarget(goods);
  if (target === null) return { kind: "ok", data: [] };
  return readEligibilityOf((chunk) => api.purchase.getPurchaseEligibility(chunk), [target]);
}

// PG-GDS-002 container: reads after mount through the port. Adding to the Cart starts no purchase.
export function GoodsDetailPage({ goodsRef }: { goodsRef: Ref<"goods"> }) {
  const api = useApi();
  const [state, setState] = useState<GoodsState>(INITIAL_STATE);
  const { state: session } = useSession();
  const token = useRef(0);

  const load = useCallback(() => {
    const mode = eligibilityMode(session);
    if (mode === "wait") return;
    token.current += 1;
    const current = token.current;
    // The public Goods and the owner-scoped eligibility are applied together, once.
    void (async () => {
      const goods = await settleRead(api.public.getGoods(goodsRef));
      const eligibility = await readEligibility(api, mode, goods);
      if (token.current === current) setState({ session, goods, eligibility });
    })();
  }, [api, goodsRef, session]);

  // The public Goods stays shown while both are read again; the owner-scoped answer is used only for
  // the session it was read for (B4b-F-1). A response for an older session is dropped by the token.
  useEffect(() => {
    const ref = token;
    load();
    return () => {
      ref.current += 1;
    };
  }, [load]);

  const reload = (): void => {
    setState(INITIAL_STATE);
    load();
  };

  const eligibility = eligibilityForSession(state.eligibility, state.session, session);
  const model = buildGoodsDetailModel(state.goods, eligibility);

  // Not Found shows the shared view only: nothing of the Goods is exposed (SPEC-050 14.2, 19.1).
  if (model.kind === "not_found") return <NotFoundView />;
  if (model.kind === "ready")
    return (
      <GoodsReady
        key={model.goodsRef}
        goods={model}
        eligibilityFailed={eligibility.kind === "unavailable"}
        onRetry={reload}
      />
    );

  return (
    <div className="flex flex-col gap-12">
      <PageHero title={copy.goods.detail.heading} />
      <InkBand>
        {model.kind === "loading" ? (
          <PageState state="loading" />
        ) : (
          <PageState
            state="unavailable"
            message={copy.pageState.unavailable(copy.goods.detail.subject)}
            onRetry={reload}
          />
        )}
      </InkBand>
    </div>
  );
}
