import { expect, type Locator, type Page } from "@playwright/test";
import { copy } from "../../../apps/web/src/presentation/copy/ja.ts";

// Locators and helpers for the Global Header, its menu dialog and the Floating Ticket Button
// (tests/contracts/s10-header-float-reveal.md section 2, SPEC-050 8.5 v2.3.0, DESIGN 8.3). Test-only. Names come
// from the copy module; "メニュー" is a substring of "アカウントメニュー" and "メニューを閉じる", so every name
// lookup here is exact.
//
// Wide screens (>= HEADER_BAR_MIN_WIDTH) keep the navigation, Cart, the account area and the CTA on the bar. Narrower
// screens show only the menu button; the same destinations are in the full-screen menu dialog.

export const HEADER_BAR_MIN_WIDTH = 1280;

export const header = (page: Page): Locator => page.getByRole("banner");

/** True when the Header shows its destinations on the bar (no menu button). */
export function hasHeaderBar(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= HEADER_BAR_MIN_WIDTH;
}

export const primaryMenuButton = (page: Page): Locator =>
  header(page).getByRole("button", { name: copy.layout.menu.button, exact: true });

/**
 * The menu button as an element. While the modal dialog is open the page behind it is inert, so the button leaves
 * the accessibility tree; its state is read from the element itself.
 */
export const menuTrigger = (page: Page): Locator =>
  page.locator("header button[aria-haspopup='dialog']");

/** The open menu dialog (rendered only while open). */
export const primaryMenuPanel = (page: Page): Locator =>
  page.getByRole("dialog", { name: copy.layout.menu.button, exact: true });

export const floatingTicket = (page: Page): Locator => page.getByTestId("floating-ticket-button");

/** Opens the menu dialog the way a user does (click on the button) and returns it. Narrow layout only. */
export async function openPrimaryMenu(page: Page): Promise<Locator> {
  const button = primaryMenuButton(page);
  await expect(button).toBeVisible();
  await button.click();
  await expect(menuTrigger(page)).toHaveAttribute("aria-expanded", "true");
  const panel = primaryMenuPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * The region holding the Header destinations for this viewport: the banner on wide screens, the opened menu dialog
 * on narrow ones (opening it when needed).
 */
export async function headerDestinations(page: Page): Promise<Locator> {
  if (hasHeaderBar(page)) return header(page);
  if ((await primaryMenuPanel(page).count()) > 0) return primaryMenuPanel(page);
  return openPrimaryMenu(page);
}

/** A Header link by exact name (or pattern), wherever this viewport puts it. */
export async function headerLink(page: Page, name: string | RegExp): Promise<Locator> {
  const region = await headerDestinations(page);
  return typeof name === "string"
    ? region.getByRole("link", { name, exact: true })
    : region.getByRole("link", { name });
}

/** Follows a primary navigation link (the primary-navigation journey on both layouts). */
export async function gotoViaPrimaryMenu(page: Page, label: string): Promise<void> {
  const region = await headerDestinations(page);
  await region
    .getByRole("navigation", { name: copy.layout.nav.primaryLabel, exact: true })
    .getByRole("link", { name: label, exact: true })
    .click();
}

/** The account navigation (Mypage destinations + Logout): the opened Account menu, or the menu dialog's section. */
export async function openAccountMenu(page: Page): Promise<Locator> {
  if (hasHeaderBar(page)) {
    await header(page)
      .getByRole("button", { name: copy.layout.account.menuButton, exact: true })
      .click();
  } else {
    await headerDestinations(page);
  }
  const nav = page.getByRole("navigation", { name: copy.layout.account.menuLabel, exact: true });
  await expect(nav).toBeVisible();
  return nav;
}

/** Logs out from the Header (Account menu on wide screens, the menu dialog on narrow ones). */
export async function logoutViaHeader(page: Page): Promise<void> {
  const nav = await openAccountMenu(page);
  await nav.getByRole("button", { name: copy.layout.account.logout, exact: true }).click();
}

/**
 * Scrolls to a fraction of the scrollable range (0..1) and returns the resulting scrollY. The page must be
 * long enough to make the test meaningful: a short page fails here (a precondition), not in the assertions.
 */
export async function scrollToFraction(page: Page, fraction: number): Promise<number> {
  const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(max, "precondition: the page is scrollable by at least 400px").toBeGreaterThanOrEqual(400);
  const target = Math.floor(max * fraction);
  await page.evaluate((top) => window.scrollTo(0, top), target);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { message: "scroll position reached" })
    .toBeGreaterThanOrEqual(Math.min(target, max) - 2);
  return target;
}

