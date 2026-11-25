import { expect, type Page, test } from "@playwright/test";
import { copy } from "../../apps/web/src/presentation/copy/ja.ts";
import {
  hasHeaderBar,
  headerDestinations,
  headerLink,
  logoutViaHeader,
  openAccountMenu,
  openPrimaryMenu,
  primaryMenuButton,
  primaryMenuPanel,
} from "../harness/browser/header-menu.ts";
import { gotoHydrated, reloadHydrated } from "../harness/browser/hydration.ts";
import {
  authenticatedSession,
  cartJson,
  KEYS,
  SITE_NAME,
  scenarioJson,
  seedLocalStorage,
  sessionJson,
} from "../harness/browser/shell.ts";

// UI mock suite (TST-E2E-004: auxiliary, not G8). Contract: tests/contracts/s3-layout.md sections 4.2-4.7;
// tests/contracts/s10-header-float-reveal.md section 2 (wide bar / narrow menu dialog, SPEC-050 v2.3.0).
// SPEC-050 8.1-8.3, 8.5, 24.1, 25, 31 item 29; DESIGN 8.3. Copy comes from presentation/copy/ja.ts (read inside
// tests only). Both projects run every test: desktop-chromium (1280, the wide bar) and mobile-chromium (412, the
// menu dialog).

const header = (page: Page) => page.getByRole("banner");
const NAV = [
  [copy.layout.nav.items.event, "/"],
  [copy.layout.nav.items.entry, "/entry"],
  [copy.layout.nav.items.karaoke, "/karaoke"],
  [copy.layout.nav.items.goods, "/goods"],
] as const;

