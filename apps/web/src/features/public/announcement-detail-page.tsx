"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../api-client/provider";
import { settleRead } from "../../api-client/settle-read";
import type { Announcement, Ref } from "../../api-client/types";
import { DateTime } from "../../presentation/components/date-time";
import type { Loadable } from "../../presentation/components/list-state";
import { NotFoundView } from "../../presentation/components/not-found-view";
import { PageState } from "../../presentation/components/page-state";
import { PlainText } from "../../presentation/components/plain-text";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Sticker } from "../../presentation/decor/sticker";
import { Link } from "../../routing/link";
import { buildAnnouncementDetailModel } from "./announcement-model";

const linkClass = "link";

// PG-PUB-003 container: reads after mount through the port; the first render is always loading.
export function AnnouncementDetailPage({
  announcementRef,
}: {
  announcementRef: Ref<"announcement">;
}) {
  const api = useApi();
  const [input, setInput] = useState<Loadable<Announcement>>({ kind: "loading" });
  const token = useRef(0);

  const load = useCallback(() => {
    token.current += 1;
    const current = token.current;
    void settleRead(api.public.getAnnouncement(announcementRef)).then((result) => {
      if (token.current === current) setInput(result);
    });
  }, [api, announcementRef]);

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

  const model = buildAnnouncementDetailModel(input);

  // Not Found shows the shared view only: nothing of the announcement is exposed (SPEC-050 11.3, 19.1).
  if (model.kind === "not_found") return <NotFoundView />;

  if (model.kind !== "ready") {
    return (
      <div className="flex flex-col gap-12">
        <PageHero title={copy.announcements.heading} />
        {model.kind === "loading" ? (
          <PageState state="loading" />
        ) : (
          <PageState
            state="unavailable"
            message={copy.pageState.unavailable(copy.announcements.subject)}
            onRetry={reload}
          />
        )}
      </div>
    );
  }

  return (
    <article className="flex flex-col gap-12">
      <PageHero title={model.title}>
        <DateTime instant={model.publishedAt} className="num" />
      </PageHero>
      <div className="surface-ink bleed section-y relative">
        <Sticker
          kind="chip"
          color="coral"
          tilt={-6}
          size={48}
          className="absolute -top-6 right-[max(var(--page-x),calc((100vw-var(--content-max))/2))]"
        />
        <PlainText className="measure">{model.body}</PlainText>
      </div>
      <p className="flex flex-wrap gap-x-6 gap-y-3">
        <Link href={model.listHref} prefetch={false} className={linkClass}>
          {copy.announcements.backToList}
        </Link>
        <Link href={model.homeHref} prefetch={false} className={linkClass}>
          {copy.announcements.backHome}
        </Link>
      </p>
    </article>
  );
}