export type Box = { x: number; y: number; width: number; height: number };

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Runs `check` against the Header destinations. Narrow layouts open the menu dialog for the check and close it again
 * (Escape) when the check opened it, so the test can go on using the page behind it.
 */
export async function checkHeader(
  page: Page,
  check: (region: Locator) => Promise<void>,
): Promise<void> {
  if (hasHeaderBar(page)) {
    await check(header(page));
    return;
  }
  const alreadyOpen = (await primaryMenuPanel(page).count()) > 0;
  const region = alreadyOpen ? primaryMenuPanel(page) : await openPrimaryMenu(page);
  await check(region);
  if (!alreadyOpen) {
    await page.keyboard.press("Escape");
    await expect(primaryMenuPanel(page)).toHaveCount(0);
  }
}

const cartName = (count: number | null): string =>
  count === null ? copy.layout.cart.label : copy.layout.cart.labelWithCount(count);

/** The Header Cart link with this count (null: no count) is shown. */
export const expectHeaderCartLink = (page: Page, count: number | null = null): Promise<void> =>
  checkHeader(page, (r) =>
    expect(r.getByRole("link", { name: cartName(count), exact: true })).toBeVisible(),
  );

/** No Header Cart link with this count (null: no count) is shown. */
export const expectNoHeaderCartLink = (page: Page, count: number | null = null): Promise<void> =>
  checkHeader(page, (r) =>
    expect(r.getByRole("link", { name: cartName(count), exact: true })).toHaveCount(0),
  );

/** The Header Cart link shows no count at all. */
export const expectNoHeaderCartCount = (page: Page): Promise<void> =>
  checkHeader(page, (r) => expect(r.getByRole("link", { name: /カート（\d+点）/ })).toHaveCount(0));

const linkShown = (page: Page, name: string, shown: boolean): Promise<void> =>
  checkHeader(page, (r) => {
    const link = r.getByRole("link", { name, exact: true });
    return shown ? expect(link).toBeVisible() : expect(link).toHaveCount(0);
  });

export const expectHeaderLogin = (page: Page): Promise<void> =>
  linkShown(page, copy.layout.account.login, true);
export const expectNoHeaderLogin = (page: Page): Promise<void> =>
  linkShown(page, copy.layout.account.login, false);
export const expectHeaderMypage = (page: Page): Promise<void> =>
  linkShown(page, copy.layout.account.mypage, true);
export const expectNoHeaderMypage = (page: Page): Promise<void> =>
  linkShown(page, copy.layout.account.mypage, false);

/** The member account controls are shown (wide: the Account menu button; narrow: the dialog's account section). */
export const expectAccountControls = (page: Page, shown = true): Promise<void> =>
  checkHeader(page, (r) => {
    const control = hasHeaderBar(page)
      ? r.getByRole("button", { name: copy.layout.account.menuButton, exact: true })
      : r.getByRole("navigation", { name: copy.layout.account.menuLabel, exact: true });
    return shown ? expect(control).toBeVisible() : expect(control).toHaveCount(0);
  });

/** Clicks a Header link wherever this layout puts it. */
export async function clickHeaderLink(page: Page, name: string): Promise<void> {
  await (await headerLink(page, name)).click();
}

/** Clicks the Header Cart link with this count (null: no count), opening the menu dialog on narrow layouts. */
export async function clickHeaderCartLink(page: Page, count: number | null = null): Promise<void> {
  await clickHeaderLink(page, cartName(count));
}
