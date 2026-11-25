"use client";

import { type RefCallback, useCallback } from "react";

/**
 * Marks <html data-hero-in-view> while the Home hero is on screen, so the Header shows the site name instead of a
 * second logo (DESIGN 6.3, 8.3, 7.2). Observed with IntersectionObserver, never the scroll event (DESIGN 9.3).
 */
export function useHeroInView<T extends Element>(): RefCallback<T> {
  return useCallback((element: T | null) => {
    if (element === null) return;
    const root = document.documentElement;
    if (typeof IntersectionObserver === "undefined") {
      root.dataset.heroInView = "true";
      return () => {
        delete root.dataset.heroInView;
      };
    }
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) root.dataset.heroInView = "true";
      else delete root.dataset.heroInView;
    });
    io.observe(element);
    return () => {
      io.disconnect();
      delete root.dataset.heroInView;
    };
  }, []);
}
