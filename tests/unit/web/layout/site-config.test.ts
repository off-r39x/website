import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assets } from "../../../../apps/web/src/config/assets.ts";
import {
  ACCOUNT_MENU_ITEMS,
  CART_HREF,
  CTA_HREF,
  EVENT_NAME,
  GUEST_ACCOUNT_LINKS,
  HOME_HREF,
  MYPAGE_HREF,
  PRIMARY_NAV,
  SITE_NAME,
} from "../../../../apps/web/src/config/site.ts";

// Contract: tests/contracts/s3-layout.md section 2.1 / 2.2 (SPEC-050 8.1, 8.2, 8.3, 8.5, 24.3, 27).

describe("TC-PG-PUB-001-201 site config: name, primary navigation and account links", () => {
  it("fixes the site / event name", () => {
    expect(SITE_NAME).toBe("off r39'x in 大阪らへん2027");
    expect(EVENT_NAME).toBe(SITE_NAME);
  });

  it("exposes the fixed hrefs", () => {
    expect(HOME_HREF).toBe("/");
    expect(CTA_HREF).toBe("/entry");
    expect(CART_HREF).toBe("/cart");
    expect(MYPAGE_HREF).toBe("/mypage");
  });

  it("lists Event, Entry, Karaoke, Goods and Cart in this order; only Cart is not collapsible", () => {
    expect(PRIMARY_NAV.map((item) => [item.key, item.href, item.collapsible])).toEqual([
      ["event", "/", true],
      ["entry", "/entry", true],
      ["karaoke", "/karaoke", true],
      ["goods", "/goods", true],
      ["cart", "/cart", false],
    ]);
  });

  it("lists the guest account links (Login and Account registration)", () => {
    expect(GUEST_ACCOUNT_LINKS.map((link) => [link.key, link.href])).toEqual([
      ["login", "/account/login"],
      ["register", "/account/register"],
    ]);
  });

  it("lists the authenticated account menu destinations (SPEC-050 8.3)", () => {
    expect(ACCOUNT_MENU_ITEMS.map((item) => [item.key, item.href])).toEqual([
      ["profile", "/mypage/profile"],
      ["orders", "/mypage/orders"],
      ["entryTickets", "/mypage/entry-tickets"],
      ["karaoke", "/mypage/karaoke"],
      ["goods", "/mypage/goods"],
    ]);
  });
});

describe("TC-PG-PUB-001-202 site config never links the Administrator / Staff area or the dev area (SPEC-050 27, DEV-WEB-012)", () => {
  const hrefs = [
    HOME_HREF,
    CTA_HREF,
    CART_HREF,
    MYPAGE_HREF,
    ...PRIMARY_NAV.map((item) => item.href),
    ...GUEST_ACCOUNT_LINKS.map((link) => link.href),
    ...ACCOUNT_MENU_ITEMS.map((item) => item.href),
  ];

  it("has only same-site relative paths", () => {
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      expect(href.startsWith("/"), href).toBe(true);
      expect(href.startsWith("//"), href).toBe(false);
      expect(href, href).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }
  });

  it("has no /admin, /staff or /dev path", () => {
    for (const href of hrefs) {
      expect(href.toLowerCase(), href).not.toMatch(/(^|\/)(admin|staff|dev)(\/|$|\?|#)/);
    }
  });

  it("has unique navigation keys", () => {
    const keys = PRIMARY_NAV.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("TC-PG-PUB-001-203 the logo slot is the supplied logo, unmodified; the key visual stays empty (SPEC-050 24.3, docs/DESIGN.md 10)", () => {
  it("points the logo slot at the bundled logo file with the 1920 x 1920 size and the site name as alt", () => {
    expect(assets.logo).not.toBeNull();
    expect(assets.logo?.src).toMatch(/\/assets\/logo\.png$/);
    expect(assets.logo?.src).not.toMatch(/^https?:/);
    expect(assets.logo?.alt).toBe(SITE_NAME);
    expect(assets.logo?.width).toBe(1920);
    expect(assets.logo?.height).toBe(1920);
    expect(assets.keyVisual).toBeNull();
  });

  it("serves a byte-identical copy of the supplied logo (no resize, recompression or edit)", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const digest = (path: string): string =>
      createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    expect(digest("apps/web/src/assets/logo.png")).toBe(digest("assets/images/logo.png"));
  });
});
