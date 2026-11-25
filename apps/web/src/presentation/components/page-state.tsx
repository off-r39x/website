import type { ReactNode } from "react";
import { copy } from "../copy/ja";
import { Button } from "./ui/button";

// Loading, empty and unavailable look different and read differently (SPEC-050 9, 21).
// Loading never shows a business result; unavailable names the failed subject and only re-reads.

export type PageStateProps =
  | { state: "loading" }
  | { state: "empty"; message?: ReactNode }
  | { state: "unavailable"; message: string; retryLabel?: string; onRetry: () => void };

export function PageState(props: PageStateProps) {
  switch (props.state) {
    case "loading":
      return (
        <p role="status" className="text-small font-bold">
          {copy.pageState.loading}
        </p>
      );
    case "empty":
      return <p className="text-small">{props.message ?? copy.pageState.empty}</p>;
    case "unavailable":
      return (
        <div role="alert" className="alert">
          <p>
            <span className="error-dot" aria-hidden="true" />
            {props.message}
          </p>
          <Button type="button" variant="outline" onClick={props.onRetry}>
            {props.retryLabel ?? copy.pageState.retry}
          </Button>
        </div>
      );
    default: {
      const unreachable: never = props;
      return unreachable;
    }
  }
}
