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
 * Programmatic navigations (redirects, the Logout hand-off, flow steps) switch without a view transition: only a
 * Link the user follows opens the page as a diamond (DESIGN 9.7, link.tsx). A transition defers React's commit of
 * the new location, and a redirect or Logout must take effect at once: the Logout hand-off ends when Home is
 * rendered, and a Back pressed before that left the gate of the page returned to without its Login redirect.
 * `navigate` is stable in a data router, so the returned object is stable too. It must stay so: AuthGate and the
 * Session provider list `router` in their effect dependencies, and a new object per render would re-run them.
 */
export function useRouter(): AppRouter {
  const navigate = useNavigate();
  return useMemo(
    (): AppRouter => ({
      push: (href) => {
        void navigate(href);
      },
      replace: (href) => {
        void navigate(href, { replace: true });
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
