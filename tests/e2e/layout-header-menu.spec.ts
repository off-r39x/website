import { expect, test } from "@playwright/test";
import { copy } from "../../apps/web/src/presentation/copy/ja.ts";
import {
  hasHeaderBar,
  header,
  menuTrigger,
  openPrimaryMenu,
  primaryMenuButton,
  primaryMenuPanel,
  scrollToFraction,
} from "../harness/browser/header-menu.ts";
import { gotoHydrated } from "../harness/browser/hydration.ts";
import { SITE_NAME } from "../harness/browser/shell.ts";

// UI mock suite (TST-E2E-004: auxiliary, not G8). Contract: tests/contracts/s10-header-float-reveal.md sections 2, 3.
// SPEC-050 8.5 v2.3.0 (menu dialog, site name), 25 (keyboard, Link vs Button, Dialog focus, Escape, focus return);
// DESIGN 8.3, 12. The menu exists below the wide bar's breakpoint: the desktop project checks it at 1024px.

const siteName = (page: import("@playwright/test").Page) =>
  header(page).getByRole("link", { name: SITE_NAME, exact: true });

async function narrow(page: import("@playwright/test").Page): Promise<void> {
  if (hasHeaderBar(page)) await page.setViewportSize({ width: 1024, height: 768 });
}

