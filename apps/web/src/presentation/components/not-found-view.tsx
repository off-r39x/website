import { HOME_HREF } from "../../config/site";
import { Link } from "../../routing/link";
import { copy } from "../copy/ja";
import { PageHero } from "../decor/page-hero";
import { InkBand } from "./ink-band";

// Same view as app/not-found.tsx (PG-XFN-002): shows nothing about the requested resource (SPEC-050 19.1).

export function NotFoundView() {
  return (
    <div className="flex flex-col gap-12">
      <PageHero title={copy.notFound.title}>
        <p>{copy.notFound.description}</p>
      </PageHero>
      <InkBand>
        <p>
          <Link href={HOME_HREF} className="link">
            {copy.notFound.homeLink}
          </Link>
        </p>
      </InkBand>
    </div>
  );
}
