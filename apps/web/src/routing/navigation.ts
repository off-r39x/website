import { useMemo } from "react";
import { useLocation, useNavigate, useSearchParams as useRouterSearchParams } from "react-router";

// Next-compatible navigation hooks over React Router (DEV-WEB-001). Call sites keep `usePathname()`,
// `useRouter().push / replace` and `useSearchParams().get(...)`.

export function usePathname(): string {
  return useLocation().pathname;
}

export type AppRouter = {
  push: (href: string) => void;
  replace: (href: string) => void;
};

/**
 * Programmatic navigations run in a view transition like Links do (DESIGN 9.7; see link.tsx).
 * `navigate` is stable in a data router, so the returned object is stable too. It must stay so: AuthGate and the
 * Session provider list `router` in their effect dependencies, and a new object per render would re-run them.
 */
export function useRouter(): AppRouter {
  const navigate = useNavigate();
  return useMemo(
    (): AppRouter => ({
      push: (href) => {
        void navigate(href, { viewTransition: true });
      },
      replace: (href) => {
        void navigate(href, { replace: true, viewTransition: true });
      },
    }),
    [navigate],
  );
}

/** Read-only: the query string is changed by navigating, never by writing to these params. */
export function useSearchParams(): URLSearchParams {
  const [searchParams] = useRouterSearchParams();
  return searchParams;
}
