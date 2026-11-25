import { expect, type Page, test } from "@playwright/test";
import { copy } from "../../apps/web/src/presentation/copy/ja.ts";
import {
  expectHeaderLogin,
  hasHeaderBar,
  logoutViaHeader,
  openPrimaryMenu,
  primaryMenuPanel,
} from "../harness/browser/header-menu.ts";
import {
  authenticatedSession,
  KEYS,
  scenarioJson,
  seedLocalStorage,
  watchRuntimeErrors,
} from "../harness/browser/shell.ts";

// UI mock suite (TST-E2E-004: auxiliary, not G8). Verification-phase gap test.
// Interactions (Header menu, account menu, logout, broken sponsor image) must not raise hydration or runtime errors.

const header = (page: Page) => page.getByRole("banner");

test.describe("TC-PG-PUB-001-505 interactions run without runtime or hydration errors (SPEC-050 25, DEV-WEB-001)", () => {
  test("Header menu, account menu, logout and a broken sponsor image raise no pageerror or console.error", async ({
    page,
  }) => {
    const runtime = watchRuntimeErrors(page);
    await seedLocalStorage(page, {
      [KEYS.session]: authenticatedSession(),
      [KEYS.scenario]: scenarioJson({ sponsorLogos: "image_broken" }),
    });
    await page.goto("/");
    await expect(header(page)).toBeVisible();
    await page.waitForLoadState("networkidle");

    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 1024, height: 768 });
    await openPrimaryMenu(page);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Escape");
    await expect(primaryMenuPanel(page)).toHaveCount(0);
    await page.setViewportSize(viewport ?? { width: 1280, height: 720 });

    if (hasHeaderBar(page)) {
      const menuButton = header(page).getByRole("button", {
        name: copy.layout.account.menuButton,
        exact: true,
      });
      await menuButton.click();
      await expect(menuButton).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(menuButton).toHaveAttribute("aria-expanded", "false");
      await expect(menuButton).toBeFocused();
    }

    await logoutViaHeader(page);
    await expectHeaderLogin(page);
    await page.waitForLoadState("networkidle");

    expect(runtime.errors).toEqual([]);
  });
});
