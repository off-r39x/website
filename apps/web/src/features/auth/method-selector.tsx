"use client";

import { useId } from "react";
import { AUTH_METHODS, type AuthMethod, authMethodLabel } from "./auth-methods";

/**
 * The method choice of PG-AUTH-001 / 003 as a native radio group. Choosing a method only changes the
 * value: it moves no focus and starts no navigation (SPEC-050 15.0).
 */
export function MethodSelector({
  legend,
  value,
  onChange,
  disabled,
}: {
  legend: string;
  value: AuthMethod;
  onChange: (method: AuthMethod) => void;
  disabled?: boolean;
}) {
  const baseId = useId();
  return (
    <fieldset className="flex flex-col gap-1" disabled={disabled}>
      <legend className="field-label mb-2">{legend}</legend>
      {AUTH_METHODS.map((method) => {
        const id = `${baseId}-${method}`;
        return (
          <div key={method} className="flex min-h-11 items-center gap-3">
            <input
              id={id}
              type="radio"
              name={baseId}
              checked={value === method}
              onChange={() => onChange(method)}
              className="size-5"
            />
            <label htmlFor={id} className="font-bold">
              {authMethodLabel(method)}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
