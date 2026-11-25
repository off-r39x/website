import { expect, type Page, test } from "@playwright/test";
import { copy } from "../../apps/web/src/presentation/copy/ja.ts";
import { gotoViaPrimaryMenu } from "../harness/browser/header-menu.ts";
import { gotoHydrated, reloadHydrated } from "../harness/browser/hydration.ts";
import { dbJson, publicScenario } from "../harness/browser/public.ts";
import { openAs } from "../harness/browser/purchase.ts";
import { seedLocalStorage } from "../harness/browser/shell.ts";
import { ANNOUNCEMENT, ORDER } from "../harness/mock-seed.ts";

// UI mock suite (TST-E2E-004: auxiliary, not G8). docs/DESIGN.md is the owner of the visual expression
// (SPEC-050 24.3 v2.3.0): the running band (8.7, 12), page transitions (9.7, 9.8), candy lettering only up to two
// lines (5.1), one black surface per page state (7.1) and one primary button per screen (8.1).

const LOGO_WORDS = "off-r39x おふりみっくす in 大阪らへん 2027";
const main = (page: Page) => page.getByRole("main");
const marquee = (page: Page) => page.getByRole("marquee");

test.describe("TC-PG-PUB-001-321 Home has one running band of the logo words that stops on hover and focus (DESIGN 8.7, 12)", () => {
  test("one focusable marquee named by the logo words, its moving copies hidden, a 40s loop that pauses on focus", async ({
    page,
  }) => {
    await gotoHydrated(page, "/");
    await expect(marquee(page)).toHaveCount(1);
    const band = marquee(page);
    await expect(band).toHaveAttribute("tabindex", "0");
    await expect(band).toHaveAttribute("aria-label", LOGO_WORDS);
    await expect(band.locator(":scope > [aria-hidden='true']")).toHaveCount(1);
    // Only the logo words and the star separator run in the band.
    const text = (await band.textContent()) ?? "";
    expect(text.replace(/off-r39x|おふりみっくす|in 大阪らへん|2027|★|\s/g, "")).toBe("");
    const track = band.locator(".ticker__track");
    const style = () =>
      track.evaluate((el) => {
        const s = getComputedStyle(el);
        return { duration: s.animationDuration, state: s.animationPlayState };
      });
    expect(await style()).toEqual({ duration: "40s", state: "running" });
    await band.focus();
    expect((await style()).state).toBe("paused");
    // Tilted -2deg across the boundary into the black section.
    expect(await band.evaluate((el) => getComputedStyle(el).rotate)).toBe("-2deg");
  });

  test("stands still under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoHydrated(page, "/");
    const name = await marquee(page)
      .locator(".ticker__track")
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe("none");
  });

  test("lower pages have no running band", async ({ page }) => {
    await gotoHydrated(page, "/goods");
    await expect(marquee(page)).toHaveCount(0);
  });
});

test.describe("TC-PG-PUB-001-322 in-app navigation runs in a view transition with the Header kept out (DESIGN 9.7, 9.8)", () => {
  async function countTransitions(page: Page): Promise<void> {
    await page.addInitScript(() => {
      const w = window as unknown as { r39xTransitions: number };
      w.r39xTransitions = 0;
      const original = document.startViewTransition?.bind(document);
      if (original === undefined) return;
      document.startViewTransition = ((arg: Parameters<typeof original>[0]) => {
        w.r39xTransitions += 1;
        return original(arg);
      }) as typeof document.startViewTransition;
    });
  }
  const transitions = (page: Page) =>
    page.evaluate(() => (window as unknown as { r39xTransitions: number }).r39xTransitions);

  test("a navigation Link starts a view transition; the Header is named apart", async ({
    page,
  }) => {
    await countTransitions(page);
    await gotoHydrated(page, "/");
    expect(await transitions(page)).toBe(0);
    await gotoViaPrimaryMenu(page, copy.layout.nav.items.goods);
    await expect(page).toHaveURL(/\/goods$/);
    await expect.poll(() => transitions(page)).toBe(1);
    expect(
      await page
        .getByRole("banner")
        .evaluate((el) => getComputedStyle(el).getPropertyValue("view-transition-name")),
    ).toBe("site-header");
    // The new page opens as a diamond from the centre in 600ms (the old one has no animation).
    // Read as text: a shorthand holding var() has no computed longhands in the CSSOM.
    const rule = (selector: string) =>
      page.evaluate((wanted) => {
        for (const sheet of Array.from(document.styleSheets)) {
          for (const r of Array.from(sheet.cssRules)) {
            if (r instanceof CSSStyleRule && r.selectorText === wanted) return r.cssText;
          }
        }
        return "";
      }, selector);
    expect(await rule("::view-transition-new(root)")).toMatch(/animation: diamond-in (\.6s|600ms)/);
    expect(await rule("::view-transition-old(root)")).toMatch(/animation: .*\bnone;/);
  });

  test("no path of a transitioned navigation is left in sessionStorage across a reload (SEC-AUTH-018)", async ({
    page,
  }) => {
    await gotoHydrated(page, "/");
    await gotoViaPrimaryMenu(page, copy.layout.nav.items.karaoke);
    await expect(page).toHaveURL(/\/karaoke$/);
    await reloadHydrated(page);
    const dump = await page.evaluate(() => JSON.stringify({ ...window.sessionStorage }));
    expect(dump).not.toMatch(/\/karaoke|remix-router-transitions/);
  });

  test("under reduced motion every view-transition animation is off", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoHydrated(page, "/");
    const reduced = await page.evaluate(() => {
      const names: Record<string, string> = {};
      for (const sheet of Array.from(document.styleSheets)) {
        for (const media of Array.from(sheet.cssRules)) {
          if (!(media instanceof CSSMediaRule) || !media.conditionText.includes("reduce")) continue;
          for (const r of Array.from(media.cssRules)) {
            if (r instanceof CSSStyleRule && r.selectorText.includes("::view-transition-")) {
              names[r.selectorText] = r.style.animationName;
            }
          }
        }
      }
      return names;
    });
    expect(reduced).toEqual({
      "::view-transition-group(*)": "none",
      "::view-transition-old(*)": "none",
      "::view-transition-new(*)": "none",
    });
  });
});

