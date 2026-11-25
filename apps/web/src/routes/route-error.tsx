import { useLocation, useNavigate } from "react-router";
import { HOME_HREF } from "../config/site";
import { InkBand } from "../presentation/components/ink-band";
import { Button } from "../presentation/components/ui/button";
import { copy } from "../presentation/copy/ja";
import { PageHero } from "../presentation/decor/page-hero";
import { Link } from "../routing/link";

// The pathless route's error boundary, shown inside the root layout's main landmark so the header and footer stay.
// SEC-WEB-012: the error object is never read, rendered or logged; only fixed wording is shown. Retrying replaces
// the current location with itself, which clears the boundary without reloading the document.
export default function RouteError() {
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();
  return (
    <div className="flex flex-col gap-12">
      <PageHero title={copy.errorPage.title}>
        <p>{copy.errorPage.description}</p>
      </PageHero>
      <InkBand>
        <div className="flex flex-wrap items-center gap-6">
          <Button
            type="button"
            onClick={() => {
              void navigate({ pathname, search, hash }, { replace: true });
            }}
          >
            {copy.errorPage.retry}
          </Button>
          <Link href={HOME_HREF} className="link">
            {copy.errorPage.homeLink}
          </Link>
        </div>
      </InkBand>
    </div>
  );
}
