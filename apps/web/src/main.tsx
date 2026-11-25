// Self-hosted web fonts (docs/DESIGN.md 4.1, SPEC-050 24.3): Fontsource CSS bundles the woff2 files into dist/assets,
// so they load from the own origin (font-src 'self', SEC-WEB-004). Only the japanese and latin subset files are used:
// the per-weight files split each weight into ~120 assets, beyond the 100 rules of dist/_headers. Within a family
// the latin file comes last, so it is checked first for latin characters and the japanese file loads only for the rest.
import "@fontsource-variable/fredoka/standard.css";
import "@fontsource/mochiy-pop-one/japanese-400.css";
import "@fontsource/mochiy-pop-one/latin-400.css";
import "@fontsource/zen-maru-gothic/japanese-400.css";
import "@fontsource/zen-maru-gothic/japanese-500.css";
import "@fontsource/zen-maru-gothic/japanese-700.css";
import "@fontsource/zen-maru-gothic/japanese-900.css";
import "@fontsource/zen-maru-gothic/latin-400.css";
import "@fontsource/zen-maru-gothic/latin-500.css";
import "@fontsource/zen-maru-gothic/latin-700.css";
import "@fontsource/zen-maru-gothic/latin-900.css";
import "./styles/globals.css";
// Must stay ahead of every import that defines a Zod schema (see zod-jitless.ts).
import "./config/zod-jitless";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { routes } from "./routes/route-table";

// Entry point of the static SPA (DEV-WEB-001): the first render is a client render, so every container
// starts from its loading state. No mock code is imported here; ports are chosen by the port factories.
const container = document.getElementById("root");
if (container === null) throw new Error("root element not found");

// A view transition is visual only: one skipped by the next navigation, or by a cross-document transition still
// running after a full load (@view-transition), rejects its `ready` promise, which React Router never awaits. The
// navigation itself still completes, and a failure of the DOM update keeps surfacing through `finished`.
if (typeof document.startViewTransition === "function") {
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = ((update?: Parameters<typeof start>[0]) => {
    const transition = start(update);
    transition.ready.catch(() => {});
    return transition;
  }) as typeof document.startViewTransition;
}

const router = createBrowserRouter(routes);

// React Router keeps the pathnames of view-transitioned navigations and writes them to sessionStorage on pagehide, to
// replay the transition on back / forward. No path may be stored there (SEC-AUTH-018, TC-STACK-008-306), so the entry
// is removed right after it is written: this listener runs after the router's own, which was added when it was
// created above. Back / forward inside the same document still animates from the in-memory record.
window.addEventListener("pagehide", () => {
  try {
    window.sessionStorage.removeItem("remix-router-transitions");
  } catch {
    // Storage unavailable: then the router could not have written the entry either.
  }
});

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
