import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { parseInitialDataInput } from "../../packages/db/src/initial-data/input.ts";
import { MAX_SLOTS_PER_RUN, slotCandidates } from "../../packages/db/src/initial-data/slots.ts";
import {
  buildCompleteInitialDataInput,
  buildGoodsInput,
  buildInitialDataInput,
  buildKaraokeInput,
  type InitialDataInput,
  type KaraokeInput,
  sensitiveValues,
} from "../harness/db/initial-data.ts";

// PR-GK-6 (UCR-180-007): the Goods and Karaoke part of the initial data input (SPEC-100 §13.5
// DB-SEED-001, DB-SEED-003; SPEC-090 §8.2 KRK-GEN-002/003; SPEC-170 TST-SEED-001/003). Synthetic values
// only. A rejection carries an error code only: no input value, key name or parser message.

const INVALID = { ok: false, errorCode: "INITIAL_DATA_INPUT_INVALID" };
const MINUTE = 60_000;

type Mutator = (input: InitialDataInput) => unknown;

function expectRejected(input: unknown) {
  const raw = JSON.stringify(input);
  const result = parseInitialDataInput(raw);
  expect(result).toEqual(INVALID);
  const text = JSON.stringify(result);
  if (input && typeof input === "object")
    for (const secret of sensitiveValues(input as InitialDataInput))
      expect(text).not.toContain(secret);
}

function expectAccepted(input: unknown) {
  const result = parseInitialDataInput(JSON.stringify(input));
  expect(result.ok).toBe(true);
  return result;
}

const karaokeOf = (input: InitialDataInput) => input.karaoke as KaraokeInput;
const goodsOf = (input: InitialDataInput) => input.goods as Record<string, unknown>[];
const windowAt = (start: string, end: string) => ({ window_start: start, window_end: end });

describe("TC-TST-SEED-003-025 the shape of the four top-level keys and the deferral null (DB-SEED-001, DB-SEED-003)", () => {
  it("TC-TST-SEED-003-025 a complete input is accepted and keeps every Goods and Karaoke value", () => {
    const input = buildCompleteInitialDataInput({ scopeCount: 2, goodsCount: 2 });
    const result = expectAccepted(input);
    if (!result.ok) throw new Error("unreachable");
    const goods = result.value.goods;
    expect(goods).toHaveLength(2);
    expect(goods?.[0]?.name).toBe(goodsOf(input)[0]?.name);
    expect(goods?.[0]?.unit_amount).toBe(goodsOf(input)[0]?.unit_amount);
    const karaoke = result.value.karaoke;
    expect(karaoke?.sales_configuration.name).toBe(karaokeOf(input).sales_configuration.name);
    expect(karaoke?.exclusive_scopes.map((scope) => scope.sort_order)).toEqual([0, 1]);
    expect(karaoke?.slot_windows).toHaveLength(3);
  });

  it("TC-TST-SEED-003-025 goods and karaoke may each be null (deferred); the parsed value keeps null", () => {
    for (const [goods, karaoke] of [
      [null, null],
      [buildGoodsInput(), null],
      [null, buildKaraokeInput()],
    ] as const) {
      const result = expectAccepted(buildInitialDataInput({ goods, karaoke }));
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.goods === null).toBe(goods === null);
      expect(result.value.karaoke === null).toBe(karaoke === null);
    }
  });

  it("TC-TST-SEED-003-025 a Goods row without the nullable description is accepted, with NULL", () => {
    const result = expectAccepted(
      buildInitialDataInput({ goods: buildGoodsInput({ variant: "minimal" }) }),
    );
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.goods?.[0]?.description).toBeNull();
  });

  const rejected: [string, Mutator][] = [
    ["a missing goods key", ({ goods: _goods, ...rest }) => rest],
    ["a missing karaoke key", ({ karaoke: _karaoke, ...rest }) => rest],
    ["an unknown fifth top-level key", (i) => ({ ...i, karaoke_slots: [] })],
    ["a null event", (i) => ({ ...i, event: null })],
    ["a null entry_ticket_offerings", (i) => ({ ...i, entry_ticket_offerings: null })],
    ["an empty goods array", (i) => ({ ...i, goods: [] })],
    ["a goods object instead of an array", (i) => ({ ...i, goods: goodsOf(i)[0] })],
    ["a null Goods element", (i) => ({ ...i, goods: [null] })],
    ["a karaoke array instead of an object", (i) => ({ ...i, karaoke: [karaokeOf(i)] })],
    [
      "karaoke without sales_configuration",
      (i) => {
        const { sales_configuration: _config, ...rest } = karaokeOf(i);
        return { ...i, karaoke: rest };
      },
    ],
    [
      "karaoke without exclusive_scopes",
      (i) => {
        const { exclusive_scopes: _scopes, ...rest } = karaokeOf(i);
        return { ...i, karaoke: rest };
      },
    ],
    [
      "karaoke without slot_windows",
      (i) => {
        const { slot_windows: _windows, ...rest } = karaokeOf(i);
        return { ...i, karaoke: rest };
      },
    ],
    ["an unknown key in karaoke", (i) => ({ ...i, karaoke: { ...karaokeOf(i), slots: [] } })],
    [
      "a null sales_configuration",
      (i) => ({ ...i, karaoke: { ...karaokeOf(i), sales_configuration: null } }),
    ],
    [
      "an array of sales configurations",
      (i) => ({
        ...i,
        karaoke: { ...karaokeOf(i), sales_configuration: [karaokeOf(i).sales_configuration] },
      }),
    ],
    [
      "an empty exclusive_scopes array",
      (i) => ({ ...i, karaoke: { ...karaokeOf(i), exclusive_scopes: [] } }),
    ],
    [
      "a null exclusive_scopes",
      (i) => ({ ...i, karaoke: { ...karaokeOf(i), exclusive_scopes: null } }),
    ],
    [
      "an empty slot_windows array",
      (i) => ({ ...i, karaoke: { ...karaokeOf(i), slot_windows: [] } }),
    ],
    ["a null slot_windows", (i) => ({ ...i, karaoke: { ...karaokeOf(i), slot_windows: null } })],
  ];
  for (const [label, mutate] of rejected) {
    it(`TC-TST-SEED-003-025 ${label} is rejected`, () => {
      expectRejected(mutate(buildCompleteInitialDataInput()));
    });
  }
});

