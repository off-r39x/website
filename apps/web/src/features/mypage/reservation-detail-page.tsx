"use client";

import { useCallback, useId } from "react";
import type { ApiPort } from "../../api-client/port";
import type { Ref } from "../../api-client/types";
import { MYPAGE_PATHS } from "../../config/mypage-routes";
import { AccessDeniedView } from "../../presentation/components/access-denied-view";
import { PageState } from "../../presentation/components/page-state";
import { SectionHeading } from "../../presentation/components/section-heading";
import { StatusBadge } from "../../presentation/components/status-badge";
import { Button, buttonVariants } from "../../presentation/components/ui/button";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Link } from "../../routing/link";
import { ReceiptLink } from "./receipt-link";
import { buildReservationDetailModel } from "./reservation-model";
import { useRead } from "./use-read";

// PG-MYP-009 container (SPEC-050 18.9, 20.3, 23, 26.2). The Reservation is read, never created: the QR
// is a link only for CONFIRMED + VALID; otherwise a disabled action whose reason is on the page as text.

const linkClass = "link inline-flex min-h-11 items-center";

export function ReservationDetailPage({ reservationRef }: { reservationRef: Ref<"reservation"> }) {
  const load = useCallback(
    (api: ApiPort) => api.self.getReservation(reservationRef),
    [reservationRef],
  );
  const { read, reload } = useRead(load);
  const model = buildReservationDetailModel(read);
  const baseId = useId();
  const infoId = `${baseId}-info`;
  const reasonId = `${baseId}-reason`;
  const detail = copy.mypage.reservations.detail;

  // Ownership failure: nothing of the Reservation was rendered before this view (SPEC-050 26.2).
  if (model.kind === "denied") {
    return (
      <AccessDeniedView
        listHref={MYPAGE_PATHS.reservations}
        listLabel={copy.accessDenied.reservationsLink}
      />
    );
  }

  return (
    <div className="flex flex-col gap-12 pb-16">
      <PageHero title={detail.heading} />
      {model.kind === "loading" ? <PageState state="loading" /> : null}
      {model.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(detail.subject)}
          onRetry={reload}
        />
      ) : null}
      {model.kind === "ready" ? (
        <>
          <section aria-labelledby={infoId} className="flex flex-col gap-6">
            <SectionHeading id={infoId}>{detail.infoHeading}</SectionHeading>
            <div className="card measure items-start gap-4">
              <div>
                <StatusBadge tone={model.tone} label={model.primaryLabel} />
              </div>
              <p className="flex flex-col">
                <span className="card__label">{copy.mypage.reservations.dateLabel}</span>{" "}
                <span className="card__value num">{model.dateText}</span>
              </p>
              <div className="flex flex-wrap gap-x-8 gap-y-4">
                <p className="flex flex-col">
                  <span className="card__label">{detail.startLabel}</span>{" "}
                  <span className="card__value num">{model.startText}</span>
                </p>
                <p className="flex flex-col">
                  <span className="card__label">{detail.endLabel}</span>{" "}
                  <span className="card__value num">{model.endText}</span>
                </p>
              </div>
              <p className="flex flex-col">
                <span className="card__label">
                  {copy.mypage.reservations.reservationStateLabel}
                </span>{" "}
                {model.reservationLabel}
              </p>
              <p className="flex flex-col">
                <span className="card__label">{copy.mypage.reservations.ticketStateLabel}</span>{" "}
                {model.ticketLabel}
              </p>
            </div>
            {model.qr.kind === "link" ? (
              <p>
                <Link href={model.qr.href} prefetch={false} className={buttonVariants()}>
                  {model.qr.label}
                </Link>
              </p>
            ) : (
              <div className="flex flex-col items-start gap-2">
                <Button type="button" variant="outline" disabled aria-describedby={reasonId}>
                  {model.qr.label}
                </Button>
                <p id={reasonId} className="measure text-small font-bold">
                  {model.qr.reason}
                </p>
              </div>
            )}
            <p>
              <Link href={model.orderHref} prefetch={false} className={linkClass}>
                {copy.mypage.reservations.orderLink}
              </Link>
            </p>
            <ReceiptLink href={model.receiptHref} />
          </section>
          <p>
            <Link href={MYPAGE_PATHS.reservations} prefetch={false} className={linkClass}>
              {detail.backToList}
            </Link>
          </p>
        </>
      ) : null}
    </div>
  );
}
