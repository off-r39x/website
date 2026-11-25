import { InkBand } from "../presentation/components/ink-band";
import { copy } from "../presentation/copy/ja";
import { PageHero } from "../presentation/decor/page-hero";
import { DecorSymbols } from "../presentation/decor/symbols";

// The root error boundary: shown only when the root layout itself cannot render (for example a port factory that
// fails closed), so this is then the only main landmark in the document. SEC-WEB-012: fixed wording only, the
// error object is never touched.
export default function RootError() {
  return (
    <main id="main-content" tabIndex={-1} className="site-main outline-none">
      <DecorSymbols />
      <div className="flex flex-col gap-12">
        <PageHero title={copy.errorPage.title} />
        <InkBand>
          <p>{copy.errorPage.description}</p>
        </InkBand>
      </div>
    </main>
  );
}