describe("TC-TST-SEED-003-025 Goods, Sales Configuration and Scope values: the same conditions as the CHECKs (DB-SEED-003)", () => {
  const goods0 = (i: InitialDataInput) => goodsOf(i)[0] as Record<string, unknown>;
  const config = (i: InitialDataInput) => karaokeOf(i).sales_configuration;
  const scope0 = (i: InitialDataInput) =>
    karaokeOf(i).exclusive_scopes[0] as Record<string, unknown>;

  const rejected: [string, (i: InitialDataInput) => void][] = [
    ["Goods without a name", (i) => delete goods0(i).name],
    [
      "Goods with a numeric name",
      (i) => {
        goods0(i).name = 1;
      },
    ],
    [
      "Goods with a negative unit_amount",
      (i) => {
        goods0(i).unit_amount = -1;
      },
    ],
    [
      "Goods with a fractional unit_amount",
      (i) => {
        goods0(i).unit_amount = 1.5;
      },
    ],
    [
      "Goods with a lower-case currency",
      (i) => {
        goods0(i).currency = "jpy";
      },
    ],
    ["Goods without a currency", (i) => delete goods0(i).currency],
    [
      "Goods with purchase_limit 0",
      (i) => {
        goods0(i).purchase_limit = 0;
      },
    ],
    ["Goods without sales_starts_at", (i) => delete goods0(i).sales_starts_at],
    ["Goods without sales_ends_at", (i) => delete goods0(i).sales_ends_at],
    [
      "Goods whose sales period is empty",
      (i) => {
        goods0(i).sales_ends_at = goods0(i).sales_starts_at;
      },
    ],
    [
      "Goods whose sales period is reversed",
      (i) => {
        goods0(i).sales_starts_at = "2030-06-01T00:00:00+09:00";
      },
    ],
    [
      "a timestamp without an offset",
      (i) => {
        goods0(i).sales_starts_at = "2030-04-01T00:00:00";
      },
    ],
    [
      "only the second Goods row invalid",
      (i) => {
        i.goods = buildGoodsInput({ count: 2 });
        (i.goods[1] as Record<string, unknown>).unit_amount = -1;
      },
    ],
    ["a Sales Configuration without a name", (i) => delete config(i).name],
    [
      "a Sales Configuration with a negative unit_amount",
      (i) => {
        config(i).unit_amount = -1;
      },
    ],
    [
      "a Sales Configuration with currency JP",
      (i) => {
        config(i).currency = "JP";
      },
    ],
    [
      "a Sales Configuration with purchase_limit 0",
      (i) => {
        config(i).purchase_limit = 0;
      },
    ],
    [
      "a Sales Configuration whose sales period is reversed",
      (i) => {
        config(i).sales_starts_at = "2030-06-01T00:00:00+09:00";
      },
    ],
    [
      "a Sales Configuration with a description",
      (i) => {
        config(i).description = "x";
      },
    ],
    ["a Scope without a name", (i) => delete scope0(i).name],
    ["a Scope without sort_order (no DB DEFAULT relied on)", (i) => delete scope0(i).sort_order],
    [
      "a Scope with a fractional sort_order",
      (i) => {
        scope0(i).sort_order = 0.5;
      },
    ],
    [
      "a Scope with sort_order beyond integer",
      (i) => {
        scope0(i).sort_order = 2147483648;
      },
    ],
    [
      "a Scope with a string sort_order",
      (i) => {
        scope0(i).sort_order = "0";
      },
    ],
  ];
  for (const [label, mutate] of rejected) {
    it(`TC-TST-SEED-003-025 ${label} is rejected`, () => {
      const input = buildCompleteInitialDataInput();
      mutate(input);
      expectRejected(input);
    });
  }

  it("TC-TST-SEED-003-025 no CHECK limits sort_order or the text: a negative sort_order and an empty name are accepted", () => {
    const input = buildCompleteInitialDataInput();
    scope0(input).sort_order = -1;
    scope0(input).name = "";
    goods0(input).name = "";
    expectAccepted(input);
  });
});

