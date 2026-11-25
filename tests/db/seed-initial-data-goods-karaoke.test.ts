import { performance } from "node:perf_hooks";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startCommitAcknowledgementDropProxy } from "../harness/db/commit-proxy.ts";
import { prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  buildCompleteInitialDataInput,
  buildGoodsInput,
  buildInitialDataInput,
  buildKaraokeInput,
  connectAs,
  disallowedStatements,
  endQuietly,
  type InitialDataInput,
  insertedTables,
  type RecordedLog,
  resetInitialData,
  runSeed,
  type SeedTargets,
  sensitiveValues,
  shape,
  snapshotSeededTables,
} from "../harness/db/initial-data.ts";

// PR-GK-6 C1 on a real PostgreSQL 17: Goods (with Inventory), the Karaoke Sales Configuration, the
// Exclusive Scopes and their Slots as initial data (UCR-180-007; SPEC-100 §13.5 DB-SEED-001..005;
// SPEC-090 KRK-GEN-001 exception; SPEC-180 INF-SEED-003..005; SPEC-160 OBS-AUD-014; SPEC-170 TST-SEED-001..006).
// Synthetic values only (DB-SEED-006).

const url = process.env.TEST_DATABASE_URL;
if (!url || !process.env.TEST_DATABASE_CA)
  throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

vi.setConfig({ testTimeout: 60_000 });

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MINUTE = 60_000;
const ALL_CREATED: SeedTargets = {
  event: "CREATED",
  entry_ticket_offerings: "CREATED",
  goods: "CREATED",
  karaoke_sales_configuration: "CREATED",
  karaoke_exclusive_scopes: "CREATED",
  karaoke_slots: "CREATED",
};
const ALL_EXISTING: SeedTargets = {
  event: "EXISTING",
  entry_ticket_offerings: "EXISTING",
  goods: "EXISTING",
  karaoke_sales_configuration: "EXISTING",
  karaoke_exclusive_scopes: "EXISTING",
  karaoke_slots: "EXISTING",
};
const GOODS_FIELDS = [
  "name",
  "description",
  "unit_amount",
  "currency",
  "sales_starts_at",
  "sales_ends_at",
  "purchase_limit",
  "sale_control_state",
  "saleable_capacity",
  "held_quantity",
  "committed_quantity",
];
const CONFIG_FIELDS = [
  "name",
  "unit_amount",
  "currency",
  "sales_starts_at",
  "sales_ends_at",
  "purchase_limit",
  "sale_control_state",
  "standard_usage_minutes",
  "standard_maintenance_minutes",
];
const SCOPE_FIELDS = ["name", "sort_order"];
const SLOT_FIELDS = [
  "state",
  "usage_start",
  "usage_end",
  "cycle_end",
  "generation_cause_key",
  "generation_candidate_no",
];

let admin: Client;
beforeAll(async () => {
  admin = new Client({ connectionString: url });
  await admin.connect();
  await prepareFoundationDatabase(admin);
});
afterAll(async () => {
  await admin?.end();
});
beforeEach(async () => {
  await resetInitialData(admin);
});

