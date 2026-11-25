"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../api-client/provider";
import { settleRead } from "../../api-client/settle-read";
import type { KaraokeSales } from "../../api-client/types";
import type { Loadable } from "../../presentation/components/list-state";
import { PageState } from "../../presentation/components/page-state";
import { SectionHeading } from "../../presentation/components/section-heading";
import { StatusBadge } from "../../presentation/components/status-badge";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Sticker } from "../../presentation/decor/sticker";
import { Link } from "../../routing/link";
import { buildKaraokeGuideModel } from "./karaoke-guide-model";

const guide = copy.karaoke.guide;

// PG-KRK-001 container: reads after mount through the port; the first render is always loading.
export function KaraokeGuidePage() {
  const api = useApi();
  const [input, setInput] = useState<Loadable<KaraokeSales>>({ kind: "loading" });
  const token = useRef(0);

  const load = useCallback(() => {
    token.current += 1;
    const current = token.current;
    void settleRead(api.public.getKaraokeSales()).then((result) => {
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

  const model = buildKaraokeGuideModel(input);

  return (
    <div className="flex flex-col gap-12">
      <PageHero title={guide.heading}>
        <p>{guide.intro}</p>
      </PageHero>
      <div className="surface-ink bleed section-y relative">
        <Sticker
          kind="note"
          tilt={-6}
          size={56}
          className="absolute -top-7 left-[max(var(--page-x),calc((100vw-var(--content-max))/2))]"
        />
        <div className="measure flex flex-col gap-3">
          <p>{guide.usageUnit}</p>
          <p>{guide.duration}</p>
          <p>{guide.purchaseLimit}</p>
        </div>
      </div>
      {model.kind === "loading" ? <PageState state="loading" /> : null}
      {model.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(guide.subject)}
          onRetry={reload}
        />
      ) : null}
      {model.kind === "ready" ? (
        <>
          <dl className="grid gap-6 md:grid-cols-3">
            <div className="card">
              <dt className="card__label">{guide.priceLabel}</dt>
              <dd className="card__value num">{model.priceText}</dd>
            </div>
            <div className="card">
              <dt className="card__label">{guide.periodLabel}</dt>
              <dd className="num">{model.salesPeriodText}</dd>
            </div>
            <div className="card">
              <dt className="card__label">{guide.statusLabel}</dt>
              <dd className="flex flex-col items-start gap-2">
                <StatusBadge tone={model.saleStatus.tone} label={model.saleStatus.label} />
                <span className="card__note">{model.saleStatus.description}</span>
              </dd>
            </div>
          </dl>
          <section aria-labelledby="karaoke-dates" className="flex flex-col gap-6">
            <SectionHeading id="karaoke-dates">{guide.datesHeading}</SectionHeading>
            {model.dates.kind === "empty" ? (
              <PageState state="empty" message={guide.datesEmpty} />
            ) : (
              <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {model.dates.items.map((item) => (
                  <li key={item.date} className="flex">
                    <Link
                      href={item.href}
                      prefetch={false}
                      className="card card--link w-full font-bold"
                    >
                      {guide.dateLink(item.text)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