test.describe("TC-PG-PUB-001-301 Global Header content for a guest (SPEC-050 8.2, 8.5)", () => {
  test("reaches the four navigation links, CTA, Cart, Login and registration, and no member-only controls", async ({
    page,
  }) => {
    await gotoHydrated(page, "/goods");
    await expect(header(page).getByRole("link", { name: SITE_NAME, exact: true })).toHaveAttribute(
      "href",
      "/",
    );
    const region = await headerDestinations(page);
    const nav = region.getByRole("navigation", {
      name: copy.layout.nav.primaryLabel,
      exact: true,
    });
    for (const [name, href] of NAV) {
      await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
    }
    await expect(nav.getByRole("menuitem")).toHaveCount(0);
    for (const [name, href] of [
      [copy.layout.cta.buyTickets, "/entry"],
      [copy.layout.cart.label, "/cart"],
      [copy.layout.account.login, "/account/login"],
      [copy.layout.account.register, "/account/register"],
    ] as const) {
      const link = region.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", href);
    }
    await expect(
      page.getByRole("link", { name: copy.layout.account.mypage, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: copy.layout.account.logout, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: copy.layout.account.menuButton, exact: true }),
    ).toHaveCount(0);
  });

  test("wide: everything sits on the 72px bar with no menu button; narrow: only the 60px bar with the logo and the menu button", async ({
    page,
  }) => {
    await gotoHydrated(page, "/goods");
    const box = await header(page).boundingBox();
    const logo = await header(page)
      .getByRole("link", { name: SITE_NAME, exact: true })
      .boundingBox();
    expect(logo, "the logo is laid out").not.toBeNull();
    // A 120px sticker 4px from the top, hanging below the bar (DESIGN 8.3).
    expect(Math.round(logo?.y ?? 0)).toBe(4);
    expect(Math.round(logo?.height ?? 0)).toBeGreaterThanOrEqual(120);
    if (hasHeaderBar(page)) {
      expect(Math.round(box?.height ?? 0)).toBe(72);
      await expect(primaryMenuButton(page)).toBeHidden();
      for (const [name] of NAV) {
        await expect(header(page).getByRole("link", { name, exact: true })).toBeInViewport();
      }
      await expect(
        header(page).getByRole("link", { name: copy.layout.cta.buyTickets, exact: true }),
      ).toBeInViewport();
    } else {
      expect(Math.round(box?.height ?? 0)).toBe(60);
      await expect(primaryMenuButton(page)).toBeVisible();
      const button = await primaryMenuButton(page).boundingBox();
      expect(Math.round(button?.width ?? 0)).toBe(48);
      expect(Math.round(button?.height ?? 0)).toBe(48);
      // Navigation, Cart, account and CTA are hidden from the bar (not only visually).
      await expect(header(page).getByRole("link")).toHaveCount(1);
      await expect(header(page).getByRole("navigation")).toHaveCount(0);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("TC-PG-PUB-001-302 Global Header stays fixed while scrolling (SPEC-050 8.5)", () => {
  test("remains at the top of the viewport and keeps the CTA and Cart reachable after scrolling", async ({
    page,
  }) => {
    await gotoHydrated(page, "/");
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "4000px";
      document.querySelector("main")?.appendChild(spacer);
    });
    await page.evaluate(() => window.scrollTo(0, 2500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    const box = await header(page).boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box?.y ?? 999)).toBeLessThanOrEqual(1);
    await expect(header(page)).toBeInViewport();
    // The scrolled state draws the 3px ink line under the bar (DESIGN 8.3).
    await expect(page.locator("html")).toHaveAttribute("data-scrolled", "true");
    await expect(await headerLink(page, copy.layout.cta.buyTickets)).toBeInViewport();
    await expect(await headerLink(page, copy.layout.cart.label)).toBeInViewport();
  });
});

test.describe("TC-PG-PUB-001-303 main CTA is the same for guests and authenticated users (SPEC-050 8.5)", () => {
  test("authenticated user reaches the same CTA and Mypage instead of Login", async ({ page }) => {
    await seedLocalStorage(page, { [KEYS.session]: authenticatedSession() });
    await gotoHydrated(page, "/");
    const region = await headerDestinations(page);
    const cta = region.getByRole("link", { name: copy.layout.cta.buyTickets, exact: true });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/entry");
    await expect(cta).toBeInViewport();
    const mypage = region.getByRole("link", { name: copy.layout.account.mypage, exact: true });
    await expect(mypage).toBeVisible();
    await expect(mypage).toHaveAttribute("href", "/mypage");
    await expect(region.getByRole("link", { name: copy.layout.account.login })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: copy.layout.account.register, exact: true }),
    ).toHaveCount(0);
  });
});

test.describe("TC-PG-CRT-001-301 Cart link shows the total quantity in text and in the accessible name (SPEC-050 8.5)", () => {
  test("shows 3 for 3 items across lines, in text and in the name", async ({ page }) => {
    await seedLocalStorage(page, {
      [KEYS.cart]: cartJson([
        { kind: "ENTRY_TICKET", quantity: 1 },
        { kind: "GOODS", quantity: 2 },
      ]),
    });
    await gotoHydrated(page, "/");
    const link = await headerLink(page, copy.layout.cart.labelWithCount(3));
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/cart");
    await expect(link).toContainText("3");
    await expect(link).toBeInViewport();
  });

  for (const [label, entries] of [
    ["an empty cart (0 items)", { [KEYS.cart]: cartJson([]) }],
    ["no cart key", {}],
    ["a corrupted cart", { [KEYS.cart]: "not-json" }],
    [
      "a cart carrying a price (strict schema violation)",
      {
        [KEYS.cart]: JSON.stringify({
          version: 1,
          lines: [
            {
              kind: "ENTRY_TICKET",
              offeringRef: "e0000000-0000-4000-8000-000000000001",
              quantity: 5,
              unitPrice: 3000,
            },
          ],
        }),
      },
    ],
  ] as const) {
    test(`shows no number for ${label}`, async ({ page }) => {
      await seedLocalStorage(page, entries);
      await gotoHydrated(page, "/");
      const link = await headerLink(page, copy.layout.cart.label);
      await expect(link).toBeVisible();
      await expect(link).not.toContainText(/\d/);
      await expect(page.getByRole("link", { name: /カート（\d+点）/ })).toHaveCount(0);
    });
  }

  test("follows a change made in another tab (storage event)", async ({ page, context }) => {
    await gotoHydrated(page, "/");
    await expect(await headerLink(page, copy.layout.cart.label)).toBeVisible();
    const other = await context.newPage();
    await other.goto("/");
    await other.evaluate(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [KEYS.cart, cartJson([{ kind: "GOODS", quantity: 5 }])],
    );
    await expect(await headerLink(page, copy.layout.cart.labelWithCount(5))).toBeVisible();
    await other.close();
  });
});

test.describe("TC-PG-PUB-001-304 Account area follows the session (SPEC-050 8.2, 8.3, 15.6)", () => {
  test("authenticated: the account navigation holds profile, orders, tickets, karaoke, goods and Logout", async ({
    page,
  }) => {
    await seedLocalStorage(page, { [KEYS.session]: authenticatedSession() });
    await gotoHydrated(page, "/");
    const menu = page.getByRole("navigation", { name: copy.layout.account.menuLabel, exact: true });
    await expect(menu).toHaveCount(0);
    const account = copy.layout.account;
    const accountButton = header(page).getByRole("button", {
      name: account.menuButton,
      exact: true,
    });
    if (hasHeaderBar(page)) await expect(accountButton).toHaveAttribute("aria-expanded", "false");
    const opened = await openAccountMenu(page);
    // Wide: a disclosure on the bar. Narrow: a section of the menu dialog, not a second disclosure.
    if (hasHeaderBar(page)) await expect(accountButton).toHaveAttribute("aria-expanded", "true");
    else await expect(accountButton).toHaveCount(0);
    for (const [name, href] of [
      [account.profile, "/mypage/profile"],
      [account.orders, "/mypage/orders"],
      [account.entryTickets, "/mypage/entry-tickets"],
      [account.karaoke, "/mypage/karaoke"],
      [account.goods, "/mypage/goods"],
    ] as const) {
      await expect(opened.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
    }
    await expect(opened.getByRole("button", { name: account.logout, exact: true })).toBeVisible();
    await expect(opened.getByRole("link", { name: account.logout, exact: true })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    const back = hasHeaderBar(page)
      ? header(page).getByRole("button", { name: account.menuButton, exact: true })
      : primaryMenuButton(page);
    await expect(back).toHaveAttribute("aria-expanded", "false");
    await expect(back).toBeFocused();
  });

  test("Logout from the Header ends the session, goes Home and shows Login again", async ({
    page,
  }) => {
    await seedLocalStorage(page, { [KEYS.session]: authenticatedSession() });
    await gotoHydrated(page, "/");
    await logoutViaHeader(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(primaryMenuPanel(page)).toHaveCount(0);
    await expect(await headerLink(page, copy.layout.account.login)).toBeVisible();
    await expect(
      page.getByRole("link", { name: copy.layout.account.mypage, exact: true }),
    ).toHaveCount(0);
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), KEYS.session);
    const session =
      stored === null ? { kind: "guest" } : (JSON.parse(stored) as { session: unknown }).session;
    expect(session).toEqual({ kind: "guest" });
    await reloadHydrated(page);
    await expect(await headerLink(page, copy.layout.account.login)).toBeVisible();
  });

  test("session provider unavailable falls back to the guest links (never to member links)", async ({
    page,
  }) => {
    await seedLocalStorage(page, {
      [KEYS.session]: authenticatedSession(),
      [KEYS.scenario]: scenarioJson({
        auth: {
          session: "unavailable",
          login: "ok",
          signup: "confirmation_required",
          verify: "ok",
          reset: "ok",
          resetContext: "valid",
          logout: "ok",
        },
      }),
    });
    await gotoHydrated(page, "/");
    await expect(await headerLink(page, copy.layout.account.login)).toBeVisible();
    await expect(
      page.getByRole("link", { name: copy.layout.account.mypage, exact: true }),
    ).toHaveCount(0);
    await expect(await headerLink(page, copy.layout.cta.buyTickets)).toBeVisible();
  });

  test("a guest session object is shown as guest", async ({ page }) => {
    await seedLocalStorage(page, { [KEYS.session]: sessionJson() });
    await gotoHydrated(page, "/");
    await expect(await headerLink(page, copy.layout.account.login)).toBeVisible();
  });
});

test.describe("TC-PG-PUB-001-305 keyboard order follows the DOM and starts with the skip link (SPEC-050 25, DESIGN 12)", () => {
  async function tabNames(page: Page, count: number): Promise<string[]> {
    const names: string[] = [];
    for (let i = 0; i < count; i += 1) {
      await page.keyboard.press("Tab");
      names.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          if (el === null) return "";
          const label =
            el.getAttribute("aria-label") ??
            el.querySelector("img")?.getAttribute("alt") ??
            el.textContent ??
            "";
          return label.replace(/\s+/g, " ").trim();
        }),
      );
    }
    return names;
  }

  test("tabs through skip link, site name, then the bar (wide) or the menu button (narrow)", async ({
    page,
  }) => {
    await gotoHydrated(page, "/goods");
    const l = copy.layout;
    const expected = hasHeaderBar(page)
      ? [
          l.skipLink,
          SITE_NAME,
          l.nav.items.event,
          l.nav.items.entry,
          l.nav.items.karaoke,
          l.nav.items.goods,
          l.cart.label,
          l.account.login,
          l.account.register,
          l.cta.buyTickets,
        ]
      : [l.skipLink, SITE_NAME, l.menu.button];
    expect(await tabNames(page, expected.length)).toEqual(expected);
  });

  test("on Home the hidden logo takes no focus while the hero shows the big logo", async ({
    page,
  }) => {
    await gotoHydrated(page, "/");
    await expect(page.locator("html")).toHaveAttribute("data-hero-in-view", "true");
    const site = header(page).locator('a[href="/"]').first();
    await expect(site).toBeHidden();
    // The slot is kept: the link is still laid out at the left, only invisible.
    expect(await site.evaluate((el) => getComputedStyle(el).visibility)).toBe("hidden");
    const l = copy.layout;
    const expected = hasHeaderBar(page)
      ? [l.skipLink, l.nav.items.event]
      : [l.skipLink, l.menu.button];
    expect(await tabNames(page, expected.length)).toEqual(expected);
  });

  test("the skip link targets the single main landmark and moves focus to it", async ({ page }) => {
    await gotoHydrated(page, "/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: copy.layout.skipLink, exact: true });
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute("href", "#main-content");
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main-content$/);
    await expect(page.locator("main#main-content")).toHaveCount(1);
    await expect(page.locator("main#main-content")).toBeFocused();
  });
});

