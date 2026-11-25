import { ExternalLink } from "../../presentation/components/external-link";
import { copy } from "../../presentation/copy/ja";

// The Receipt link of a detail page (SPEC-050 23). It is rendered only for a safe https URL that the
// model supplied; with no URL there is no link and no heading (a Receipt is never invented).

export function ReceiptLink({ href }: { href: string | null }) {
  if (href === null) return null;
  return (
    <p>
      <ExternalLink href={href} className="link inline-flex min-h-11 items-center">
        {copy.purchase.receipt.link}
      </ExternalLink>
    </p>
  );
}