const rows = async (table: string, order = "id") =>
  (await admin.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
const events = () => rows("app.events");
const goods = () => rows("app.goods");
const inventory = () => rows("app.goods_inventory", "goods_id");
const configs = () => rows("app.karaoke_sales_configurations");
const scopes = () => rows("app.karaoke_exclusive_scopes");
const slots = () => rows("app.karaoke_slots", "exclusive_scope_id, usage_start");
const audits = () => rows("app.audit_events");
const counts = async () => ({
  events: (await events()).length,
  offerings: (await rows("app.entry_ticket_offerings")).length,
  goods: (await goods()).length,
  inventory: (await inventory()).length,
  configs: (await configs()).length,
  scopes: (await scopes()).length,
  slots: (await slots()).length,
  audits: (await audits()).length,
});
const EMPTY = {
  events: 0,
  offerings: 0,
  goods: 0,
  inventory: 0,
  configs: 0,
  scopes: 0,
  slots: 0,
  audits: 0,
};
const sorted = (values: Iterable<string>) => [...values].sort();
const refs = (list: Record<string, unknown>[]) => sorted(list.map((row) => String(row.public_ref)));

async function insertManualEvent(): Promise<string> {
  return (
    await admin.query(
      "INSERT INTO app.events (name) VALUES ('合成データ 手動イベント') RETURNING id::text",
    )
  ).rows[0].id;
}
async function insertManualOffering(eventId: string) {
  await admin.query(
    `INSERT INTO app.entry_ticket_offerings
       (event_id, name, unit_amount, currency, sales_starts_at, sales_ends_at, sale_control_state,
        sales_capacity, purchase_limit)
     VALUES ($1, '合成データ 手動入場券', 100, 'JPY', '2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z',
             'SUSPENDED', 10, 2)`,
    [eventId],
  );
}
async function insertManualGoods(eventId: string) {
  const id = (
    await admin.query(
      `INSERT INTO app.goods
         (event_id, name, unit_amount, currency, sales_starts_at, sales_ends_at, sale_control_state,
          purchase_limit)
       VALUES ($1, '合成データ 手動グッズ', 300, 'JPY', '2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z',
               'SUSPENDED', 1)
       RETURNING id::text`,
      [eventId],
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO app.goods_inventory (goods_id, saleable_capacity) VALUES ($1, 0)",
    [id],
  );
}
async function insertManualConfig(eventId: string): Promise<string> {
  return (
    await admin.query(
      `INSERT INTO app.karaoke_sales_configurations
         (event_id, name, unit_amount, currency, sales_starts_at, sales_ends_at, sale_control_state,
          purchase_limit)
       VALUES ($1, '合成データ 手動カラオケ', 500, 'JPY', '2030-01-01T00:00:00Z',
               '2030-02-01T00:00:00Z', 'SUSPENDED', 1)
       RETURNING id::text`,
      [eventId],
    )
  ).rows[0].id;
}
async function insertManualScope(eventId: string): Promise<string> {
  return (
    await admin.query(
      `INSERT INTO app.karaoke_exclusive_scopes (event_id, name, sort_order)
       VALUES ($1, '合成データ 手動機材', 0) RETURNING id::text`,
      [eventId],
    )
  ).rows[0].id;
}
async function insertManualSlot(scopeId: string, configId: string) {
  await admin.query(
    `INSERT INTO app.karaoke_slots
       (exclusive_scope_id, sales_configuration_id, state, usage_start, usage_end, cycle_end,
        generation_cause_key, generation_candidate_no)
     VALUES ($1, $2, 'AVAILABLE', '2030-01-10T09:00:00Z', '2030-01-10T09:15:00Z',
             '2030-01-10T09:20:00Z', gen_random_uuid(), 0)`,
    [scopeId, configId],
  );
}
/** Event, Offerings, Goods, Sales Configuration, one Scope with one Slot: no candidate is left. */
async function insertManualCompleteSet(): Promise<void> {
  const eventId = await insertManualEvent();
  await insertManualOffering(eventId);
  await insertManualGoods(eventId);
  const configId = await insertManualConfig(eventId);
  await insertManualSlot(await insertManualScope(eventId), configId);
}

describe("TC-TST-SEED-001-005 an empty database gets every target, with the fixed values (DB-SEED-001, 003, 004; KRK-GEN-001)", () => {
  it("TC-TST-SEED-001-005 CREATED: Goods with Inventory 0, SUSPENDED Sales Configuration 15/5, Scopes, standard AVAILABLE Slots", async () => {
    const input = buildCompleteInitialDataInput({ scopeCount: 2, goodsCount: 2 });
    const run = await runSeed({ input });
    const outcome = shape(run.outcome);
    expect(outcome.outcome).toBe("CREATED");
    expect(outcome.targets).toEqual(ALL_CREATED);
    expect(run.reads()).toBe(1);

    const [event] = await events();
    const goodsRows = await goods();
    expect(goodsRows).toHaveLength(2);
    goodsRows.forEach((row, index) => {
      const wanted = (input.goods as Record<string, unknown>[])[index] as Record<string, unknown>;
      expect(row.event_id).toBe(event.id);
      expect(row.name).toBe(wanted.name);
      expect(row.description).toBe(wanted.description);
      expect(row.unit_amount).toBe(String(wanted.unit_amount));
      expect(row.currency).toBe("JPY");
      expect(row.sales_starts_at.getTime()).toBe(Date.parse(wanted.sales_starts_at as string));
      expect(row.sales_ends_at.getTime()).toBe(Date.parse(wanted.sales_ends_at as string));
      expect(row.purchase_limit).toBe(wanted.purchase_limit);
      expect(row.sale_control_state).toBe("SUSPENDED");
      expect(row.public_ref).toMatch(UUID_V4);
    });
    // DB-GDS-001: one Inventory row per Goods, in the same transaction, with no stock.
    const stock = await inventory();
    expect(stock.map((row) => row.goods_id)).toEqual(goodsRows.map((row) => row.id));
    for (const row of stock) {
      expect(row.saleable_capacity).toBe(0);
      expect(row.held_quantity).toBe(0);
      expect(row.committed_quantity).toBe(0);
    }

    const karaoke = input.karaoke as NonNullable<InitialDataInput["karaoke"]>;
    const [config, ...moreConfigs] = await configs();
    expect(moreConfigs).toHaveLength(0);
    expect(config.event_id).toBe(event.id);
    expect(config.name).toBe(karaoke.sales_configuration.name);
    expect(config.unit_amount).toBe(String(karaoke.sales_configuration.unit_amount));
    expect(config.purchase_limit).toBe(karaoke.sales_configuration.purchase_limit);
    expect(config.sale_control_state).toBe("SUSPENDED");
    expect(config.standard_usage_minutes).toBe(15);
    expect(config.standard_maintenance_minutes).toBe(5);

    const scopeRows = await scopes();
    expect(scopeRows.map((row) => [row.event_id, row.name, row.sort_order])).toEqual(
      karaoke.exclusive_scopes.map((scope) => [event.id, scope.name, scope.sort_order]),
    );

    // Three one-hour windows: three candidates each, for each Scope (SPEC-090 §8.2).
    const slotRows = await slots();
    expect(slotRows).toHaveLength(2 * 9);
    const starts = karaoke.slot_windows.flatMap((window) => {
      const from = Date.parse(window.window_start as string);
      return [0, 1, 2].map((n) => from + n * 20 * MINUTE);
    });
    for (const scope of scopeRows) {
      const own = slotRows.filter((row) => row.exclusive_scope_id === scope.id);
      expect(own.map((row) => row.usage_start.getTime())).toEqual(starts);
      own.forEach((row, index) => {
        expect(row.state).toBe("AVAILABLE");
        expect(row.sales_configuration_id).toBe(config.id);
        expect(row.usage_end.getTime() - row.usage_start.getTime()).toBe(15 * MINUTE);
        expect(row.cycle_end.getTime() - row.usage_start.getTime()).toBe(20 * MINUTE);
        expect(row.generation_cause_key).toBe(outcome.operationExecutionId);
        expect(row.generation_candidate_no).toBe(index);
        expect(row.public_ref).toMatch(UUID_V4);
      });
    }

    expect(sorted(outcome.created?.goods ?? [])).toEqual(refs(goodsRows));
    expect(outcome.created?.karaoke_sales_configurations).toEqual([config.public_ref]);
    expect(sorted(outcome.created?.karaoke_exclusive_scopes ?? [])).toEqual(refs(scopeRows));
    expect(sorted(outcome.created?.karaoke_slots ?? [])).toEqual(refs(slotRows));
  });

  it("TC-TST-SEED-001-005 a Goods row without description keeps description NULL (no guessed value)", async () => {
    const input = buildInitialDataInput({ goods: buildGoodsInput({ variant: "minimal" }) });
    expect(shape((await runSeed({ input })).outcome).outcome).toBe("CREATED");
    const [row] = await goods();
    expect(row.description).toBeNull();
  });

  it("TC-TST-SEED-001-005 the API runtime role can read the seeded rows (database privilege only, not an API check)", async () => {
    await runSeed({ input: buildCompleteInitialDataInput() });
    const runtime = await connectAs("app_api_runtime");
    try {
      for (const table of [
        "app.goods",
        "app.goods_inventory",
        "app.karaoke_sales_configurations",
        "app.karaoke_exclusive_scopes",
        "app.karaoke_slots",
      ]) {
        const seen = (await runtime.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
        expect(seen, table).toBeGreaterThan(0);
      }
    } finally {
      await endQuietly(runtime);
    }
  });
});

describe("TC-TST-SEED-002-007 each target is decided on its own (DB-SEED-001)", () => {
  it("TC-TST-SEED-002-007 Event and Offerings first (Goods and Karaoke deferred), then Goods and Karaoke only", async () => {
    const first = shape((await runSeed({ input: buildInitialDataInput() })).outcome);
    expect(first.outcome).toBe("CREATED");
    expect(first.targets).toEqual({
      event: "CREATED",
      entry_ticket_offerings: "CREATED",
      goods: "DEFERRED",
      karaoke_sales_configuration: "DEFERRED",
      karaoke_exclusive_scopes: "DEFERRED",
      karaoke_slots: "DEFERRED",
    });
    expect(await counts()).toMatchObject({
      events: 1,
      offerings: 2,
      goods: 0,
      configs: 0,
      slots: 0,
    });
    const before = await snapshotSeededTables(admin);

    const second = shape((await runSeed({ input: buildCompleteInitialDataInput() })).outcome);
    expect(second.outcome).toBe("CREATED");
    expect(second.targets).toEqual({
      event: "EXISTING",
      entry_ticket_offerings: "EXISTING",
      goods: "CREATED",
      karaoke_sales_configuration: "CREATED",
      karaoke_exclusive_scopes: "CREATED",
      karaoke_slots: "CREATED",
    });
    expect(second.created?.events).toEqual([]);
    expect(second.created?.entry_ticket_offerings).toEqual([]);
    const after = await snapshotSeededTables(admin);
    expect(after.events).toEqual(before.events);
    expect(after.offerings).toEqual(before.offerings);
    expect(await counts()).toMatchObject({
      goods: 1,
      inventory: 1,
      configs: 1,
      scopes: 1,
      slots: 9,
    });
    const [event] = await events();
    for (const row of [...(await goods()), ...(await configs()), ...(await scopes())])
      expect(row.event_id).toBe(event.id);
  });

  it("TC-TST-SEED-002-007 an existing Sales Configuration is kept and referenced; only the Scopes and Slots are created", async () => {
    const eventId = await insertManualEvent();
    await insertManualOffering(eventId);
    await insertManualGoods(eventId);
    const configId = await insertManualConfig(eventId);
    const before = await snapshotSeededTables(admin);
    const run = await runSeed({ input: buildCompleteInitialDataInput() });
    const outcome = shape(run.outcome);
    expect(outcome.outcome).toBe("CREATED");
    expect(outcome.targets).toEqual({
      ...ALL_EXISTING,
      karaoke_exclusive_scopes: "CREATED",
      karaoke_slots: "CREATED",
    });
    expect((await snapshotSeededTables(admin)).karaokeSalesConfigurations).toEqual(
      before.karaokeSalesConfigurations,
    );
    const slotRows = await slots();
    expect(slotRows).toHaveLength(9);
    expect(slotRows.every((row) => row.sales_configuration_id === configId)).toBe(true);
  });

  it("TC-TST-SEED-002-007 existing Scopes with Slots get no new Slot; only the missing Goods are created", async () => {
    const eventId = await insertManualEvent();
    await insertManualOffering(eventId);
    const configId = await insertManualConfig(eventId);
    await insertManualSlot(await insertManualScope(eventId), configId);
    const before = await snapshotSeededTables(admin);
    const run = await runSeed({ input: buildCompleteInitialDataInput({ scopeCount: 3 }) });
    const outcome = shape(run.outcome);
    expect(outcome.outcome).toBe("CREATED");
    expect(outcome.targets).toEqual({ ...ALL_EXISTING, goods: "CREATED" });
    const after = await snapshotSeededTables(admin);
    expect(after.karaokeSalesConfigurations).toEqual(before.karaokeSalesConfigurations);
    expect(after.karaokeScopes).toEqual(before.karaokeScopes);
    expect(after.karaokeSlots).toEqual(before.karaokeSlots);
    expect(await counts()).toMatchObject({ goods: 1, inventory: 1, scopes: 1, slots: 1 });
  });

  it("TC-TST-SEED-002-007 existing Goods are never topped up, whatever the input count", async () => {
    const eventId = await insertManualEvent();
    await insertManualOffering(eventId);
    await insertManualGoods(eventId);
    const run = await runSeed({
      input: buildInitialDataInput({ goods: buildGoodsInput({ count: 3 }) }),
    });
    const outcome = shape(run.outcome);
    expect(outcome.outcome).toBe("NOOP");
    expect(outcome.targets?.goods).toBe("EXISTING");
    expect(outcome.targets?.karaoke_exclusive_scopes).toBe("DEFERRED");
    expect(await counts()).toMatchObject({ goods: 1, inventory: 1, audits: 0 });
  });
});

describe("TC-TST-SEED-002-008 deferral by null (DB-SEED-001, DB-SEED-003, INF-SEED-004)", () => {
  it("TC-TST-SEED-002-008 goods null: no Goods row and no GOODS Audit Event; Karaoke is created", async () => {
    const run = await runSeed({ input: buildInitialDataInput({ karaoke: buildKaraokeInput() }) });
    const outcome = shape(run.outcome);
    expect(outcome.outcome).toBe("CREATED");
    expect(outcome.targets?.goods).toBe("DEFERRED");
    expect(outcome.targets?.karaoke_slots).toBe("CREATED");
    expect(outcome.created?.goods).toEqual([]);
    expect(await counts()).toMatchObject({
      goods: 0,
      inventory: 0,
      configs: 1,
      scopes: 1,
      slots: 9,
    });
    expect((await audits()).some((row) => row.target_type === "GOODS")).toBe(false);
  });

  it("TC-TST-SEED-002-008 every candidate deferred: NOOP, the input is read, nothing is written", async () => {
    const eventId = await insertManualEvent();
    await insertManualOffering(eventId);
    const before = await snapshotSeededTables(admin);
    const run = await runSeed({ input: buildInitialDataInput() });
    const outcome = shape(run.outcome);
    expect(outcome.outcome).toBe("NOOP");
    expect(run.reads()).toBe(1);
    expect(outcome.targets).toEqual({
      event: "EXISTING",
      entry_ticket_offerings: "EXISTING",
      goods: "DEFERRED",
      karaoke_sales_configuration: "DEFERRED",
      karaoke_exclusive_scopes: "DEFERRED",
      karaoke_slots: "DEFERRED",
    });
    expect(await snapshotSeededTables(admin)).toEqual(before);
    expect(insertedTables(run.statements)).toEqual([]);
  });

  it("TC-TST-SEED-002-008 with deferred candidates, a missing or malformed input is FAILED, not NOOP", async () => {
    const eventId = await insertManualEvent();
    await insertManualOffering(eventId);
    const before = await snapshotSeededTables(admin);
    const missing = shape((await runSeed({ input: undefined })).outcome);
    expect(missing).toMatchObject({ outcome: "FAILED", errorCode: "INITIAL_DATA_INPUT_MISSING" });
    const { goods: _goods, ...withoutGoods } = buildInitialDataInput();
    const invalid = shape((await runSeed({ input: withoutGoods })).outcome);
    expect(invalid).toMatchObject({ outcome: "FAILED", errorCode: "INITIAL_DATA_INPUT_INVALID" });
    expect(await snapshotSeededTables(admin)).toEqual(before);
  });

  it("TC-TST-SEED-002-008 a later run with values creates what was deferred", async () => {
    await runSeed({ input: buildInitialDataInput() });
    const run = await runSeed({
      input: buildInitialDataInput({ goods: buildGoodsInput(), karaoke: null }),
    });
    expect(shape(run.outcome).outcome).toBe("CREATED");
    expect(shape(run.outcome).targets?.goods).toBe("CREATED");
    expect(shape(run.outcome).targets?.karaoke_sales_configuration).toBe("DEFERRED");
    expect(await counts()).toMatchObject({ goods: 1, inventory: 1, configs: 0 });
  });

  it("TC-TST-SEED-002-008 null never deletes: existing rows stay as they are (EXISTING)", async () => {
    await runSeed({ input: buildCompleteInitialDataInput() });
    const before = await snapshotSeededTables(admin);
    const run = await runSeed({ input: buildInitialDataInput() });
    expect(shape(run.outcome).outcome).toBe("NOOP");
    expect(shape(run.outcome).targets).toEqual(ALL_EXISTING);
    expect(await snapshotSeededTables(admin)).toEqual(before);
  });
});

describe("TC-TST-SEED-002-009 a non-unique Sales Configuration or a Scope without Slots fails the command (DB-SEED-001, DB-SEED-007)", () => {
  for (const karaoke of ["values", "null"] as const) {
    it(`TC-TST-SEED-002-009 two Sales Configurations (karaoke ${karaoke}): FAILED(CONSISTENCY_FAILURE), nothing written, input not read`, async () => {
      const eventId = await insertManualEvent();
      await insertManualConfig(eventId);
      await insertManualConfig(eventId);
      const before = await snapshotSeededTables(admin);
      const input =
        karaoke === "values" ? buildCompleteInitialDataInput() : buildInitialDataInput();
      const run = await runSeed({ input });
      expect(shape(run.outcome)).toMatchObject({
        outcome: "FAILED",
        failureClass: "CONSISTENCY_FAILURE",
        errorCode: "INITIAL_DATA_KARAOKE_SALES_CONFIGURATION_NOT_UNIQUE",
      });
      expect(run.reads()).toBe(0);
      expect(await snapshotSeededTables(admin)).toEqual(before);
    });

    it(`TC-TST-SEED-002-009 a Scope without Slots (karaoke ${karaoke}): FAILED(CONSISTENCY_FAILURE), no Slot is added, input not read`, async () => {
      const eventId = await insertManualEvent();
      const configId = await insertManualConfig(eventId);
      await insertManualSlot(await insertManualScope(eventId), configId);
      await insertManualScope(eventId);
      const before = await snapshotSeededTables(admin);
      const input =
        karaoke === "values" ? buildCompleteInitialDataInput() : buildInitialDataInput();
      const run = await runSeed({ input });
      expect(shape(run.outcome)).toMatchObject({
        outcome: "FAILED",
        failureClass: "CONSISTENCY_FAILURE",
        errorCode: "INITIAL_DATA_KARAOKE_SCOPE_WITHOUT_SLOTS",
      });
      expect(run.reads()).toBe(0);
      expect(await snapshotSeededTables(admin)).toEqual(before);
    });
  }
});

describe("TC-TST-SEED-002-010 with every target present, a re-run is NOOP and never reads the input (INF-SEED-004)", () => {
  it("TC-TST-SEED-002-010 a second complete run: NOOP, every target EXISTING, nothing changed", async () => {
    expect(shape((await runSeed({ input: buildCompleteInitialDataInput() })).outcome).outcome).toBe(
      "CREATED",
    );
    const before = await snapshotSeededTables(admin);
    const run = await runSeed({ input: "{not json" });
    expect(shape(run.outcome).outcome).toBe("NOOP");
    expect(shape(run.outcome).targets).toEqual(ALL_EXISTING);
    expect(run.reads()).toBe(0);
    expect(await snapshotSeededTables(admin)).toEqual(before);
  });

  it("TC-TST-SEED-002-010 a database seeded by other means with every target is NOOP too", async () => {
    await insertManualCompleteSet();
    const run = await runSeed({ input: undefined });
    expect(shape(run.outcome).outcome).toBe("NOOP");
    expect(run.reads()).toBe(0);
  });
});

describe("TC-TST-SEED-003-027 failures roll every target back (DB-SEED-002, DB-SEED-003, REL-DB-002)", () => {
  it("TC-TST-SEED-003-027 only the second Goods row invalid: FAILED, no row of any target, no Audit Event", async () => {
    const input = buildCompleteInitialDataInput({ goodsCount: 2 });
    ((input.goods as Record<string, unknown>[])[1] as Record<string, unknown>).purchase_limit = 0;
    const run = await runSeed({ input });
    expect(shape(run.outcome)).toMatchObject({
      outcome: "FAILED",
      errorCode: "INITIAL_DATA_INPUT_INVALID",
    });
    expect(await counts()).toEqual(EMPTY);
  });

  it("TC-TST-SEED-003-027 a Slot the DB refuses after every other row was inserted rolls all of them back, with no retry", async () => {
    // The last defence (DB-SEED-003): a constraint the command's validation does not know about, on
    // the last table the command writes.
    await admin.query(
      "ALTER TABLE app.karaoke_slots ADD CONSTRAINT ck_seed_probe_slot CHECK (generation_candidate_no < 5)",
    );
    let run: Awaited<ReturnType<typeof runSeed>>;
    try {
      run = await runSeed({ input: buildCompleteInitialDataInput() });
    } finally {
      await admin.query("ALTER TABLE app.karaoke_slots DROP CONSTRAINT ck_seed_probe_slot");
    }
    expect(shape(run.outcome)).toMatchObject({
      outcome: "FAILED",
      failureClass: "PERMANENT_FAILURE",
      errorCode: "INITIAL_DATA_CONSTRAINT_REJECTED",
    });
    expect(await counts()).toEqual(EMPTY);
    expect(insertedTables(run.statements).filter((t) => t === "app.events")).toHaveLength(1);
  });

  it("TC-TST-SEED-003-027 the 1,000 Slot upper bound commits within the default transaction wall clock (U-4)", async () => {
    const start = Date.parse("2030-05-10T00:00:00Z");
    const input = buildInitialDataInput({
      karaoke: buildKaraokeInput({
        scopeCount: 2,
        windows: [
          {
            window_start: new Date(start).toISOString(),
            window_end: new Date(start + 500 * 20 * MINUTE).toISOString(),
          },
        ],
      }),
    });
    const startedAt = performance.now();
    const run = await runSeed({ input });
    const elapsedMs = performance.now() - startedAt;
    expect(shape(run.outcome).outcome).toBe("CREATED");
    expect(await counts()).toMatchObject({ slots: 1000, scopes: 2 });
    expect((await audits()).filter((row) => row.target_type === "KARAOKE_SLOT")).toHaveLength(1000);
    // Informational: the run must fit in the 8 second transaction deadline (it did, or it would fail).
    expect(elapsedMs).toBeLessThan(60_000);
  });
});

describe("TC-TST-SEED-004-004 Audit Events for Goods and Karaoke (OBS-AUD-014, DB-SEED-005)", () => {
  it("TC-TST-SEED-004-004 one per created row (Inventory inside the Goods event), target types, after_state, field names only", async () => {
    const input = buildCompleteInitialDataInput({ scopeCount: 2 });
    const run = await runSeed({ input });
    const outcome = shape(run.outcome);
    const written = await audits();
    const byType = (type: string) => written.filter((row) => row.target_type === type);
    expect(byType("GOODS")).toHaveLength(1);
    expect(byType("KARAOKE_SALES_CONFIGURATION")).toHaveLength(1);
    expect(byType("KARAOKE_EXCLUSIVE_SCOPE")).toHaveLength(2);
    expect(byType("KARAOKE_SLOT")).toHaveLength(18);
    expect(written).toHaveLength(1 + 2 + 1 + 1 + 2 + 18);
    expect(sorted(written.map((row) => String(row.audit_event_id)))).toEqual(
      sorted(outcome.auditEventIds ?? []),
    );
    for (const row of written) {
      expect(row.audit_event_type).toBe("BUSINESS_EFFECT");
      expect(row.actor_type).toBe("INFRASTRUCTURE_OPERATOR");
      expect(row.operation_id).toBe("PROVISION.INITIAL_DATA_SEED");
      expect(row.operation_execution_id).toBe(outcome.operationExecutionId);
      expect(row.audit_result).toBe("COMMITTED");
      expect(row.precondition_result).toBe("PASSED");
    }
    expect(byType("GOODS").map((row) => row.target_ref)).toEqual(
      (await goods()).map((r) => r.public_ref),
    );
    expect(byType("GOODS")[0]?.after_state).toBe("SUSPENDED");
    expect(byType("GOODS")[0]?.changed_fields).toEqual(GOODS_FIELDS);
    expect(byType("KARAOKE_SALES_CONFIGURATION")[0]?.target_ref).toBe(
      (await configs())[0].public_ref,
    );
    expect(byType("KARAOKE_SALES_CONFIGURATION")[0]?.after_state).toBe("SUSPENDED");
    expect(byType("KARAOKE_SALES_CONFIGURATION")[0]?.changed_fields).toEqual(CONFIG_FIELDS);
    expect(
      refs(byType("KARAOKE_EXCLUSIVE_SCOPE").map((row) => ({ public_ref: row.target_ref }))),
    ).toEqual(refs(await scopes()));
    for (const row of byType("KARAOKE_EXCLUSIVE_SCOPE")) {
      expect(row.after_state).toBeNull();
      expect(row.changed_fields).toEqual(SCOPE_FIELDS);
    }
    expect(refs(byType("KARAOKE_SLOT").map((row) => ({ public_ref: row.target_ref })))).toEqual(
      refs(await slots()),
    );
    for (const row of byType("KARAOKE_SLOT")) {
      expect(row.after_state).toBe("AVAILABLE");
      expect(row.changed_fields).toEqual(SLOT_FIELDS);
    }
    // No value of the input in any Audit column (OBS-AUD-014).
    const text = JSON.stringify(written);
    for (const value of sensitiveValues(input)) expect(text).not.toContain(value);
    for (const row of written) expect(row.safe_change_summary).toEqual({});
  });

  it("TC-TST-SEED-004-004 deferred and existing targets add no Audit Event", async () => {
    await runSeed({ input: buildCompleteInitialDataInput() });
    const count = (await audits()).length;
    await runSeed({ input: buildInitialDataInput() });
    await runSeed({ input: buildCompleteInitialDataInput() });
    expect(await audits()).toHaveLength(count);
  });
});

describe("TC-TST-SEED-005-008 SQL range and privileges for the new targets (INF-SEED-003, SEC-DB-001)", () => {
  it("TC-TST-SEED-005-008 (a) CREATED, NOOP and FAILED issue only allowed statements; INSERTs go only to the target tables", async () => {
    const statements: string[] = [];
    await runSeed({ input: buildCompleteInitialDataInput(), statements });
    await runSeed({ input: buildCompleteInitialDataInput(), statements });
    await resetInitialData(admin);
    const bad = buildCompleteInitialDataInput();
    (bad.karaoke as NonNullable<InitialDataInput["karaoke"]>).slot_windows = [];
    await runSeed({ input: bad, statements });
    expect(disallowedStatements(statements)).toEqual([]);
    expect(sorted(new Set(insertedTables(statements)))).toEqual([
      "app.audit_events",
      "app.entry_ticket_offerings",
      "app.events",
      "app.goods",
      "app.goods_inventory",
      "app.karaoke_exclusive_scopes",
      "app.karaoke_sales_configurations",
      "app.karaoke_slots",
    ]);
  });

  it("TC-TST-SEED-005-008 (b) the runtime roles cannot INSERT into the new target tables (42501)", async () => {
    const eventId = await insertManualEvent();
    for (const role of ["app_api_runtime", "app_email_runtime", "app_reconciliation_runtime"]) {
      const client = await connectAs(role);
      try {
        for (const [table, sql] of [
          [
            "app.goods",
            `INSERT INTO app.goods (event_id, name, unit_amount, currency, sales_starts_at, sales_ends_at, sale_control_state, purchase_limit) VALUES (${eventId}, 'x', 0, 'JPY', now(), now() + interval '1 day', 'SUSPENDED', 1)`,
          ],
          [
            "app.karaoke_sales_configurations",
            `INSERT INTO app.karaoke_sales_configurations (event_id, name, unit_amount, currency, sales_starts_at, sales_ends_at, sale_control_state, purchase_limit) VALUES (${eventId}, 'x', 0, 'JPY', now(), now() + interval '1 day', 'SUSPENDED', 1)`,
          ],
          [
            "app.karaoke_exclusive_scopes",
            `INSERT INTO app.karaoke_exclusive_scopes (event_id, name) VALUES (${eventId}, 'x')`,
          ],
        ] as const) {
          await expect(client.query(sql), `${role} ${table}`).rejects.toMatchObject({
            code: "42501",
          });
        }
      } finally {
        await endQuietly(client);
      }
    }
  });
});

describe("TC-TST-SEED-006-024 COMMIT result unknown for a run that creates only Goods and Karaoke (DB-SEED-002)", () => {
  async function throughProxy(mode: "drop_ack" | "drop_request", logs: RecordedLog[] = []) {
    const proxy = await startCommitAcknowledgementDropProxy(new URL(url as string), { mode });
    try {
      const run = await runSeed({
        input: buildCompleteInitialDataInput(),
        openMain: () => connectAs("app_migrator", proxy.url),
        logs,
      });
      return { run, fired: proxy.fired() };
    } finally {
      await proxy.close();
    }
  }

  it("TC-TST-SEED-006-024 (1) committed: CREATED from this run's Audit Events, with every created ref and the planned states", async () => {
    const eventId = await insertManualEvent();
    await insertManualOffering(eventId);
    const { run, fired } = await throughProxy("drop_ack");
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("CREATED");
    expect(outcome.targets).toEqual({
      event: "EXISTING",
      entry_ticket_offerings: "EXISTING",
      goods: "CREATED",
      karaoke_sales_configuration: "CREATED",
      karaoke_exclusive_scopes: "CREATED",
      karaoke_slots: "CREATED",
    });
    expect(sorted(outcome.created?.goods ?? [])).toEqual(refs(await goods()));
    expect(outcome.created?.karaoke_sales_configurations).toEqual(refs(await configs()));
    expect(sorted(outcome.created?.karaoke_exclusive_scopes ?? [])).toEqual(refs(await scopes()));
    expect(sorted(outcome.created?.karaoke_slots ?? [])).toEqual(refs(await slots()));
    expect(await counts()).toMatchObject({ goods: 1, configs: 1, scopes: 1, slots: 9, audits: 12 });
  });

  it("TC-TST-SEED-006-024 (3) not committed: the existing Event and Offerings are no proof of success; the retry creates Goods and Karaoke once", async () => {
    const eventId = await insertManualEvent();
    await insertManualOffering(eventId);
    const before = await snapshotSeededTables(admin);
    const logs: RecordedLog[] = [];
    const { run, fired } = await throughProxy("drop_request", logs);
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("CREATED");
    expect(
      logs.some(
        (log) =>
          log.event_name === "reliability.unknown_result.resolved" && log.result === "FAILED",
      ),
    ).toBe(true);
    const after = await snapshotSeededTables(admin);
    expect(after.events).toEqual(before.events);
    expect(after.offerings).toEqual(before.offerings);
    expect(await counts()).toMatchObject({
      goods: 1,
      inventory: 1,
      configs: 1,
      scopes: 1,
      slots: 9,
    });
    expect(new Set((await slots()).map((row) => row.generation_cause_key))).toEqual(
      new Set([outcome.operationExecutionId]),
    );
  });
});

describe("TC-TST-SEED-006-025 the re-check of a Goods run needs the Goods and their Inventory (DB-SEED-002, DB-GDS-001)", () => {
  it("TC-TST-SEED-006-025 Goods without Inventory found by the re-check are not proof of success: uncommitted, then retried", async () => {
    // Every other target exists, so the run creates only the Goods.
    const eventId = await insertManualEvent();
    await insertManualOffering(eventId);
    const configId = await insertManualConfig(eventId);
    await insertManualSlot(await insertManualScope(eventId), configId);
    const logs: RecordedLog[] = [];
    let connects = 0;
    const proxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
      mode: "drop_request",
    });
    let run: Awaited<ReturnType<typeof runSeed>>;
    try {
      run = await runSeed({
        input: buildInitialDataInput({ goods: buildGoodsInput(), karaoke: buildKaraokeInput() }),
        openMain: () => connectAs("app_migrator", proxy.url),
        logs,
        connect: async (wrap) => {
          connects += 1;
          // Before the re-check reads, a Goods row appears without its Inventory (by other means).
          if (connects === 1)
            await admin.query(
              `INSERT INTO app.goods (event_id, name, unit_amount, currency, sales_starts_at, sales_ends_at,
                 sale_control_state, purchase_limit)
               VALUES ($1, '合成データ 在庫のないグッズ', 300, 'JPY', '2030-01-01T00:00:00Z',
                 '2030-02-01T00:00:00Z', 'SUSPENDED', 1)`,
              [eventId],
            );
          return wrap(await connectAs("app_migrator"));
        },
      });
    } finally {
      await proxy.close();
    }
    expect(proxy.fired()).toBe(1);
    const resolved = logs.filter((log) => log.event_name === "reliability.unknown_result.resolved");
    // Not complete: the planned rows are the Goods and their Inventory (DB-SEED-002 (3)).
    expect(resolved[0]).toMatchObject({ result: "FAILED", failure_class: "TEMPORARY_FAILURE" });
    expect(logs.some((log) => log.event_name === "reliability.retry.attempted")).toBe(true);
    // The retry finds the Goods present (DB-SEED-001: never topped up) and ends NOOP.
    expect(shape(run.outcome).outcome).toBe("NOOP");
    expect(await counts()).toMatchObject({ goods: 1, inventory: 0, audits: 0 });
  });
});
