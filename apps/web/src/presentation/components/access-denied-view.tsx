import { Link } from "../../routing/link";
import { copy } from "../copy/ja";
import { PageHero } from "../decor/page-hero";
import { InkBand } from "./ink-band";

// PG-XFN-003 part (SPEC-050 19.2). It shows nothing about the target: not its content, its existence,
// its owner or its state. A retry cannot grant access, so there is no retry control.

export function AccessDeniedView({ listHref, listLabel }: { listHref: string; listLabel: string }) {
  return (
    <div className="flex flex-col gap-12">
      <PageHero title={copy.accessDenied.title}>
        <p>{copy.accessDenied.description}</p>
      </PageHero>
      <InkBand>
        <p className="flex flex-wrap gap-4">
          <Link href="/mypage" prefetch={false} className="link">
            {copy.accessDenied.mypageLink}
          </Link>
          <Link href={listHref} prefetch={false} className="link">
            {listLabel}
          </Link>
        </p>
      </InkBand>
    </div>
  );
}
