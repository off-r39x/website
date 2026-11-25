"use client";

import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ApiPort } from "../../api-client/port";
import { useApi } from "../../api-client/provider";
import type { ProfileUpdate } from "../../api-client/types";
import { PageState } from "../../presentation/components/page-state";
import { Button } from "../../presentation/components/ui/button";
import { copy } from "../../presentation/copy/ja";
import { PageHero } from "../../presentation/decor/page-hero";
import { Link } from "../../routing/link";
import {
  buildProfileModel,
  checkDisplayNameInput,
  interpretProfileSave,
  resolveInputAfterSave,
} from "./profile-model";
import { useRead } from "./use-read";

// PG-MYP-002 container (SPEC-050 18.2, 25). One editable field: the display name. The email is text.
// The server decides what a valid name is (DEV-WEB-009): the value goes to the port as typed. The
// 80 code points / Cc pre-check only spares a round trip (SPEC-030 9.2); a blank name clears it.

const linkClass = "link inline-flex min-h-11 items-center";

type Phase = "idle" | "saving";

function ProfileForm({ email, initialName }: { email: string; initialName: string | null }) {
  const api = useApi();
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const [savedName, setSavedName] = useState(initialName ?? "");
  const [value, setValue] = useState(initialName ?? "");
  const [clearedByLastSave, setClearedByLastSave] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [justSaved, setJustSaved] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [focusRequests, setFocusRequests] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusRequests > 0) summaryRef.current?.focus();
  }, [focusRequests]);

  const status = (() => {
    if (phase === "saving") return copy.mypage.profile.status.saving;
    if (value !== savedName) return copy.mypage.profile.status.dirty;
    if (!justSaved) return "";
    return clearedByLastSave
      ? copy.mypage.profile.status.cleared
      : copy.mypage.profile.status.saved;
  })();

  const onChange = (next: string): void => {
    setValue(next);
    setJustSaved(false);
    setInvalid(null);
    setFailed(null);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (phase === "saving") return;
    setJustSaved(false);
    setInvalid(null);
    setFailed(null);
    const submitted = value;
    const checked = checkDisplayNameInput(submitted);
    if (checked.kind === "invalid") {
      setInvalid(checked.message);
      setFocusRequests((count) => count + 1);
      return;
    }
    setPhase("saving");
    const result: ProfileUpdate = await api.self
      .updateProfile({ displayName: submitted })
      .catch((): ProfileUpdate => ({ kind: "unavailable" }));
    setPhase("idle");
    const step = interpretProfileSave(result);
    switch (step.kind) {
      case "saved":
        setSavedName(step.displayName ?? "");
        setClearedByLastSave(step.displayName === null);
        setValue((current) =>
          resolveInputAfterSave({ current, submitted, saved: step.displayName }),
        );
        setJustSaved(true);
        return;
      case "invalid":
        setInvalid(step.message);
        setFocusRequests((count) => count + 1);
        return;
      case "failed":
        setFailed(step.message);
        return;
      default: {
        const unreachable: never = step;
        return unreachable;
      }
    }
  };

  const saving = phase === "saving";

  return (
    <div className="measure flex flex-col gap-8">
      <div className="card">
        <p className="flex flex-col break-words">
          <span className="card__label">{copy.mypage.profile.emailLabel}</span>{" "}
          <span className="card__value">{email}</span>
        </p>
        <p className="card__note">{copy.mypage.profile.emailNote}</p>
      </div>
      {invalid === null ? null : (
        <div ref={summaryRef} role="alert" tabIndex={-1} className="alert">
          <p className="font-bold">
            <span className="error-dot" aria-hidden="true" />
            {invalid}
          </p>
          <a
            href={`#${fieldId}`}
            className="link"
            onClick={(event) => {
              event.preventDefault();
              document.getElementById(fieldId)?.focus();
            }}
          >
            {copy.mypage.profile.displayNameLabel}
          </a>
        </div>
      )}
      {failed === null ? null : (
        <p role="alert" className="alert block">
          <span className="error-dot" aria-hidden="true" />
          {failed}
        </p>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor={fieldId} className="field-label">
            {copy.mypage.profile.displayNameLabel}
          </label>
          <input
            id={fieldId}
            type="text"
            autoComplete="name"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={invalid === null ? undefined : true}
            placeholder={copy.mypage.profile.unset}
            aria-describedby={invalid === null ? hintId : `${hintId} ${errorId}`}
            className="field w-full"
          />
          <p id={hintId} className="text-small">
            {copy.mypage.profile.displayNameHint}
          </p>
          {invalid === null ? null : (
            <p id={errorId} className="text-small font-bold">
              <span className="error-dot" aria-hidden="true" />
              {invalid}
            </p>
          )}
        </div>
        <div>
          <Button type="submit" disabled={saving} aria-busy={saving ? true : undefined}>
            {copy.mypage.profile.save}
          </Button>
        </div>
        <div role="status" className="text-small font-bold">
          {status}
        </div>
      </form>
      <div className="flex flex-col gap-2">
        <p className="text-small">{copy.mypage.profile.passwordNote}</p>
        <p>
          <Link href="/account/password-reset" prefetch={false} className={linkClass}>
            {copy.mypage.profile.passwordReset}
          </Link>
        </p>
      </div>
    </div>
  );
}

export function ProfilePage() {
  const load = useCallback((api: ApiPort) => api.self.getProfile(), []);
  const { read, reload } = useRead(load);
  const model = buildProfileModel(read);

  return (
    <div className="flex flex-col gap-12 pb-16">
      <PageHero title={copy.mypage.profile.heading} />
      {model.kind === "loading" ? <PageState state="loading" /> : null}
      {model.kind === "unavailable" ? (
        <PageState
          state="unavailable"
          message={copy.pageState.unavailable(copy.mypage.profile.subject)}
          onRetry={reload}
        />
      ) : null}
      {model.kind === "ready" ? (
        <ProfileForm email={model.email} initialName={model.displayName} />
      ) : null}
    </div>
  );
}
