// PR #85 second review, finding 1 (High). TC-API-006-105 (G1): SPONSOR_IMAGE_ALLOWED_ORIGINS as the API reads it
// (SEC-WEB-026, SPEC-180 section 13.2: the same setting builds the API's Logo URL check and the Pages img-src, so
// the two must normalize identically). `parseSponsorImageOrigins` (@off-r39x/config) is a pure function: it never
// throws and never echoes the value; `undefined` means "invalid" and `[]` means "unset". parseServerConfig("api")
// carries the result as `sponsorImageOrigins` and does not throw on a bad value (a configuration defect fails the
// Logo only, SPEC-180 section 13.2). Synthetic hosts only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseServerConfig, parseSponsorImageOrigins } from "../../packages/config/src/index.ts";
import { rateLimitEnv } from "../harness/rate-limit/api.ts";
import { createTree, removeTree, runScript } from "../harness/script-fixtures.ts";
import { expectedHeadersFile, INDEX_HTML } from "../harness/web-dist.ts";

const json = (...values: unknown[]) => JSON.stringify(values);

describe("TC-API-006-105 parseSponsorImageOrigins: unset and normalization (SPEC-180 section 13.2)", () => {
  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["an empty array", "[]"],
  ])("%s is an empty array (no Logo origin is allowed)", (_name, raw) => {
    expect(parseSponsorImageOrigins(raw)).toEqual([]);
  });

  it("normalizes to exact origins, drops duplicates and keeps the input order", () => {
    expect(
      parseSponsorImageOrigins(
        json(
          "https://Logo.Example.test",
          "https://cdn.example.test:443/",
          "https://logo.example.test",
          "https://Bücher.example.test",
        ),
      ),
    ).toEqual([
      "https://logo.example.test",
      "https://cdn.example.test",
      "https://xn--bcher-kva.example.test",
    ]);
  });

  it("the result is frozen", () => {
    expect(Object.isFrozen(parseSponsorImageOrigins(json("https://logo.example.test")))).toBe(true);
  });
});

describe("TC-API-006-105 parseSponsorImageOrigins: invalid is undefined, never a throw", () => {
  const unsafeElements = [
    "http://logo.example.test",
    "https://*.example.test",
    "https://192.0.2.1",
    "https://[2001:db8::1]",
    "https://localhost",
    "https://cdn.localhost",
    "https://x.local",
    "https://logo.example.test:8443",
    "https://logo.example.test/path",
    "https://logo.example.test/?q=1",
    "https://logo.example.test/#frag",
    "https://u:p@logo.example.test",
    "https://logo.example.test\\x",
    "https://logo example.test",
    "not a url",
    "",
  ];

  it.each(unsafeElements)("an array with the element %j is invalid as a whole", (element) => {
    expect(parseSponsorImageOrigins(json("https://ok.example.test", element))).toBeUndefined();
  });

  it.each([
    ["not JSON", "https://logo.example.test"],
    ["a JSON object", '{"a":"https://logo.example.test"}'],
    ["a JSON string", '"https://logo.example.test"'],
    ["a JSON number", "42"],
    ["null", "null"],
    ["an array with a number", '["https://logo.example.test", 1]'],
    ["an array with null", '["https://logo.example.test", null]'],
    ["an array with a nested array", '[["https://logo.example.test"]]'],
    ["truncated JSON", '["https://logo.example.test"'],
  ])("%s is invalid", (_name, raw) => {
    expect(parseSponsorImageOrigins(raw)).toBeUndefined();
  });

  it("does not throw on any input", () => {
    for (const raw of ["\u0000", "[", "]]", " ", "[]x", '["\\u0000"]'])
      expect(() => parseSponsorImageOrigins(raw)).not.toThrow();
  });
});