describe("TC-TST-SEED-001-006 fields the command never accepts for Goods and Karaoke (DB-SEED-003)", () => {
  const cases: [string, string, unknown, (i: InitialDataInput) => Record<string, unknown>][] = [];
  const goods = (i: InitialDataInput) => goodsOf(i)[0] as Record<string, unknown>;
  const config = (i: InitialDataInput) => karaokeOf(i).sales_configuration;
  const scope = (i: InitialDataInput) =>
    karaokeOf(i).exclusive_scopes[0] as Record<string, unknown>;
  const window = (i: InitialDataInput) => karaokeOf(i).slot_windows[0] as Record<string, unknown>;
  const common: [string, unknown][] = [
    ["id", 1],
    ["public_ref", "00000000-0000-4000-8000-000000000001"],
    ["event_id", 1],
    ["created_at", "2030-01-01T00:00:00Z"],
    ["updated_at", "2030-01-01T00:00:00Z"],
  ];
  for (const [key, value] of [
    ...common,
    ["sale_control_state", "ENABLED"],
    ["saleable_capacity", 0],
    ["held_quantity", 0],
    ["committed_quantity", 0],
    ["goods_id", 1],
  ] as [string, unknown][])
    cases.push(["Goods", key, value, goods]);
  for (const [key, value] of [
    ...common,
    ["sale_control_state", "ENABLED"],
    ["standard_usage_minutes", 15],
    ["standard_maintenance_minutes", 5],
  ] as [string, unknown][])
    cases.push(["Sales Configuration", key, value, config]);
  for (const [key, value] of common) cases.push(["Scope", key, value, scope]);
  for (const [key, value] of [
    ["state", "AVAILABLE"],
    ["usage_start", "2030-05-10T18:00:00+09:00"],
    ["usage_end", "2030-05-10T18:15:00+09:00"],
    ["cycle_end", "2030-05-10T18:20:00+09:00"],
    ["generation_cause_key", "00000000-0000-4000-8000-000000000002"],
    ["generation_candidate_no", 0],
    ["exclusive_scope_id", 1],
    ["sales_configuration_id", 1],
    ["public_ref", "00000000-0000-4000-8000-000000000003"],
  ] as [string, unknown][])
    cases.push(["window", key, value, window]);

  it("TC-TST-SEED-001-006 the baseline complete input is accepted, so each rejection below is caused by the key", () => {
    expectAccepted(buildCompleteInitialDataInput());
  });
  for (const [where, key, value, pick] of cases) {
    it(`TC-TST-SEED-001-006 ${key} in the ${where} object is rejected without echoing the value`, () => {
      const input = buildCompleteInitialDataInput();
      pick(input)[key] = value;
      expectRejected(input);
    });
  }
});

