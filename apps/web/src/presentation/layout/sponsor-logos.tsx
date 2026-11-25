"use client";

import { useState } from "react";
import { copy } from "../copy/ja";
import type { SponsorItemModel } from "./sponsor-area-model";

function SponsorLogoItem({ item }: { item: SponsorItemModel }) {
  const [broken, setBroken] = useState(false);
  const showImage = item.imageSrc !== null && !broken;
  const content = (
    <>
      {showImage ? (
        <img
          src={item.imageSrc ?? ""}
          alt={item.name}
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="h-10 w-auto max-w-40"
        />
      ) : (
        <span>{item.name}</span>
      )}
      {item.externalHref !== null ? (
        <>
          <span className="sr-only">{copy.layout.sponsors.externalSuffix}</span>
          <span aria-hidden="true" className="text-caption">
            ↗
          </span>
        </>
      ) : null}
    </>
  );
  return (
    <li>
      {item.externalHref !== null ? (
        <a
          href={item.externalHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1 rounded-field border-3 border-paper bg-paper px-3 text-small font-bold text-ink hover:bg-mint"
        >
          {content}
        </a>
      ) : (
        <span className="inline-flex min-h-11 items-center gap-1 rounded-field border-3 border-paper bg-paper px-3 text-small font-bold text-ink">
          {content}
        </span>
      )}
    </li>
  );
}

/** Rendered only for a visible model: a hidden area leaves no DOM at all (SPEC-050 8.5). */
export function SponsorLogos({ items }: { items: readonly SponsorItemModel[] }) {
  return (
    <section aria-label={copy.layout.sponsors.regionLabel}>
      <ul className="flex flex-wrap items-center gap-3">
        {items.map((item) => (
          <SponsorLogoItem key={item.sponsorRef} item={item} />
        ))}
      </ul>
    </section>
  );
}
