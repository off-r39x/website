import type { ChangeEvent } from "react";
import { Input } from "./ui/input";

/**
 * A labelled text input. An error is shown as text and tied to the input with aria-invalid and
 * aria-describedby (SPEC-050 25); the hint stays tied to it too.
 */
export function FormField({
  id,
  label,
  type,
  autoComplete,
  inputMode,
  value,
  onChange,
  hint,
  error,
}: {
  id: string;
  label: string;
  type: "email" | "password" | "text";
  autoComplete: string;
  inputMode?: "numeric";
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null;
  const describedBy = [hint !== undefined ? hintId : null, hasError ? errorId : null]
    .filter((part): part is string => part !== null)
    .join(" ");

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {hint !== undefined ? (
        <p id={hintId} className="text-small">
          {hint}
        </p>
      ) : null}
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        aria-invalid={hasError ? true : undefined}
        aria-describedby={describedBy === "" ? undefined : describedBy}
        className="w-full"
      />
      {hasError ? (
        <p id={errorId} className="text-small font-bold">
          <span className="error-dot" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
