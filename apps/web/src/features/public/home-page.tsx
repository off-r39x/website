"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../api-client/provider";
import { settleRead } from "../../api-client/settle-read";
import type { AnnouncementSummary, EventInfo, FaqItem } from "../../api-client/types";
import { assets } from "../../config/assets";
import { DateTime } from "../../presentation/components/date-time";
import type { Loadable } from "../../presentation/components/list-state";
import { PageState } from "../../presentation/components/page-state";
import { PlainText } from "../../presentation/components/plain-text";
import { SectionHeading } from "../../presentation/components/section-heading";
import { buttonVariants } from "../../presentation/components/ui/button";
import { cn } from "../../presentation/components/ui/cn";
import { copy } from "../../presentation/copy/ja";
import { Diamond } from "../../presentation/decor/diamond";
import { useHomeOpening } from "../../presentation/decor/home-opening";
import { PageHero } from "../../presentation/decor/page-hero";
import { SpeedLines } from "../../presentation/decor/speed-lines";
import { Sticker } from "../../presentation/decor/sticker";
import { StretchText } from "../../presentation/decor/stretch-text";
import { Ticker } from "../../presentation/decor/ticker";
import { useHeroInView } from "../../presentation/decor/use-hero-in-view";
import { Link } from "../../routing/link";
import { buildHomeModel, HOME_NEWS_LIMIT, type HomeSection } from "./home-model";

type Section<K extends HomeSection["key"]> = Extract<HomeSection, { key: K }>;

const LOADING = { kind: "loading" } as const;
const linkClass = "link";
const sectionClass = "mt-24 flex flex-col gap-6";
// The big year beside the logo is a word written on the logo (DESIGN 0, 6.3).
const HERO_YEAR = "2027";

// PG-PUB-001 container: reads after mount through the port; the first render is always loading.
export function HomePage() {
  const api = useApi();
  const [event, setEvent] = useState<Loadable<EventInfo>>(LOADING);
  const [announcements, setAnnouncements] =
    useState<Loadable<readonly AnnouncementSummary[]>>(LOADING);
  const [faqs, setFaqs] = useState<Loadable<readonly FaqItem[]>>(LOADING);
  const tokens = useRef({ event: 0, announcements: 0, faqs: 0 });

  const loadEvent = useCallback(() => {
    tokens.current.event += 1;
    const token = tokens.current.event;
    void settleRead(api.public.getEvent()).then((result) => {
      if (tokens.current.event === token) setEvent(result);
    });
  }, [api]);
  const loadAnnouncements = useCallback(() => {
    tokens.current.announcements += 1;
    const token = tokens.current.announcements;
    void settleRead(api.public.listAnnouncements({ limit: HOME_NEWS_LIMIT })).then((result) => {
      if (tokens.current.announcements === token) setAnnouncements(result);
    });
  }, [api]);
  const loadFaqs = useCallback(() => {
    tokens.current.faqs += 1;
    const token = tokens.current.faqs;
    void settleRead(api.public.listFaqs()).then((result) => {
      if (tokens.current.faqs === token) setFaqs(result);
    });
  }, [api]);

  useEffect(() => {
    const current = tokens.current;
    loadEvent();
    loadAnnouncements();
    loadFaqs();
    return () => {
      // Late results of an unmounted page are ignored.
      current.event += 1;
      current.announcements += 1;
      current.faqs += 1;
    };
  }, [loadEvent, loadAnnouncements, loadFaqs]);

  const reloadAll = (): void => {
    setEvent(LOADING);
    setAnnouncements(LOADING);
    setFaqs(LOADING);
    loadEvent();
    loadAnnouncements();
    loadFaqs();
  };
  const reloadNews = (): void => {
    setAnnouncements(LOADING);
    loadAnnouncements();
  };
  const reloadFaqs = (): void => {
    setFaqs(LOADING);
    loadFaqs();
  };

  const model = buildHomeModel({ event, announcements, faqs });

  if (model.kind === "loading") {
    return (
      <PageHero title={copy.home.fallbackHeading}>
        <PageState state="loading" />
      </PageHero>
    );
  }
  if (model.kind === "error") {
    return (
      <PageHero title={copy.home.fallbackHeading}>
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(copy.home.subject)}
          onRetry={reloadAll}
        />
      </PageHero>
    );
  }

  return (
    <div className="flex flex-col">
      {model.sections.map((section) => {
        switch (section.key) {
          case "hero":
            return <Hero key={section.key} section={section} />;
          case "news":
            return <News key={section.key} section={section} onRetry={reloadNews} />;
          case "salesShortcut":
            // The running band crosses the boundary from the white news into this black section (DESIGN 6.5, 8.7).
            return (
              <Fragment key={section.key}>
                <Ticker className="home-ticker" />
                <SalesShortcut section={section} />
              </Fragment>
            );
          case "overview":
            return <Overview key={section.key} section={section} />;
          case "schedule":
            return <Schedule key={section.key} section={section} />;
          case "venue":
            return <Venue key={section.key} section={section} />;
          case "notices":
            return <Notices key={section.key} section={section} />;
          case "faq":
            return <Faq key={section.key} section={section} onRetry={reloadFaqs} />;
          default: {
            const unreachable: never = section;
            return unreachable;
          }
        }
      })}
    </div>
  );
}

