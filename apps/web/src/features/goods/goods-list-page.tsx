"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../api-client/provider";
import { settleRead } from "../../api-client/settle-read";
import type { GoodsSummary } from "../../api-client/types";
import { InkBand } from "../../presentation/components/ink-band";
import type { Loadable } from "../../presentation/components/list-state";
import { PageState } from "../../presentation/components/page-state";
import { StatusBadge } from "../../presentation/components/status-badge";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Sticker } from "../../presentation/decor/sticker";
import { Link } from "../../routing/link";
import { buildGoodsListModel } from "./goods-list-model";

// PG-GDS-001 container: reads after mount through the port. The list has no purchase operation.
export function GoodsListPage() {
  const api = useApi();
  const [input, setInput] = useState<Loadable<readonly GoodsSummary[]>>({ kind: "loading" });
  const token = useRef(0);

  const load = useCallback(() => {
    token.current += 1;
    const current = token.current;
    void settleRead(api.public.listGoods()).then((result) => {
      if (token.current === current) setInput(result);
    });
  }, [api]);

  useEffect(() => {
    const ref = token;
    load();
    return () => {
      ref.current += 1;
    };
  }, [load]);

  const reload = (): void => {
    setInput({ kind: "loading" });
    load();
  };

  const list = buildGoodsListModel(input);

  return (
    <div className="flex flex-col gap-12">
      <PageHero title={copy.goods.list.heading} />
      {list.kind !== "items" ? (
        <InkBand>
          {list.kind === "loading" ? <PageState state="loading" /> : null}
          {list.kind === "empty" ? <PageState state="empty" /> : null}
          {list.kind === "unavailable" ? (
            <PageState
              state="unavailable"
              message={copy.pageState.unavailable(copy.goods.list.subject)}
              onRetry={reload}
            />
          ) : null}
        </InkBand>
      ) : null}
      {list.kind === "items" ? (
        <div className="surface-ink bleed section-y relative">
          <Sticker
            kind="chip"
            color="lemon"
            tilt={-4}
            size={48}
            className="absolute -top-6 left-[max(var(--page-x),calc((100vw-var(--content-max))/2))]"
          />
          <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {list.items.map((item) => (
              <li key={item.goodsRef} className="card">
                <Link href={item.href} prefetch={false} className="link text-h3 self-start">
                  {item.name}
                </Link>
                <p>{item.shortDescription}</p>
                <p className="card__value num">{item.priceText}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={item.status.tone} label={item.status.label} />
                  <span className="card__note">{item.status.description}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
