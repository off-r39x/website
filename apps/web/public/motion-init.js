// Motion bootstrap (docs/DESIGN.md 9.3). A classic same-origin script in <head>, so it runs before the first paint
// (no flash of decorations that then disappear) without an inline script (SPEC-140 21: script-src 'self').
// Without this script, under reduced motion or without IntersectionObserver, every decoration shows its final state.
(() => {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window))
    return;
  root.classList.add("motion-ok");
  // The Home opening plays once per tab session; ?intro replays it for design review (DESIGN 9.4).
  if (location.pathname !== "/") {
    root.classList.add("intro-seen");
    return;
  }
  try {
    if (
      new URLSearchParams(location.search).has("intro") ||
      !sessionStorage.getItem("r39x.intro-seen")
    ) {
      root.classList.add("is-intro");
      sessionStorage.setItem("r39x.intro-seen", "1");
    } else {
      root.classList.add("intro-seen");
    }
  } catch {
    root.classList.add("intro-seen");
  }
})();