test.describe("TC-PG-PUB-001-323 candy lettering is used for at most two lines (DESIGN 5.1)", () => {
  const LONG =
    "とても長いお知らせのタイトルがここに入り、狭い画面では三行以上に折り返されるかどうかを確かめる";

  test("a title that wraps to three lines or more is a plain heading; a short one keeps the candy layers", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedLocalStorage(page, {
      ...dbJson((state) => {
        const target = state.announcements.find((a) => a.ref === ANNOUNCEMENT.latest);
        if (target === undefined) throw new Error("seed has no latest announcement");
        target.title = LONG;
      }),
    });
    await gotoHydrated(page, `/announcements/${ANNOUNCEMENT.latest}`);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText(LONG);
    const candy = main(page).locator(".candy").first();
    await expect(candy).toHaveClass(/candy--plain/);
    await expect(candy.locator(":scope > [aria-hidden='true']").first()).toBeHidden();
    expect(await h1.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(0, 0, 0)");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await gotoHydrated(page, "/goods");
    const short = main(page).locator(".candy").first();
    await expect(short).not.toHaveClass(/candy--plain/);
    await expect(short.locator(".candy__face")).toBeVisible();
  });
});

test.describe("TC-PG-PUB-001-324 every page state shows a black surface besides the footer (DESIGN 7.1)", () => {
  const inkInMain = (page: Page) => main(page).locator(".surface-ink");

  for (const [name, route] of [
    ["Not Found", "/no-such-route-r39x"],
    ["the route error view", "/dev/error-probe"],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await inkInMain(page).count()).toBeGreaterThanOrEqual(1);
    });
  }

  for (const route of ["/goods", "/announcements", "/entry", "/karaoke"]) {
    test(`${route} while loading and when unavailable`, async ({ page }) => {
      await seedLocalStorage(page, publicScenario({ latency: "long", latencyLongMs: 60000 }));
      await page.goto(route);
      await expect(main(page).getByRole("status").first()).toBeVisible();
      expect(await inkInMain(page).count()).toBeGreaterThanOrEqual(1);
      await seedLocalStorage(page, publicScenario({ publicFetch: "fail" }));
      await reloadHydrated(page);
      await expect(main(page).getByRole("alert").first()).toBeVisible();
      expect(await inkInMain(page).count()).toBeGreaterThanOrEqual(1);
    });
  }
});

test.describe("TC-PG-PUB-001-325 one primary button on the Entry Ticket and Purchase Status screens (DESIGN 8.1)", () => {
  const primaries = (page: Page) => main(page).locator(".btn-primary");

  test("Entry Ticket: only the first offering that can be added has the primary add button", async ({
    page,
  }) => {
    await gotoHydrated(page, "/entry");
    await expect(main(page).getByRole("button", { name: copy.sales.add }).first()).toBeVisible();
    await expect(primaries(page)).toHaveCount(1);
    await expect(primaries(page)).toHaveAccessibleName(new RegExp(copy.sales.add));
  });

  for (const [state, ref] of [
    ["PREPARED", ORDER.prepared],
    ["AWAITING_PAYMENT", ORDER.awaiting],
    ["CONFIRMED", ORDER.confirmedEntry],
    ["PAYMENT_FAILED", ORDER.paymentFailed],
  ] as const) {
    test(`Purchase Status ${state}: exactly one primary action`, async ({ page }) => {
      await openAs(page, `/purchase/orders/${ref}`);
      await expect(page.getByRole("region", { name: copy.purchase.outcomeHeading })).toBeVisible({
        timeout: 15_000,
      });
      await expect(primaries(page)).toHaveCount(1);
    });
  }
});
