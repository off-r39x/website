import type { Ref } from "react";
import { copy } from "../copy/ja";

export type ErrorSummaryItem = { readonly fieldId: string; readonly message: string };

/**
 * Summary of form errors with a link to each field (SPEC-050 25). It is the only alert of a form
 * with input errors; the container moves focus to it after a failed submit.
 */
export function ErrorSummary({
  items,
  summaryRef,
}: {
  items: readonly ErrorSummaryItem[];
  summaryRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={summaryRef} role="alert" tabIndex={-1} className="alert">
      <p className="font-bold">
        <span className="error-dot" aria-hidden="true" />
        {copy.auth.form.errorSummaryTitle}
      </p>
      <ul className="flex flex-col gap-1 pl-6">
        {items.map((item) => (
          <li key={`${item.fieldId}-${item.message}`}>
            <a
              href={`#${item.fieldId}`}
              className="link"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(item.fieldId)?.focus();
              }}
            >
              {item.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
