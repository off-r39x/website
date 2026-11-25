"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../api-client/provider";
import { settleRead } from "../../api-client/settle-read";
import type { BusinessDateJst, KaraokeDay } from "../../api-client/types";
import { KARAOKE_HREF } from "../../config/public-routes";
import { InkBand } from "../../presentation/components/ink-band";
import type { Loadable } from "../../presentation/components/list-state";
import { NotFoundView } from "../../presentation/components/not-found-view";
import { PageState } from "../../presentation/components/page-state";
import { SectionHeading } from "../../presentation/components/section-heading";
import { StatusBadge } from "../../presentation/components/status-badge";
import { Button } from "../../presentation/components/ui/button";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Sticker } from "../../presentation/decor/sticker";
import { Link } from "../../routing/link";
import { type BucketModel, buildKaraokeDayModel, type DayLink } from "./karaoke-day-model";

const day = copy.karaoke.day;
const linkClass = "link";

// PG-KRK-002 container: reads the schedule after mount through the port. It only reads (no purchase).
export function KaraokeDayPage({ date }: { date: BusinessDateJst }) {
  const api = useApi();
  const [input, setInput] = useState<Loadable<KaraokeDay>>({ kind: "loading" });
  const token = useRef(0);

  const load = useCallback(() => {
    token.current += 1;
    const current = token.current;
    void settleRead(api.public.getKaraokeDay(date)).then((result) => {
      if (token.current === current) setInput(result);
    });
  }, [api, date]);

  useEffect(() => {
    const ref = token;
    setInput({ kind: "loading" });
    load();
    return () => {
      ref.current += 1;
    };
  }, [load]);

  const reload = (): void => {
    setInput({ kind: "loading" });
    load();
  };

  const model = buildKaraokeDayModel(input);

  // A date that is not a sales date shows the shared Not Found view (SPEC-050 13.2, 19.1).
  if (model.kind === "not_found") return <NotFoundView />;

  return (
    <div className="flex flex-col gap-12">
      <PageHero title={day.heading} />
      {model.kind === "loading" || model.kind === "unavailable" ? (
        <InkBand>
          {model.kind === "loading" ? <PageState state="loading" /> : null}
          {model.kind === "unavailable" ? (
            <PageState
              state="unavailable"
              message={day.unavailable}
              retryLabel={day.reload}
              onRetry={reload}
            />
          ) : null}
        </InkBand>
      ) : null}
      {model.kind === "ready" ? (
        <>
          <section
            aria-labelledby="karaoke-day-date"
            className="surface-ink bleed section-y relative flex flex-col gap-6"
          >
            <Sticker
              kind="note"
              tilt={7}
              size={56}
              className="absolute -top-7 left-[max(var(--page-x),calc((100vw-var(--content-max))/2))]"
            />
            <SectionHeading id="karaoke-day-date">{model.dateText}</SectionHeading>
            <div className="flex flex-col items-start gap-2">
              <StatusBadge tone={model.saleStatus.tone} label={model.saleStatus.label} />
              <p className="measure">{model.saleStatus.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
              {model.previous === null ? null : (
                <DayNavLink link={model.previous} label={day.previous} />
              )}
              {model.next === null ? null : <DayNavLink link={model.next} label={day.next} />}
              <Link href={KARAOKE_HREF} prefetch={false} className={linkClass}>
                {day.backToGuide}
              </Link>
              <Button type="button" variant="outline" onClick={reload}>
                {day.reload}
              </Button>
            </div>
          </section>
          {model.buckets.length === 0 ? (
            <PageState state="empty" message={day.empty} />
          ) : (
            <div className="flex flex-col gap-12">
              {model.buckets.map((bucket) => (
                <Bucket key={bucket.startHour} bucket={bucket} />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function DayNavLink({ link, label }: { link: DayLink; label: string }) {
  return (
    <Link href={link.href} prefetch={false} className={linkClass}>
      {label}
      <span className="sr-only">{link.text}</span>
    </Link>
  );
}

function Bucket({ bucket }: { bucket: BucketModel }) {
  const headingId = `karaoke-bucket-${bucket.startHour}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <SectionHeading id={headingId} level={3}>
        {bucket.label}
      </SectionHeading>
      <p className="text-small">{bucket.countText}</p>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {bucket.slots.map((slot) => (
          <li key={slot.slotRef} className="card items-start">
            <span className="card__value num">{slot.timeText}</span>
            <StatusBadge tone={slot.tone} label={slot.stateLabel} />
            <span className="card__note">{slot.description}</span>
            {slot.href === null ? null : (
              <Link href={slot.href} prefetch={false} className={linkClass}>
                {day.slotLink(slot.timeText)}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