describe("TC-TST-SEED-003-026 Slot windows (DB-SEED-003 (1)-(4), KRK-GEN-002/003, DB-KRK-002)", () => {
  const withWindows = (windows: { window_start: string; window_end: string }[], scopeCount = 1) =>
    buildInitialDataInput({ karaoke: buildKaraokeInput({ windows, scopeCount }) });

  it("TC-TST-SEED-003-026 (1) an empty or reversed window is rejected", () => {
    expectRejected(
      withWindows([windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T18:00:00+09:00")]),
    );
    expectRejected(
      withWindows([windowAt("2030-05-10T19:00:00+09:00", "2030-05-10T18:00:00+09:00")]),
    );
  });

  it("TC-TST-SEED-003-026 (1) a window without an offset, or not a timestamp, is rejected", () => {
    expectRejected(withWindows([windowAt("2030-05-10T18:00:00", "2030-05-10T19:00:00+09:00")]));
    expectRejected(withWindows([windowAt("2030-05-10", "2030-05-11")]));
    expectRejected(
      buildInitialDataInput({
        karaoke: {
          ...buildKaraokeInput(),
          slot_windows: [{ window_start: "2030-05-10T18:00:00+09:00" }],
        },
      }),
    );
  });

  it("TC-TST-SEED-003-026 (2) a window shorter than one 20 minute cycle makes no candidate and is rejected", () => {
    expectRejected(
      withWindows([windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T18:19:59+09:00")]),
    );
    expectAccepted(
      withWindows([windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T18:20:00+09:00")]),
    );
  });

  it("TC-TST-SEED-003-026 (3) windows whose candidates overlap are rejected", () => {
    expectRejected(
      withWindows([
        windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T19:00:00+09:00"),
        windowAt("2030-05-10T18:30:00+09:00", "2030-05-10T19:30:00+09:00"),
      ]),
    );
    // The same window twice: every candidate overlaps.
    expectRejected(
      withWindows([
        windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T19:00:00+09:00"),
        windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T19:00:00+09:00"),
      ]),
    );
    // Given in reverse order: still found.
    expectRejected(
      withWindows([
        windowAt("2030-05-10T18:50:00+09:00", "2030-05-10T19:30:00+09:00"),
        windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T19:00:00+09:00"),
      ]),
    );
  });

  it("TC-TST-SEED-003-026 (3) touching candidates are accepted, and so are overlapping windows whose candidates do not overlap", () => {
    expectAccepted(
      withWindows([
        windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T19:00:00+09:00"),
        windowAt("2030-05-10T19:00:00+09:00", "2030-05-10T20:00:00+09:00"),
      ]),
    );
    // Candidates [18:00, 18:20) and [18:20, 18:40); then [18:45, 19:05) and [19:05, 19:25).
    expectAccepted(
      withWindows([
        windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T18:50:00+09:00"),
        windowAt("2030-05-10T18:45:00+09:00", "2030-05-10T19:30:00+09:00"),
      ]),
    );
  });

  it(`TC-TST-SEED-003-026 (4) at most ${MAX_SLOTS_PER_RUN} Slots per run, counted over every Scope`, () => {
    expect(MAX_SLOTS_PER_RUN).toBe(1000);
    const start = Date.parse("2030-05-10T00:00:00Z");
    const end = (candidates: number) => new Date(start + candidates * 20 * MINUTE).toISOString();
    const startText = new Date(start).toISOString();
    expectAccepted(withWindows([windowAt(startText, end(1000))], 1));
    expectRejected(withWindows([windowAt(startText, end(1001))], 1));
    expectAccepted(withWindows([windowAt(startText, end(500))], 2));
    expectRejected(withWindows([windowAt(startText, end(501))], 2));
    // Split over windows, the total still counts.
    expectRejected(withWindows([windowAt(startText, end(600)), windowAt(end(600), end(1001))], 1));
  });
});

describe("TC-TST-SEED-001-007 Slot candidates follow the standard algorithm (SPEC-090 §8.2, KRK-GEN-002/003, KRK-GEN-001 exception)", () => {
  const times = (windows: { window_start: string; window_end: string }[]) =>
    slotCandidates(windows).map((candidate) => [
      candidate.candidateNo,
      new Date(candidate.usageStart).toISOString(),
      new Date(candidate.usageEnd).toISOString(),
      new Date(candidate.cycleEnd).toISOString(),
    ]);

  it("TC-TST-SEED-001-007 a one hour window gives three 15 + 5 minute candidates from window_start", () => {
    expect(times([windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T19:00:00+09:00")])).toEqual([
      [0, "2030-05-10T09:00:00.000Z", "2030-05-10T09:15:00.000Z", "2030-05-10T09:20:00.000Z"],
      [1, "2030-05-10T09:20:00.000Z", "2030-05-10T09:35:00.000Z", "2030-05-10T09:40:00.000Z"],
      [2, "2030-05-10T09:40:00.000Z", "2030-05-10T09:55:00.000Z", "2030-05-10T10:00:00.000Z"],
    ]);
  });

  it("TC-TST-SEED-001-007 KRK-GEN-002: no incomplete last cycle; KRK-GEN-003: the anchor is not rounded", () => {
    expect(
      times([windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T18:50:00+09:00")]),
    ).toHaveLength(2);
    expect(times([windowAt("2030-05-10T18:07:00+09:00", "2030-05-10T18:47:00+09:00")])).toEqual([
      [0, "2030-05-10T09:07:00.000Z", "2030-05-10T09:22:00.000Z", "2030-05-10T09:27:00.000Z"],
      [1, "2030-05-10T09:27:00.000Z", "2030-05-10T09:42:00.000Z", "2030-05-10T09:47:00.000Z"],
    ]);
  });

  it("TC-TST-SEED-001-007 a window across midnight (Asia/Tokyo) is allowed", () => {
    expect(
      times([windowAt("2030-05-10T23:30:00+09:00", "2030-05-11T00:30:00+09:00")]),
    ).toHaveLength(3);
  });

  it("TC-TST-SEED-001-007 candidates of several windows are numbered 0.. in usage_start order, whatever the input order", () => {
    const result = times([
      windowAt("2030-05-12T18:00:00+09:00", "2030-05-12T18:40:00+09:00"),
      windowAt("2030-05-10T18:00:00+09:00", "2030-05-10T18:20:00+09:00"),
      windowAt("2030-05-11T18:00:00+09:00", "2030-05-11T18:20:00+09:00"),
    ]);
    expect(result.map((row) => row[0])).toEqual([0, 1, 2, 3]);
    expect(result.map((row) => row[1])).toEqual([
      "2030-05-10T09:00:00.000Z",
      "2030-05-11T09:00:00.000Z",
      "2030-05-12T09:00:00.000Z",
      "2030-05-12T09:20:00.000Z",
    ]);
  });
});

describe("TC-TST-SEED-003-028 the Slot bound is decided before any candidate is expanded (DB-SEED-003 (4), SPEC-150 section 9)", () => {
  // A window of four millennia is a valid pair of timestamps but would make about a hundred million
  // candidates. The bound must be decided from the window lengths, not by building the candidates: a
  // synchronous expansion would block the event loop (and the transaction deadline timer) and could
  // exhaust memory.
  const centuries = (scopeCount: number) =>
    buildInitialDataInput({
      karaoke: buildKaraokeInput({
        scopeCount,
        windows: [windowAt("2030-01-01T00:00:00+09:00", "6030-01-01T00:00:00+09:00")],
      }),
    });

  for (const scopeCount of [1, 3]) {
    it(`TC-TST-SEED-003-028 a four-millennium window with ${scopeCount} Scope(s) is rejected at once`, () => {
      const input = JSON.stringify(centuries(scopeCount));
      const startedAt = performance.now();
      const result = parseInitialDataInput(input);
      const elapsedMs = performance.now() - startedAt;
      expect(result).toEqual(INVALID);
      expect(elapsedMs).toBeLessThan(100);
    });
  }

  it("TC-TST-SEED-003-028 many short windows past the bound are rejected without reading them all", () => {
    const start = Date.parse("2030-05-10T00:00:00Z");
    const windows = Array.from({ length: 200_000 }, (_, index) =>
      windowAt(
        new Date(start + index * 20 * MINUTE).toISOString(),
        new Date(start + (index + 1) * 20 * MINUTE).toISOString(),
      ),
    );
    const startedAt = performance.now();
    const result = parseInitialDataInput(
      JSON.stringify(buildInitialDataInput({ karaoke: buildKaraokeInput({ windows }) })),
    );
    expect(result).toEqual(INVALID);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });
});