describe("TC-API-006-105 the API and the Pages headers normalize one setting the same way (SPEC-180 section 13.2)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) removeTree(root);
  });
  const viaHeaders = (raw: string): { accepted: boolean; origins: string[] } => {
    const root = createTree({ "dist/index.html": INDEX_HTML }, "r39x-origins-");
    roots.push(root);
    const dist = join(root, "dist");
    const result = runScript("generate-web-headers.mts", ["--dist", dist], {
      env: { SPONSOR_IMAGE_ALLOWED_ORIGINS: raw },
    });
    if (result.status !== 0) return { accepted: false, origins: [] };
    const headers = readFileSync(join(dist, "_headers"), "utf8");
    const img = /img-src 'self' data: blob:([^;\n]*)/.exec(headers)?.[1] ?? "";
    const origins = img.split(" ").filter((part) => part !== "");
    expect(headers).toBe(expectedHeadersFile({ imgOrigins: origins }));
    return { accepted: true, origins };
  };

  it.each([
    json("https://Logo.Example.test", "https://cdn.example.test:443/", "https://logo.example.test"),
    json("https://Bücher.example.test"),
    "[]",
    json("https://ok.example.test", "http://logo.example.test"),
    json("https://ok.example.test", "https://*.example.test"),
    json("https://ok.example.test", "https://192.0.2.1"),
    json("https://ok.example.test", "https://[2001:db8::1]"),
    json("https://ok.example.test", "https://x.local"),
    json("https://ok.example.test", "https://logo.example.test:8443"),
    json("https://ok.example.test", "https://logo.example.test/path"),
    json("https://ok.example.test", "https://u:p@logo.example.test"),
    json("https://ok.example.test", 1),
    "not json",
  ])("the same accepted origins or the same refusal for %s", (raw) => {
    const headers = viaHeaders(raw);
    const api = parseSponsorImageOrigins(raw);
    expect(api !== undefined).toBe(headers.accepted);
    if (api !== undefined) expect([...api]).toEqual(headers.origins);
  });
});

function apiEnvironment(): Record<string, string> {
  const url = new URL(`${"postgresql:"}//db.example.test/business`);
  url.username = "app_api_runtime";
  url.password = "synthetic";
  url.port = "5432";
  url.searchParams.set("sslmode", "verify-full");
  return {
    PORT: "8080",
    DATABASE_ENV_MARKER_SETTING: "deployment.environment",
    NEON_PROJECT_ID_SETTING: "deployment.project_id",
    NEON_BRANCH_ID_SETTING: "deployment.branch_id",
    APP_ENV: "test",
    DATABASE_URL: url.toString(),
    EXPECTED_NEON_PROJECT_ID: "synthetic-project",
    EXPECTED_NEON_BRANCH_ID: "synthetic-branch",
    EXPECTED_NEON_DATABASE_NAME: "business",
    EXPECTED_STRIPE_MODE: "test",
    EXPECTED_RESEND_ENV_ID: "synthetic-resend",
    EXPECTED_OBSERVABILITY_ENV: "test",
    EXPECTED_DATABASE_ENV_MARKER: "test",
    OBS_CORRELATION_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    OBS_CORRELATION_HMAC_KEY_VERSION: "1",
    RESEND_API_KEY: "synthetic",
    STRIPE_SECRET_KEY: ["sk", "test", "synthetic"].join("_"),
    QR_PROTECTION_CURRENT_VERSION: "1",
    QR_ALLOWED_READ_VERSIONS: "1",
    QR_KEYRING: JSON.stringify([
      {
        version: 1,
        hmacKey: Buffer.alloc(32, 1).toString("base64"),
        aeadKey: Buffer.alloc(32, 2).toString("base64"),
      },
    ]),
    AUTH_ISSUER: "https://auth.example.test",
    AUTH_AUDIENCE: "synthetic-api",
    AUTH_JWKS_URL: "https://auth.example.test/jwks",
    STRIPE_WEBHOOK_SECRET: "synthetic",
    RESEND_WEBHOOK_SECRET: "synthetic",
    APP_BASE_URL: "https://web.example.test",
    PUBLIC_WEB_ORIGIN: "https://web.example.test",
    PUBLIC_API_ORIGIN: "https://api.example.test",
    PUBLIC_AUTH_ORIGIN: "https://api.example.test",
    ALLOWED_HOSTS: "api.example.test",
    ALLOWED_ORIGINS: "https://web.example.test",
    ...rateLimitEnv(),
  };
}

describe("TC-API-006-105 parseServerConfig('api') carries sponsorImageOrigins (SPEC-180 section 13.2)", () => {
  it("is an empty array when the setting is not set", () => {
    expect(parseServerConfig("api", apiEnvironment()).sponsorImageOrigins).toEqual([]);
  });

  it("is the normalized origins when the setting is valid", () => {
    const config = parseServerConfig("api", {
      ...apiEnvironment(),
      SPONSOR_IMAGE_ALLOWED_ORIGINS: json(
        "https://Logos.example.test",
        "https://logos.example.test",
      ),
    });
    expect([...(config.sponsorImageOrigins ?? [])]).toEqual(["https://logos.example.test"]);
  });

  it.each(["not json", '["http://logos.example.test"]', '["https://*.example.test"]', "{}"])(
    "an invalid setting (%s) does not throw: sponsorImageOrigins is undefined and the rest of the config is read",
    (raw) => {
      const config = parseServerConfig("api", {
        ...apiEnvironment(),
        SPONSOR_IMAGE_ALLOWED_ORIGINS: raw,
      });
      expect(config).toHaveProperty("sponsorImageOrigins", undefined);
      expect(config.environment).toBe("test");
    },
  );
});
