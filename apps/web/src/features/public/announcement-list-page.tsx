"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../api-client/provider";
import { settleRead } from "../../api-client/settle-read";
import type { AnnouncementSummary } from "../../api-client/types";
import { DateTime } from "../../presentation/components/date-time";
import type { Loadable } from "../../presentation/components/list-state";
import { PageState } from "../../presentation/components/page-state";
import { PlainText } from "../../presentation/components/plain-text";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Sticker } from "../../presentation/decor/sticker";
import { Link } from "../../routing/link";
import { buildAnnouncementListModel } from "./announcement-model";

// PG-PUB-002 container: reads after mount through the port; the first render is always loading.
export function AnnouncementListPage() {
  const api = useApi();
  const [input, setInput] = useState<Loadable<readonly AnnouncementSummary[]>>({
    kind: "loading",
  });
  const token = useRef(0);

  const load = useCallback(() => {
    token.current += 1;
    const current = token.current;
    void settleRead(api.public.listAnnouncements()).then((result) => {
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

  const list = buildAnnouncementListModel(input);

  return (
    <div className="flex flex-col gap-12">
      <PageHero title={copy.announcements.heading} />
      {list.kind === "loading" ? <PageState state="loading" /> : null}
      {list.kind === "empty" ? <PageState state="empty" /> : null}
      {list.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(copy.announcements.subject)}
          onRetry={reload}
        />
      ) : null}
      {list.kind === "items" ? (
        <div className="surface-ink bleed section-y relative">
          <Sticker
            kind="chip"
            color="mint"
            tilt={6}
            size={48}
            className="absolute -top-6 left-[max(var(--page-x),calc((100vw-var(--content-max))/2))]"
          />
          <ul className="grid gap-6 md:grid-cols-2">
            {list.items.map((item) => (
              <li key={item.announcementRef} className="card">
                <Link href={item.href} prefetch={false} className="link text-h3 self-start">
                  {item.title}
                </Link>
                <DateTime instant={item.publishedAt} className="card__label num" />
                <PlainText className="measure">{item.excerpt}</PlainText>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
