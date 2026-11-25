"use client";

import { type ReactNode, useCallback, useId } from "react";
import type { ApiPort } from "../../api-client/port";
import { MYPAGE_PATHS } from "../../config/mypage-routes";
import { PageState } from "../../presentation/components/page-state";
import { SectionHeading } from "../../presentation/components/section-heading";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Link } from "../../routing/link";
import { OrderRowView } from "./order-row";
import { buildMypageOverviewModel } from "./overview-model";
import { ReservationRowView } from "./reservation-row";
import { useRead } from "./use-read";

// PG-MYP-001 container (SPEC-050 18.1, 9, 21). The five reads are independent: a failed read makes only
// its own areas unavailable (with its own retry) and never turns another area into Empty or unavailable.

const linkClass = "link inline-flex min-h-11 items-center";

type AreaState = "loading" | "unavailable" | "other";

function Area({
  heading,
  subject,
  state,
  onRetry,
  children,
}: {
  heading: string;
  subject: string;
  state: AreaState;
  onRetry: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col items-start gap-4">
      <SectionHeading id={headingId}>{heading}</SectionHeading>
      {state === "loading" ? <PageState state="loading" /> : null}
      {state === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(subject)}
          onRetry={onRetry}
        />
      ) : null}
      {state === "other" ? children : null}
    </section>
  );
}

const areaState = (kind: string): AreaState =>
  kind === "loading" ? "loading" : kind === "unavailable" ? "unavailable" : "other";

export function MypageOverviewPage() {
  const loadProfile = useCallback((api: ApiPort) => api.self.getProfile(), []);
  const loadOrders = useCallback((api: ApiPort) => api.self.listOrders(), []);
  const loadTickets = useCallback((api: ApiPort) => api.self.listEntryTickets(), []);
  const loadReservations = useCallback((api: ApiPort) => api.self.listReservations(), []);
  const loadGoodsItems = useCallback((api: ApiPort) => api.self.listGoodsItems(), []);
  const profile = useRead(loadProfile);
  const orders = useRead(loadOrders);
  const tickets = useRead(loadTickets);
  const reservations = useRead(loadReservations);
  const goodsItems = useRead(loadGoodsItems);

  const model = buildMypageOverviewModel({
    profile: profile.read,
    orders: orders.read,
    tickets: tickets.read,
    reservations: reservations.read,
    goodsItems: goodsItems.read,
  });
  const text = copy.mypage.overview;

  return (
    <div className="flex flex-col gap-12 pb-16">
      <PageHero title={copy.mypage.heading} />

      <Area
        heading={copy.mypage.overview.profileHeading}
        subject={text.profileSubject}
        state={areaState(model.profile.kind)}
        onRetry={profile.reload}
      >
        {model.profile.kind === "ready" ? (
          <>
            <div className="card measure w-full">
              <p className="flex flex-col break-words">
                <span className="card__label">{text.emailLabel}</span>{" "}
                <span className="card__value">{model.profile.email}</span>
              </p>
              <p className="flex flex-col break-words">
                <span className="card__label">{text.displayNameLabel}</span>{" "}
                <span className="card__value">{model.profile.displayName}</span>
              </p>
            </div>
            <p>
              <Link href={model.profile.href} prefetch={false} className={linkClass}>
                {text.profileLink}
              </Link>
            </p>
          </>
        ) : null}
      </Area>

      <Area
        heading={text.pendingHeading}
        subject={text.pendingSubject}
        state={areaState(model.pending.kind)}
        onRetry={orders.reload}
      >
        {model.pending.kind === "empty" ? (
          <PageState state="empty" message={text.pendingEmpty} />
        ) : null}
        {model.pending.kind === "items" ? (
          <ul className="grid w-full gap-6 md:grid-cols-2">
            {model.pending.items.map((row) => (
              <OrderRowView key={row.orderRef} row={row} showSummary={false} />
            ))}
          </ul>
        ) : null}
        <p>
          <Link href={MYPAGE_PATHS.orders} prefetch={false} className={linkClass}>
            {text.ordersLink}
          </Link>
        </p>
      </Area>

      <Area
        heading={text.latestHeading}
        subject={text.latestSubject}
        state={areaState(model.latest.kind)}
        onRetry={orders.reload}
      >
        {model.latest.kind === "empty" ? (
          <PageState state="empty" message={text.latestEmpty} />
        ) : null}
        {model.latest.kind === "ready" ? (
          <ul className="grid w-full gap-6 md:grid-cols-2">
            <OrderRowView row={model.latest.row} showSummary={false} />
          </ul>
        ) : null}
      </Area>

      <Area
        heading={text.ticketsHeading}
        subject={text.ticketsSubject}
        state={areaState(model.tickets.kind)}
        onRetry={tickets.reload}
      >
        {model.tickets.kind === "empty" ? (
          <PageState state="empty" message={text.ticketsEmpty} />
        ) : null}
        {model.tickets.kind === "ready" ? (
          <p className="card card__value num">{model.tickets.summary}</p>
        ) : null}
        <p>
          <Link href={MYPAGE_PATHS.entryTickets} prefetch={false} className={linkClass}>
            {text.ticketsLink}
          </Link>
        </p>
      </Area>

      <Area
        heading={text.karaokeHeading}
        subject={text.karaokeSubject}
        state={areaState(model.reservations.kind)}
        onRetry={reservations.reload}
      >
        {model.reservations.kind === "empty" ? (
          <PageState state="empty" message={text.karaokeEmpty} />
        ) : null}
        {model.reservations.kind === "items" ? (
          <ul className="grid w-full gap-6 md:grid-cols-2">
            {model.reservations.items.map((row) => (
              <ReservationRowView key={row.reservationRef} row={row} />
            ))}
          </ul>
        ) : null}
        <p>
          <Link href={MYPAGE_PATHS.reservations} prefetch={false} className={linkClass}>
            {text.karaokeLink}
          </Link>
        </p>
      </Area>

      <Area
        heading={text.goodsHeading}
        subject={text.goodsSubject}
        state={areaState(model.goods.kind)}
        onRetry={goodsItems.reload}
      >
        {model.goods.kind === "empty" ? (
          <PageState state="empty" message={text.goodsEmpty} />
        ) : null}
        {model.goods.kind === "ready" ? (
          <p className="card card__value num">{model.goods.summary}</p>
        ) : null}
        <p>
          <Link href={MYPAGE_PATHS.goodsItems} prefetch={false} className={linkClass}>
            {text.goodsLink}
          </Link>
        </p>
      </Area>
    </div>
  );
}