test.describe("TC-PG-PUB-001-306 the Header keeps every destination reachable without horizontal scroll (SPEC-050 8.5, 24.1)", () => {
  for (const width of [375, 768, 1024, 1280, 1440]) {
    test(`at ${width}px the bar fits and the destinations are reachable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoHydrated(page, "/goods");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const region = await headerDestinations(page);
      for (const name of [
        copy.layout.cta.buyTickets,
        copy.layout.cart.label,
        copy.layout.account.login,
        copy.layout.account.register,
        ...NAV.map(([label]) => label),
      ]) {
        await expect(region.getByRole("link", { name, exact: true })).toBeInViewport();
      }
      if (hasHeaderBar(page)) {
        // One row: every control is vertically inside the 72px bar and right of the 120px logo.
        const logo = await header(page).locator('a[href="/"]').first().boundingBox();
        const boxes = await header(page)
          .locator(".site-header__bar a, .site-header__bar button")
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
        for (const b of boxes as { x: number; y: number; bottom: number }[]) {
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.bottom).toBeLessThanOrEqual(72);
          expect(b.x).toBeGreaterThan((logo?.x ?? 0) + (logo?.width ?? 0));
        }
      }
    });
  }

  test("the menu dialog puts the CTA last and is the only place the narrow layout shows it", async ({
    page,
  }) => {
    // The menu exists below the wide bar's breakpoint; check it at a phone width on both projects.
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoHydrated(page, "/");
    const panel = await openPrimaryMenu(page);
    const last = panel.getByRole("link").last();
    await expect(last).toHaveAccessibleName(copy.layout.cta.buyTickets);
    await expect(last).toHaveAttribute("href", "/entry");
  });
});
