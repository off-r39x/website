"use client";

import { type RefCallback, useCallback } from "react";

// One IntersectionObserver watches every decoration that has an entrance (DESIGN 9.3). It only runs once
// public/motion-init.js has put .motion-ok on <html>; otherwise the CSS shows the final state and nothing is observed.
let observer: IntersectionObserver | null = null;

function sharedObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer?.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -15% 0px" },
  );
  return observer;
}

/** Ref callback that marks the element `.is-in` the first time it enters the view. */
export function useEnter<T extends Element>(): RefCallback<T> {
  return useCallback((element: T | null) => {
    if (element === null) return;
    if (!document.documentElement.classList.contains("motion-ok")) return;
    const io = sharedObserver();
    io.observe(element);
    return () => io.unobserve(element);
  }, []);
}
