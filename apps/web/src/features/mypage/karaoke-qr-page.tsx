"use client";

import { useCallback } from "react";
import type { ApiPort } from "../../api-client/port";
import type { Ref } from "../../api-client/types";
import { MYPAGE_PATHS } from "../../config/mypage-routes";
import { AccessDeniedView } from "../../presentation/components/access-denied-view";
import { PageState } from "../../presentation/components/page-state";
import { QrPlaceholder } from "../../presentation/components/qr-placeholder";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Link } from "../../routing/link";
import { buildKaraokeQrModel } from "./qr-model";
import { useRead } from "./use-read";

// PG-MYP-010 container (SPEC-050 18.10, 24.2, SEC-QR-012 / 013). Synthetic QR placeholder only. The
// purpose is determined by the route (the same as the document title), not by fetched data, so
// showing it while loading or unavailable leaks nothing about ownership. The Reservation data is
// shown only after the ownership decision; denied uses AccessDeniedView and cannot tell another
// user's ref from a missing one (SEC-QR-012, SPEC-110 section 22).

const linkClass = "link inline-flex min-h-11 items-center";

export function KaraokeQrPage({ reservationRef }: { reservationRef: Ref<"reservation"> }) {
  const loadReservation = useCallback(
    (api: ApiPort) => api.self.getReservation(reservationRef),
    [reservationRef],
  );
  const loadQr = useCallback(
    (api: ApiPort) => api.self.getKaraokeQr(reservationRef),
    [reservationRef],
  );
  const reservation = useRead(loadReservation);
  const qr = useRead(loadQr);
  const model = buildKaraokeQrModel(reservation.read, qr.read);

  if (model.kind === "denied") {
    return (
      <AccessDeniedView
        listHref={MYPAGE_PATHS.reservations}
        listLabel={copy.accessDenied.reservationsLink}
      />
    );
  }

  if (model.kind !== "ready") {
    return (
      <div className="flex flex-col gap-12 pb-16">
        <PageHero title={copy.qr.KARAOKE} />
        {model.kind === "loading" ? (
          <PageState state="loading" />
        ) : (
          <PageState
            state="unavailable"
            message={copy.pageState.unavailable(copy.mypage.reservations.detail.subject)}
            onRetry={() => {
              reservation.reload();
              qr.reload();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12 pb-16">
      {/* The hero's decoration stays above the figure: nothing is drawn next to or over the QR (SPEC-050 24.2). */}
      <PageHero title={model.title} />
      <figure className="card w-full max-w-md items-start gap-6">
        <figcaption className="text-h3">{model.title}</figcaption>
        <div className="flex flex-col gap-3">
          {model.lines.map((line) => (
            <p key={line.label} className="flex flex-col">
              <span className="card__label">{line.label}</span>{" "}
              <span className="font-bold">{line.value}</span>
            </p>
          ))}
        </div>
        {model.presentable && model.matrixSeed !== null ? (
          <>
            <QrPlaceholder matrixSeed={model.matrixSeed} label={model.imageLabel} />
            {model.mockNotice === null ? null : (
              <p className="card__note measure">{copy.mypage.qr.mockNotice}</p>
            )}
          </>
        ) : (
          <>
            <p className="card__value">{model.primaryLabel}</p>
            {model.disabledReason === null ? null : (
              <p className="measure">{model.disabledReason}</p>
            )}
          </>
        )}
      </figure>
      <p>
        <Link href={model.backHref} prefetch={false} className={linkClass}>
          {model.backLabel}
        </Link>
      </p>
    </div>
  );
}
