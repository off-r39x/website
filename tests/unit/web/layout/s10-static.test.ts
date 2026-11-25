import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static checks for the S10 shell changes (tests/contracts/s10-header-float-reveal.md sections 0, 2, 4, 5, 6).
// These read source files only; behaviour is covered by the Playwright UI mock suite.

const webDir = fileURLToPath(new URL("../../../../apps/web/", import.meta.url));
const abs = (path: string): string => join(webDir, path);
const read = (path: string): string =>
  existsSync(abs(path)) ? readFileSync(abs(path), "utf8") : "";

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("TC-PG-PUB-001-243 S10 structure: Header menu, Floating Ticket Button, badge, viewport, reveal CSS (SPEC-050 8.5, 25)", () => {
  it("replaces the Mobile drawer and the always-visible Header navigation with the Header menu", () => {
    expect(existsSync(abs("src/presentation/layout/mobile-nav-drawer.tsx"))).toBe(false);
    const header = read("src/presentation/layout/global-header.tsx");
    expect(header).toMatch(/HeaderMenu/);
    expect(header).not.toMatch(/MobileNavDrawer|mobile-nav-drawer/);
    expect(header).not.toMatch(/hidden md:block/);
  });

  it("builds the narrow-screen menu as a full-screen Dialog with focus moved in and a close button, not an ARIA menu (SPEC-050 8.5 v2.3.0)", () => {
    const menu = read("src/presentation/layout/header-menu.tsx");
    expect(menu).toMatch(/^\s*["']use client["']/);
    // Base UI Dialog: aria-expanded on the trigger, focus trap, Escape and focus return.
    expect(menu).toMatch(/ui\/dialog/);
    expect(menu).toMatch(/side="full"/);
    expect(menu).toMatch(/initialFocus=\{closeRef\}/);
    expect(menu).toMatch(/finalFocus=/);
    expect(menu).toMatch(/copy\.layout\.menu\.button/);
    expect(menu).toMatch(/copy\.layout\.menu\.close/);
    expect(menu).not.toMatch(/role=["'](menu|menuitem)["']/);
    // The CTA is the last destination in the menu (DESIGN 8.3).
    expect(menu.lastIndexOf("CTA_HREF")).toBeGreaterThan(
      menu.lastIndexOf("ACCOUNT_MENU_ITEMS.map"),
    );
  });

  it("renders the Floating Ticket Button as a fixed Link to the Entry Ticket page with its own label", () => {
    const button = read("src/presentation/layout/floating-ticket-button.tsx");
    expect(button).toMatch(/fixed/);
    expect(button).toMatch(/safe-area-inset-bottom/);
    expect(button).toMatch(/data-testid=["']floating-ticket-button["']/);
    expect(button).toMatch(/copy\.layout\.floatingTicket\.label/);
    expect(button).not.toMatch(/copy\.layout\.cta\.buyTickets/);
    expect(button).toMatch(/isFloatingTicketVisible/);
    expect(button).toMatch(/CTA_HREF|["']\/entry["']/);
  });

  it("guards the site name scroll with isPlainPrimaryClick so modified and non-primary clicks keep the default link behaviour", () => {
    const link = read("src/presentation/layout/site-name-link.tsx");
    expect(link).toMatch(/isPlainPrimaryClick/);
  });

  it("wires the Floating Ticket Button into the root layout and enables viewport-fit=cover in index.html", () => {
    const layout = read("src/routes/root-layout.tsx");
    expect(layout).toMatch(/FloatingTicket/);
    expect(layout).not.toMatch(/export\s+const\s+viewport\b|viewportFit/);
    const html = read("index.html");
    expect(html).toMatch(/<meta[^>]+name=["']viewport["'][^>]*>/);
    expect(html).toMatch(/viewport-fit=cover/);
    expect(html).toMatch(/width=device-width/);
    expect(html).toMatch(/initial-scale=1/);
  });

  it("moves the mock badge to the bottom left", () => {
    const badge = read("src/mock/dev-ui/mock-mode-badge.tsx");
    expect(badge).toMatch(/\bleft-/);
    expect(badge).not.toMatch(/\bright-/);
    expect(badge).toMatch(/\bfixed\b/);
  });

  it("marks section headings as static in the presentation layer and never hides them in CSS (docs/DESIGN.md 9.1, 13)", () => {
    const css = read("src/styles/globals.css");
    // No fade-in: no CSS rule may hide or move a heading by its reveal state.
    expect(css).not.toMatch(/data-reveal/);
    expect(css).toMatch(/prefers-reduced-motion/);
    const heading = read("src/presentation/components/section-heading.tsx");
    expect(heading).toMatch(/data-reveal="static"/);
    expect(heading).not.toMatch(/pending|IntersectionObserver/);
    const presentation = walk(abs("src/presentation")).filter((f) => /\.tsx?$/.test(f));
    const marked = presentation.filter((f) => /data-reveal/.test(readFileSync(f, "utf8")));
    expect(marked.length).toBeGreaterThan(0);
  });

  it("keeps the reveal attribute out of h1 and Hero code", () => {
    for (const file of walk(abs("src/features")).filter((f) => /\.tsx$/.test(f))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/<h1[^>]*data-reveal/);
    }
  });
});
