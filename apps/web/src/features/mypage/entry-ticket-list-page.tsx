"use client";

import { useCallback } from "react";
import type { ApiPort } from "../../api-client/port";
import { PageState } from "../../presentation/components/page-state";
import { StatusBadge } from "../../presentation/components/status-badge";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Link } from "../../routing/link";
import { buildEntryTicketListModel } from "./entry-ticket-model";
import { useRead } from "./use-read";

// PG-MYP-005 container (SPEC-050 18.5, 20.2). Each Ticket shows its own state as text.

const linkClass = "link inline-flex min-h-11 items-center";

export function EntryTicketListPage() {
  const load = useCallback((api: ApiPort) => api.self.listEntryTickets(), []);
  const { read, reload } = useRead(load);
  const model = buildEntryTicketListModel(read);

  return (
    <div className="flex flex-col gap-12 pb-16">
      <PageHero title={copy.mypage.entryTickets.heading} />
      {model.kind === "loading" ? <PageState state="loading" /> : null}
      {model.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(copy.mypage.entryTickets.subject)}
          onRetry={reload}
        />
      ) : null}
      {model.kind === "empty" ? (
        <PageState state="empty" message={copy.mypage.entryTickets.empty} />
      ) : null}
      {model.kind === "items" ? (
        <ul className="grid gap-6 md:grid-cols-2">
          {model.items.map((row) => (
            <li key={row.ticketRef} className="card items-start">
              <p className="card__value">{row.name}</p>
              <p className="flex flex-col items-start gap-1">
                <span className="card__label">{copy.mypage.entryTickets.stateLabel}</span>
                <StatusBadge tone={row.tone} label={row.stateLabel} />
              </p>
              <div className="flex flex-wrap gap-x-6">
                <Link href={row.href} prefetch={false} className={linkClass}>
                  {row.linkLabel}
                </Link>
                <Link href={row.orderHref} prefetch={false} className={linkClass}>
                  {copy.mypage.entryTickets.orderLink}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