function Hero({ section }: { section: Section<"hero"> }) {
  const heroRef = useHeroInView<HTMLElement>();
  const stageRef = useRef<HTMLDivElement>(null);
  const burstRef = useRef<HTMLDivElement>(null);
  useHomeOpening(stageRef, burstRef);
  const logo = assets.logo;
  return (
    <header ref={heroRef} className="home-hero bleed">
      {logo === null ? null : (
        <div ref={stageRef} className="home-hero__stage">
          <div className="home-hero__diamond">
            <Diamond parallax introDelay={300} className="block size-full [--drift:96px]" />
          </div>
          <div ref={burstRef} className="absolute inset-0" />
          <img
            src={logo.src}
            alt={logo.alt}
            width={logo.width}
            height={logo.height}
            fetchPriority="high"
            className="home-hero__logo"
          />
          <Sticker
            kind="note"
            tilt={-8}
            index={0}
            size={72}
            introDelay={1300}
            className="absolute -top-4 -left-2 hidden lg:inline-block"
          />
          <Sticker
            kind="kira"
            tilt={12}
            index={1}
            size={64}
            group={1}
            introDelay={1300}
            className="absolute top-[8%] -right-2 lg:-right-12"
          />
          <Sticker
            kind="star"
            tilt={-14}
            index={2}
            size={56}
            introDelay={1300}
            className="absolute right-[6%] -bottom-6 lg:-right-16"
          />
        </div>
      )}
      <div className="home-hero__copy">
        <div className="quiet flex flex-col items-start gap-4">
          <Sticker
            kind="chip"
            color="coral"
            tilt={7}
            index={3}
            size={48}
            introDelay={1300}
            className="hidden lg:inline-block"
          />
          <StretchText text={HERO_YEAR} />
          <h1 className="text-h2">{section.eventName}</h1>
          {section.periodText === null ? null : (
            <p className="num text-lead">{section.periodText}</p>
          )}
          {section.venueName === null ? null : <p className="text-lead">{section.venueName}</p>}
          <p className="w-full pt-2 lg:w-auto">
            <Link href={section.ctaHref} prefetch={false} className={buttonVariants()}>
              {copy.layout.cta.buyTickets}
            </Link>
          </p>
        </div>
      </div>
    </header>
  );
}

