"use client";

import { useId } from "react";
import { ExternalLink } from "../../presentation/components/external-link";
import { SectionHeading } from "../../presentation/components/section-heading";
import { StatusBadge } from "../../presentation/components/status-badge";
import { Button } from "../../presentation/components/ui/button";
import { copy } from "../../presentation/copy/ja";
import { Sticker } from "../../presentation/decor/sticker";
import { Link } from "../../routing/link";
import type { PurchaseAction, PurchaseStatusModel } from "./purchase-status-model";

// The Order outcome shared by PG-XFN-001 and PG-MYP-004 (SPEC-050 16.2 .. 16.7, 25). A view: the state is
// always shown as text (the tone only colours it), the page-level live region is the only role=status,
// and rights appear only when the model carries them (it carries them for a CONFIRMED Order only).

type Ready = Extract<PurchaseStatusModel, { kind: "ready" }>;

export type OutcomeButtonAction = Extract<
  PurchaseAction,
  { kind: "retry_checkout" | "recheck_status" | "purchase_again" }
>;

export type OrderOutcomePending = "recheck_status" | "retry_checkout" | null;

const linkClass = "link inline-block py-2";

export function OrderOutcome({
  model,
  liveMessage,
  alertMessage,
  pending,
  disableCartPurchaseAgain = false,
  onAction,
}: {
  model: Ready;
  /** Announced in the live region (empty at first). */
  liveMessage: string;
  /** A failure notice for the action that was just run; at most one alert is shown. */
  alertMessage: string | null;
  pending: OrderOutcomePending;
  disableCartPurchaseAgain?: boolean;
  onAction: (action: OutcomeButtonAction) => void;
}) {
  const baseId = useId();
  const outcomeId = `${baseId}-outcome`;
  const itemsId = `${baseId}-items`;
  const rightsId = `${baseId}-rights`;
  const entitlements = model.entitlements;

  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby={outcomeId} className="flex max-w-3xl flex-col gap-4">
        <SectionHeading id={outcomeId}>{copy.purchase.outcomeHeading}</SectionHeading>
        <div>
          <StatusBadge tone={model.tone} label={model.stateLabel} />
        </div>
        <p className="measure">{model.description}</p>
        <div className="card measure">
          <p>
            <span className="font-bold">{copy.purchase.purposeLabel}</span> {model.purposeLabel}
          </p>
          <p>
            <span className="font-bold">{copy.purchase.createdAtLabel}</span>{" "}
            <span className="num">{model.createdAtText}</span>
          </p>
        </div>
        {model.notice === null ? null : (
          <p className="card measure text-small">
            <span className="card__label">{model.notice.label}</span> {model.notice.message}
          </p>
        )}
        <div role="status" className="text-small font-bold">
          {liveMessage}
        </div>
        {alertMessage === null ? null : (
          <p role="alert" className="alert block measure">
            <span className="error-dot" aria-hidden="true" />
            {alertMessage}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {model.actions.map((action) => {
            if (action.kind === "link") {
              return (
                <Link key={action.action} href={action.href} prefetch={false} className={linkClass}>
                  {action.label}
                </Link>
              );
            }
            const busy = pending === action.kind;
            return (
              <Button
                key={action.kind}
                type="button"
                variant="outline"
                disabled={
                  pending !== null ||
                  (disableCartPurchaseAgain &&
                    action.kind === "purchase_again" &&
                    action.target === "cart")
                }
                aria-busy={busy ? true : undefined}
                onClick={() => onAction(action)}
              >
                {action.label}
              </Button>
            );
          })}
        </div>
      </section>

      <section
        aria-labelledby={itemsId}
        className="surface-ink bleed section-y relative mt-4 flex flex-col gap-6"
      >
        <Sticker
          kind="chip"
          color="coral"
          tilt={11}
          size={48}
          className="absolute -top-6 right-6 md:right-24"
        />
        <SectionHeading id={itemsId}>{copy.purchase.itemsHeading}</SectionHeading>
        <ul className="grid max-w-5xl gap-6 md:grid-cols-2">
          {model.items.map((item) => (
            <li key={item.key} className="card">
              <p className="card__value">{item.name}</p>
              <p className="card__label">{item.kindLabel}</p>
              {item.quantityText === null ? null : <p>{item.quantityText}</p>}
              {item.usageText === null ? null : <p>{item.usageText}</p>}
              <p>
                <span className="font-bold">{copy.cart.unitPriceLabel}</span>{" "}
                <span className="num">{item.unitPriceText}</span>
              </p>
              <p>
                <span className="font-bold">{copy.cart.subtotalLabel}</span>{" "}
                <span className="num">{item.subtotalText}</span>
              </p>
            </li>
          ))}
        </ul>
        <p className="text-lead">
          <span>{copy.purchase.totalLabel}</span> <span className="num">{model.totalText}</span>
        </p>
      </section>

      {entitlements === null ? null : (
        <section aria-labelledby={rightsId} className="flex max-w-3xl flex-col gap-6">
          <SectionHeading id={rightsId}>{copy.purchase.entitlements.heading}</SectionHeading>
          {entitlements.entryTickets.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <SectionHeading id={`${rightsId}-entry`} level={3}>
                {copy.purchase.entitlements.entryHeading}
              </SectionHeading>
              <ul className="flex flex-col gap-1">
                {entitlements.entryTickets.map((ticket) => (
                  <li key={ticket.ref}>
                    <Link href={ticket.href} prefetch={false} className={linkClass}>
                      {ticket.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {entitlements.reservation === null ? null : (
            <div className="flex flex-col gap-2">
              <SectionHeading id={`${rightsId}-karaoke`} level={3}>
                {copy.purchase.entitlements.karaokeHeading}
              </SectionHeading>
              <p>
                <Link href={entitlements.reservation.href} prefetch={false} className={linkClass}>
                  {entitlements.reservation.label}
                </Link>
              </p>
            </div>
          )}
          {entitlements.goodsItems.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <SectionHeading id={`${rightsId}-goods`} level={3}>
                {copy.purchase.entitlements.goodsHeading}
              </SectionHeading>
              <ul className="flex flex-col gap-2">
                {entitlements.goodsItems.map((goods) => (
                  <li key={goods.ref} className="flex flex-col gap-1">
                    <Link href={goods.href} prefetch={false} className={linkClass}>
                      {goods.label}
                    </Link>
                    <span className="text-small">
                      {goods.itemLabel} / {goods.handoffLabel}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-small">{copy.goods.detail.pickupNotice}</p>
            </div>
          )}
        </section>
      )}

      {model.receiptHref === null ? null : (
        <p>
          <ExternalLink href={model.receiptHref} className={linkClass}>
            {copy.purchase.receipt.link}
          </ExternalLink>
        </p>
      )}
    </div>
  );
}
