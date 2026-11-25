"use client";

import { type FormEvent, Suspense, useId, useRef, useState } from "react";
import { accountPath, CONTINUATION_PARAM, parseContinuation } from "../../auth/continuation";
import { useAuth } from "../../auth/use-auth";
import { ErrorSummary } from "../../presentation/components/error-summary";
import { FormField } from "../../presentation/components/form-field";
import { Button } from "../../presentation/components/ui/button";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Sticker } from "../../presentation/decor/sticker";
import { Link } from "../../routing/link";
import { useSearchParams } from "../../routing/navigation";
import {
  type FieldError,
  fieldErrorMessage,
  normalizeEmail,
  validateResetRequestForm,
} from "./form-validation";
import { ServiceFailure } from "./service-failure";
import { useErrorSummaryFocus } from "./use-error-summary-focus";

const linkClass = "link inline-block py-2";

type Outcome = "accepted" | "unavailable" | null;

// PG-AUTH-004. Every email gets the same acceptance (SEC-API-027); the Session never changes.
function ResetRequestForm() {
  const auth = useAuth();
  const searchParams = useSearchParams();
  const intent = parseContinuation(searchParams.get(CONTINUATION_PARAM));

  const emailId = `${useId()}-email`;
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const { summaryRef, requestFocus } = useErrorSummaryFocus();

  const emailError = errors.find((error) => error.field === "email");

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submittingRef.current) return;
    const validation = validateResetRequestForm({ email });
    if (!validation.ok) {
      setErrors(validation.errors);
      setOutcome(null);
      requestFocus();
      return;
    }
    setErrors([]);
    setOutcome(null);
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await auth.requestPasswordReset({ email: normalizeEmail(email) });
      setOutcome(result.kind);
    } catch {
      setOutcome("unavailable");
    }
    submittingRef.current = false;
    setSubmitting(false);
  };

  return (
    <div className="flex flex-col">
      <PageHero title={copy.auth.reset.heading} />
      <div className="flex w-full max-w-xl flex-col gap-6">
        {errors.length > 0 ? (
          <ErrorSummary
            items={errors.map((error) => ({ fieldId: emailId, message: fieldErrorMessage(error) }))}
            summaryRef={summaryRef}
          />
        ) : null}
        {outcome === "accepted" ? (
          <p role="status" className="card measure text-small font-bold">
            {copy.auth.reset.accepted}
          </p>
        ) : null}
        {outcome === "unavailable" ? (
          <ServiceFailure message={copy.auth.reset.unavailable} />
        ) : null}
        <form
          noValidate
          onSubmit={onSubmit}
          aria-busy={submitting ? true : undefined}
          className="flex flex-col gap-4"
        >
          <FormField
            id={emailId}
            label={copy.auth.field.email.label}
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            error={emailError === undefined ? null : fieldErrorMessage(emailError)}
          />
          <div>
            <Button type="submit" disabled={submitting}>
              {submitting ? copy.auth.form.submitting : copy.auth.reset.submit}
            </Button>
          </div>
        </form>
      </div>
      <div className="surface-ink bleed section-y relative mt-16">
        <Sticker
          kind="chip"
          color="teal"
          tilt={-4}
          size={48}
          className="absolute -top-6 right-6 md:right-24"
        />
        <p className="measure">
          <Link href={accountPath("login", intent)} prefetch={false} className={linkClass}>
            {copy.auth.reset.backToLogin}
          </Link>
        </p>
      </div>
    </div>
  );
}

export function PasswordResetRequestPage() {
  return (
    <Suspense fallback={null}>
      <ResetRequestForm />
    </Suspense>
  );
}