function News({ section, onRetry }: { section: Section<"news">; onRetry: () => void }) {
  const { list } = section;
  return (
    <section aria-labelledby="home-news" className={cn(sectionClass, "relative")}>
      {/* Crosses the boundary from the hero (DESIGN 6.3, 6.5). */}
      <SpeedLines width={240} introDelay={2000} className="absolute -top-24 left-0" />
      <SectionHeading id="home-news">{copy.home.sections.news}</SectionHeading>
      {list.kind === "loading" ? <PageState state="loading" /> : null}
      {list.kind === "empty" ? <PageState state="empty" /> : null}
      {list.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(copy.home.sections.news)}
          onRetry={onRetry}
        />
      ) : null}
      {list.kind === "items" ? (
        <ul className="measure flex flex-col gap-4">
          {list.items.map((item) => (
            <li key={item.announcementRef} className="flex gap-3">
              <DiamondMark />
              <span className="flex flex-col">
                <Link href={item.href} prefetch={false} className={linkClass}>
                  {item.title}
                </Link>
                <DateTime instant={item.publishedAt} className="num text-small" />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        <Link href={section.viewAllHref} prefetch={false} className={linkClass}>
          {copy.home.news.viewAll}
        </Link>
      </p>
    </section>
  );
}

const SHORTCUT_LABEL = {
  entry: copy.home.shortcut.entry,
  karaoke: copy.home.shortcut.karaoke,
  goods: copy.home.shortcut.goods,
} as const;

const SHORTCUT_CHIP = { entry: "lemon", karaoke: "mint", goods: "teal" } as const;

function SalesShortcut({ section }: { section: Section<"salesShortcut"> }) {
  return (
    <section
      aria-labelledby="home-shortcut"
      className={cn(sectionClass, "surface-ink bleed section-y cut-diamond relative mt-24 pb-32")}
    >
      <SectionHeading id="home-shortcut">{copy.home.sections.salesShortcut}</SectionHeading>
      <div className="tilt-list grid gap-6 md:grid-cols-3">
        {section.links.map((link) => (
          <Link
            key={link.key}
            href={link.href}
            prefetch={false}
            className="card card--link text-h3 flex-row items-center gap-3"
          >
            <DiamondMark color={SHORTCUT_CHIP[link.key]} />
            {SHORTCUT_LABEL[link.key]}
          </Link>
        ))}
      </div>
    </section>
  );
}

function Overview({ section }: { section: Section<"overview"> }) {
  return (
    <section aria-labelledby="home-overview" className={sectionClass}>
      <SectionHeading id="home-overview">{copy.home.sections.overview}</SectionHeading>
      <p className="text-lead measure">{section.eventName}</p>
      <PlainText className="measure">{section.overview}</PlainText>
    </section>
  );
}

function Schedule({ section }: { section: Section<"schedule"> }) {
  return (
    <section aria-labelledby="home-schedule" className={sectionClass}>
      <SectionHeading id="home-schedule">{copy.home.sections.schedule}</SectionHeading>
      <div className="card w-fit max-w-full">
        <PlainText className="card__value num">{section.periodText}</PlainText>
      </div>
    </section>
  );
}

function Venue({ section }: { section: Section<"venue"> }) {
  return (
    <section aria-labelledby="home-venue" className={sectionClass}>
      <SectionHeading id="home-venue">{copy.home.sections.venue}</SectionHeading>
      {section.venueName === null ? null : <p className="text-lead measure">{section.venueName}</p>}
      {section.venueGuide === null ? null : (
        <PlainText className="measure">{section.venueGuide}</PlainText>
      )}
      {section.accessInfo === null ? null : (
        <PlainText className="measure">{section.accessInfo}</PlainText>
      )}
    </section>
  );
}

function Notices({ section }: { section: Section<"notices"> }) {
  return (
    <section
      aria-labelledby="home-notices"
      className={cn(sectionClass, "surface-ink bleed section-y relative")}
    >
      <Sticker
        kind="star"
        tilt={-6}
        size={64}
        className="absolute -top-8 right-[max(var(--page-x),calc((100vw-var(--content-max))/2))]"
      />
      <SectionHeading id="home-notices">{copy.home.sections.notices}</SectionHeading>
      <ul className="measure flex flex-col gap-3">
        {section.items.map((item, index) => (
          // Notices have no id: the original order is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: static list kept in its original order
          <li key={index} className="flex gap-3">
            <DiamondMark color="mint" />
            <PlainText>{item}</PlainText>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Faq({ section, onRetry }: { section: Section<"faq">; onRetry: () => void }) {
  const { list } = section;
  return (
    <section aria-labelledby="home-faq" className={sectionClass}>
      <SectionHeading id="home-faq">{copy.home.sections.faq}</SectionHeading>
      {list.kind === "loading" ? <PageState state="loading" /> : null}
      {list.kind === "empty" ? <PageState state="empty" /> : null}
      {list.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(copy.home.sections.faq)}
          onRetry={onRetry}
        />
      ) : null}
      {list.kind === "items" ? (
        <div className="grid gap-6 md:grid-cols-2">
          {list.items.map((item) => (
            <div key={item.id} className="card">
              <SectionHeading id={`home-faq-${item.id}`} level={3}>
                {item.question}
              </SectionHeading>
              <PlainText className="measure">{item.answer}</PlainText>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Small candy diamond used as a list bullet (DESIGN 5.3). Decorative. */
function DiamondMark({ color = "lemon" }: { color?: "lemon" | "mint" | "teal" | "coral" }) {
  return (
    <svg
      className="diamond-mark mt-2"
      style={{ color: `var(--${color})` }}
      aria-hidden="true"
      focusable="false"
    >
      <use href="#chip" />
    </svg>
  );
}