test.describe("TC-PG-PUB-001-307 the menu button opens a full-screen dialog of Links with the CTA last (SPEC-050 8.5, 25)", () => {
  test.beforeEach(async ({ page }) => narrow(page));

  test("toggles aria-expanded, renders the dialog only while open and moves focus to the close button", async ({
    page,
  }) => {
    await gotoHydrated(page, "/");
    const button = primaryMenuButton(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(primaryMenuPanel(page)).toHaveCount(0);

    await button.click();
    await expect(menuTrigger(page)).toHaveAttribute("aria-expanded", "true");
    const panel = primaryMenuPanel(page);
    await expect(panel).toBeVisible();
    const close = panel.getByRole("button", { name: copy.layout.menu.close, exact: true });
    await expect(close).toBeFocused();
    // Full screen and black (DESIGN 8.3).
    const viewport = page.viewportSize();
    const box = await panel.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(viewport?.width);
    expect(Math.round(box?.height ?? 0)).toBe(viewport?.height);
    expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(0, 0, 0)");

    await close.click();
    await expect(primaryMenuPanel(page)).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button).toBeFocused();
  });

  test("is a real button operable by keyboard (Enter and Space)", async ({ page }) => {
    await gotoHydrated(page, "/");
    const button = primaryMenuButton(page);
    expect(await button.evaluate((el) => el.tagName)).toBe("BUTTON");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(primaryMenuPanel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(primaryMenuPanel(page)).toHaveCount(0);
    await expect(button).toBeFocused();
    await page.keyboard.press("Space");
    await expect(primaryMenuPanel(page)).toBeVisible();
  });

  test("lists the 4 navigation Links, Cart, the account links and the CTA last, marking the current page", async ({
    page,
  }) => {
    await gotoHydrated(page, "/goods");
    const panel = await openPrimaryMenu(page);
    const names = await panel
      .getByRole("link")
      .evaluateAll((els) => els.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()));
    expect(names).toEqual([
      copy.layout.nav.items.event,
      copy.layout.nav.items.entry,
      copy.layout.nav.items.karaoke,
      copy.layout.nav.items.goods,
      copy.layout.cart.label,
      copy.layout.account.login,
      copy.layout.account.register,
      copy.layout.cta.buyTickets,
    ]);
    const nav = panel.getByRole("navigation", { name: copy.layout.nav.primaryLabel, exact: true });
    await expect(
      nav.getByRole("link", { name: copy.layout.nav.items.goods, exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      nav.getByRole("link", { name: copy.layout.nav.items.event, exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
    await expect(panel.getByRole("menuitem")).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("keeps focus inside the dialog with Tab and Shift+Tab", async ({ page }) => {
    await gotoHydrated(page, "/");
    const panel = await openPrimaryMenu(page);
    const inside = () =>
      page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Tab");
      expect(await inside(), `Tab ${i + 1} stays inside`).toBe(true);
    }
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside(), `Shift+Tab ${i + 1} stays inside`).toBe(true);
    }
    await expect(panel).toBeVisible();
  });

  test("stays inside the viewport horizontally and shows no horizontal scroll while open", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoHydrated(page, "/");
    const panel = await openPrimaryMenu(page);
    for (const name of [
      copy.layout.nav.items.event,
      copy.layout.nav.items.entry,
      copy.layout.nav.items.karaoke,
      copy.layout.nav.items.goods,
    ]) {
      await expect(panel.getByRole("link", { name, exact: true })).toBeInViewport();
    }
    const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("TC-PG-PUB-001-308 the menu closes on Escape, its close button, selection and route change (SPEC-050 8.5, 25)", () => {
  test.beforeEach(async ({ page }) => narrow(page));

  test("Escape closes it from inside and returns focus to the menu button", async ({ page }) => {
    await gotoHydrated(page, "/");
    const panel = await openPrimaryMenu(page);
    await panel.getByRole("link", { name: copy.layout.nav.items.karaoke, exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(primaryMenuPanel(page)).toHaveCount(0);
    await expect(primaryMenuButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(primaryMenuButton(page)).toBeFocused();
  });

  test("selecting a link navigates, closes it and leaves focus to the destination", async ({
    page,
  }) => {
    await gotoHydrated(page, "/");
    const panel = await openPrimaryMenu(page);
    await panel.getByRole("link", { name: copy.layout.nav.items.goods, exact: true }).click();
    await expect(page).toHaveURL(/\/goods$/);
    await expect(primaryMenuPanel(page)).toHaveCount(0);
    await expect(primaryMenuButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(primaryMenuButton(page)).not.toBeFocused();
  });

  test("selecting the link of the current page also closes it", async ({ page }) => {
    await gotoHydrated(page, "/");
    const panel = await openPrimaryMenu(page);
    await panel.getByRole("link", { name: copy.layout.nav.items.event, exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(primaryMenuPanel(page)).toHaveCount(0);
    await expect(primaryMenuButton(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("Back after a navigation from the menu does not reopen it", async ({ page }) => {
    await gotoHydrated(page, "/");
    const panel = await openPrimaryMenu(page);
    await panel.getByRole("link", { name: copy.layout.nav.items.karaoke, exact: true }).click();
    await expect(page).toHaveURL(/\/karaoke$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(primaryMenuPanel(page)).toHaveCount(0);
    await expect(primaryMenuButton(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("the menu can be opened again after a navigation", async ({ page }) => {
    await gotoHydrated(page, "/");
    const panel = await openPrimaryMenu(page);
    await panel.getByRole("link", { name: copy.layout.nav.items.entry, exact: true }).click();
    await expect(page).toHaveURL(/\/entry$/);
    const again = await openPrimaryMenu(page);
    await expect(
      again.getByRole("link", { name: copy.layout.nav.items.entry, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });
});

test.describe("TC-PG-PUB-001-309 the site name goes to the top page, and scrolls to the top when already there (SPEC-050 8.5)", () => {
  test("from another page it navigates to / (client-side)", async ({ page }) => {
    await gotoHydrated(page, "/goods");
    await expect(siteName(page)).toHaveAttribute("href", "/");
    await page.evaluate(() => {
      (window as unknown as { r39xMarker: number }).r39xMarker = 1;
    });
    await siteName(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const marker = await page.evaluate(
      () => (window as unknown as { r39xMarker?: number }).r39xMarker,
    );
    expect(marker, "no full page reload").toBe(1);
  });

  test("on / it scrolls to the top without reloading, by click", async ({ page }) => {
    await gotoHydrated(page, "/");
    await page.evaluate(() => {
      (window as unknown as { r39xMarker: number }).r39xMarker = 1;
    });
    await scrollToFraction(page, 0.6);
    await siteName(page).click();
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBe(0);
    await expect(page).toHaveURL(/\/$/);
    const marker = await page.evaluate(
      () => (window as unknown as { r39xMarker?: number }).r39xMarker,
    );
    expect(marker, "no full page reload").toBe(1);
    await expect(header(page)).toBeInViewport();
  });

  test("on / it scrolls to the top by keyboard (Enter on the focused site name)", async ({
    page,
  }) => {
    await gotoHydrated(page, "/");
    await scrollToFraction(page, 0.6);
    await siteName(page).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBe(0);
    await expect(page).toHaveURL(/\/$/);
  });

  test("with reduced motion the jump to the top is immediate (no smooth scrolling)", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoHydrated(page, "/");
    await scrollToFraction(page, 0.6);
    await siteName(page).click();
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 1000 }).toBe(0);
  });

  test("on / a click with Control, Meta, Shift or Alt keeps the default link behaviour (not prevented by the app, no scroll)", async ({
    page,
  }) => {
    type Rec = {
      prevented: boolean;
      ctrl: boolean;
      meta: boolean;
      shift: boolean;
      alt: boolean;
      button: number;
    };
    type W = { r39xMarker?: number; r39xClicks?: Rec[] };
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoHydrated(page, "/");
    await page.evaluate(() => {
      const w = window as unknown as W;
      w.r39xMarker = 1;
      w.r39xClicks = [];
      // Bubble phase on window: runs after the app's and Next Link's handlers.
      // Test-only: it cancels the browser default (new tab / window / download) so no side effect happens.
      window.addEventListener("click", (e) => {
        const target = e.target as Element | null;
        if (!target?.closest('header a[href="/"]')) return;
        w.r39xClicks?.push({
          prevented: e.defaultPrevented,
          ctrl: e.ctrlKey,
          meta: e.metaKey,
          shift: e.shiftKey,
          alt: e.altKey,
          button: e.button,
        });
        e.preventDefault();
      });
    });
    const count = () => page.evaluate(() => (window as unknown as W).r39xClicks?.length ?? 0);
    const last = () =>
      page.evaluate(() => {
        const list = (window as unknown as W).r39xClicks ?? [];
        return list[list.length - 1] as Rec;
      });
    const scrollY = () => page.evaluate(() => window.scrollY);
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );

    const modifiers = [
      { key: "Control", flag: "ctrl" },
      { key: "Meta", flag: "meta" },
      { key: "Shift", flag: "shift" },
      { key: "Alt", flag: "alt" },
    ] as const;
    for (const { key, flag } of modifiers) {
      await scrollToFraction(page, 0.6);
      const y0 = await scrollY();
      const before = await count();
      // Raw mouse input at the link's box: Locator.click scrolls the element into view itself, which would
      // move scrollY for a reason unrelated to the app and mask the assertion below.
      const box = await siteName(page).boundingBox();
      expect(box, "the site name is laid out").not.toBeNull();
      await page.keyboard.down(key);
      await page.mouse.click((box?.x ?? 0) + 5, (box?.y ?? 0) + 5);
      await page.keyboard.up(key);
      await expect.poll(count, { timeout: 5000 }).toBe(before + 1);
      const record = await last();
      expect(record[flag], `${key} flag is set on the click`).toBe(true);
      expect(record.prevented, `${key}+click is not default-prevented by the app`).toBe(false);
      await settle();
      const drift = Math.abs((await scrollY()) - y0);
      expect(drift, `${key}+click does not scroll`).toBeLessThanOrEqual(2);
    }

    // Control case: a plain click is taken over by the app (proves the observer runs after the app's handler).
    await scrollToFraction(page, 0.6);
    const before = await count();
    await siteName(page).click();
    await expect.poll(count, { timeout: 5000 }).toBe(before + 1);
    expect((await last()).prevented, "a plain click is default-prevented by the app").toBe(true);
    await expect.poll(scrollY, { timeout: 5000 }).toBe(0);

    await expect(page).toHaveURL(/\/$/);
    const marker = await page.evaluate(() => (window as unknown as W).r39xMarker);
    expect(marker, "no full page reload").toBe(1);
  });
});
