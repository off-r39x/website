import { countWindowCandidates, MAX_SLOTS_PER_RUN, type SlotWindow } from "./slots.ts";
import {
  EVENT_TARGET,
  GOODS_TARGET,
  type InitialDataTarget,
  type InputColumn,
  KARAOKE_SALES_CONFIGURATION_TARGET,
  KARAOKE_SCOPE_TARGET,
  OFFERING_TARGET,
} from "./targets.ts";

// Strict validation of the initial data input (SPEC-100 DB-SEED-003, SPEC-180 INF-SEED-002/005; the
// Goods and Karaoke part and the deferral null by UCR-180-007).
// The conditions equal the table CHECKs. Nothing is trimmed, upper-cased or defaulted (no guessed
// value). A rejection carries an error code only: never a key name, an index, a value or a parser
// message (INF-SEED-005, TST-UNT-003).

export type InputValue = string | number | null;
/** Every input column of one row, with NULL for an omitted or null nullable column. */
export type InputRow = Readonly<Record<string, InputValue>>;
export type KaraokeInitialData = {
  readonly sales_configuration: InputRow;
  readonly exclusive_scopes: readonly InputRow[];
  readonly slot_windows: readonly SlotWindow[];
};
export type InitialDataInput = {
  readonly event: InputRow;
  readonly entry_ticket_offerings: readonly InputRow[];
  /** `null`: the Goods are deferred (DB-SEED-001). */
  readonly goods: readonly InputRow[] | null;
  /** `null`: the Sales Configuration, the Scopes and their Slots are deferred together. */
  readonly karaoke: KaraokeInitialData | null;
};
export type ParseResult =
  | { readonly ok: true; readonly value: InitialDataInput }
  | { readonly ok: false; readonly errorCode: InputErrorCode };
export type InputErrorCode = "INITIAL_DATA_INPUT_MISSING" | "INITIAL_DATA_INPUT_INVALID";

const INVALID: ParseResult = Object.freeze({ ok: false, errorCode: "INITIAL_DATA_INPUT_INVALID" });
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const daysInMonth = (year: number, month: number): number =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

/** Epoch milliseconds, or null when the text is not an RFC 3339 timestamp with an offset. */
function timestampMillis(value: string): number | null {
  const match = TIMESTAMP.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && !/\p{Surrogate}/u.test(value) && !value.includes("\u0000");

function validValue(column: InputColumn, value: unknown): InputValue | undefined {
  switch (column.kind) {
    case "text":
      return isText(value) && (!column.nonEmpty || value.length > 0) ? value : undefined;
    case "timestamp":
      return typeof value === "string" && timestampMillis(value) !== null ? value : undefined;
    case "currency":
      return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined;
    case "integer":
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= column.min &&
        value <= column.max
        ? value
        : undefined;
  }
}

function parseRow(
  raw: unknown,
  columns: readonly InputColumn[],
  periods: readonly (readonly [string, string])[],
): InputRow | undefined {
  if (!isRecord(raw)) return undefined;
  const known = new Set(columns.map((column) => column.name));
  if (Object.keys(raw).some((key) => !known.has(key))) return undefined;
  const row: Record<string, InputValue> = {};
  for (const column of columns) {
    const present = Object.hasOwn(raw, column.name) && raw[column.name] !== null;
    if (!present) {
      if (column.required) return undefined;
      row[column.name] = null;
      continue;
    }
    const value = validValue(column, raw[column.name]);
    if (value === undefined) return undefined;
    row[column.name] = value;
  }
  for (const [earlier, later] of periods) {
    const from = row[earlier];
    const to = row[later];
    if (typeof from === "string" && typeof to === "string") {
      const fromMillis = timestampMillis(from);
      const toMillis = timestampMillis(to);
      if (fromMillis === null || toMillis === null || fromMillis >= toMillis) return undefined;
    }
  }
  return row;
}

/** Stands in for a number whose text is not the plain form of its value; no column accepts it. */
const NOT_AS_WRITTEN = Object.freeze({});

/**
 * JSON.parse rounds a number before any check sees it (1000.00000000000001 becomes 1000, -1e-400
 * becomes -0). The number is therefore checked in the form it was written: it is kept only when its
 * source text is exactly the plain decimal form of the parsed value, which for an integer column means
 * an integer literal without a fraction, an exponent or a negative zero. The source text comes from the
 * reviver context (Node 24); without it, every number is rejected (fail closed).
 */
function reviveNumber(_key: string, value: unknown, context?: { readonly source?: string }) {
  if (typeof value !== "number") return value;
  return context?.source !== undefined && context.source === String(value) ? value : NOT_AS_WRITTEN;
}

/**
 * Whether an object of the JSON text has the same key twice. JSON.parse keeps only the last value of a
 * duplicated key, so a forbidden key or an earlier value would be dropped before any check sees it; a
 * strict input names each key once. Keys are compared decoded (`"a"` and `"a"` are the same key).
 * Called only on text that JSON.parse accepted, so the scan needs no syntax checks: a string is skipped
 * as a whole (escapes included), and only a string that follows `{` or `,` inside an object is a key.
 */
function hasDuplicateKey(text: string): boolean {
  // One entry per open container: the keys seen so far for an object, null for an array.
  const open: (Set<string> | null)[] = [];
  let keyNext = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (keyNext) {
        const keys = open[open.length - 1];
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys?.has(key)) return true;
        keys?.add(key);
        keyNext = false;
      }
      i = end;
    } else if (char === "{") {
      open.push(new Set());
      keyNext = true;
    } else if (char === "[") {
      open.push(null);
      keyNext = false;
    } else if (char === "}" || char === "]") {
      open.pop();
      keyNext = false;
    } else if (char === ",") {
      keyNext = open[open.length - 1] instanceof Set;
    }
  }
  return false;
}

/** An object whose keys are exactly `keys` (no more, no fewer). */
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const parseTargetRow = (raw: unknown, target: InitialDataTarget) =>
  parseRow(raw, target.columns, target.periods);

/** A non-empty array of valid rows of `target`, or undefined. */
function parseRows(raw: unknown, target: InitialDataTarget): InputRow[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const rows: InputRow[] = [];
  for (const item of raw) {
    const row = parseTargetRow(item, target);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

/**
 * DB-SEED-003: the windows are objects with exactly `window_start` and `window_end`, timestamps with an
 * offset, each making at least one candidate, with no overlap between the candidates of different
 * windows (slots.ts), and at most MAX_SLOTS_PER_RUN Slots for all the Scopes of the run.
 */
function parseWindows(raw: unknown, scopeCount: number): SlotWindow[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  // Each window makes at least one candidate: more windows than the bound allows are refused unread.
  if (raw.length > Math.floor(MAX_SLOTS_PER_RUN / scopeCount)) return undefined;
  const windows: SlotWindow[] = [];
  const millis: { startMs: number; endMs: number }[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !hasExactKeys(item, ["window_start", "window_end"])) return undefined;
    const { window_start: start, window_end: end } = item;
    if (typeof start !== "string" || typeof end !== "string") return undefined;
    const startMs = timestampMillis(start);
    const endMs = timestampMillis(end);
    if (startMs === null || endMs === null) return undefined;
    windows.push({ window_start: start, window_end: end });
    millis.push({ startMs, endMs });
  }
  // The bound is checked before any candidate exists (slots.ts): per Scope, the run's share of it.
  const perScope = countWindowCandidates(millis, Math.floor(MAX_SLOTS_PER_RUN / scopeCount));
  if (perScope === undefined) return undefined;
  return windows;
}

const KARAOKE_KEYS = ["sales_configuration", "exclusive_scopes", "slot_windows"] as const;

function parseKaraoke(raw: unknown): KaraokeInitialData | undefined {
  if (!isRecord(raw) || !hasExactKeys(raw, KARAOKE_KEYS)) return undefined;
  const salesConfiguration = parseTargetRow(
    raw.sales_configuration,
    KARAOKE_SALES_CONFIGURATION_TARGET,
  );
  const scopes = parseRows(raw.exclusive_scopes, KARAOKE_SCOPE_TARGET);
  if (salesConfiguration === undefined || scopes === undefined) return undefined;
  const windows = parseWindows(raw.slot_windows, scopes.length);
  if (windows === undefined) return undefined;
  return {
    sales_configuration: salesConfiguration,
    exclusive_scopes: scopes,
    slot_windows: windows,
  };
}

const TOP_LEVEL_KEYS = ["event", "entry_ticket_offerings", "goods", "karaoke"] as const;

/**
 * Parses the raw `INITIAL_DATA_SEED_JSON` text. Never throws. The whole document is validated, the
 * parts that will not be used included (DB-SEED-003): the four top-level keys are always required,
 * and only `goods` and `karaoke` may be `null` (deferred).
 */
export function parseInitialDataInput(raw: string | undefined): ParseResult {
  if (raw === undefined || raw === "")
    return Object.freeze({ ok: false, errorCode: "INITIAL_DATA_INPUT_MISSING" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, reviveNumber as (key: string, value: unknown) => unknown);
  } catch {
    // The parser message quotes a fragment of the input; it is dropped on purpose.
    return INVALID;
  }
  if (hasDuplicateKey(raw)) return INVALID;
  if (!isRecord(parsed) || !hasExactKeys(parsed, TOP_LEVEL_KEYS)) return INVALID;

  const event = parseTargetRow(parsed.event, EVENT_TARGET);
  const offerings = parseRows(parsed.entry_ticket_offerings, OFFERING_TARGET);
  if (event === undefined || offerings === undefined) return INVALID;
  let goods: InputRow[] | null = null;
  if (parsed.goods !== null) {
    const rows = parseRows(parsed.goods, GOODS_TARGET);
    if (rows === undefined) return INVALID;
    goods = rows;
  }
  let karaoke: KaraokeInitialData | null = null;
  if (parsed.karaoke !== null) {
    const value = parseKaraoke(parsed.karaoke);
    if (value === undefined) return INVALID;
    karaoke = value;
  }
  return { ok: true, value: { event, entry_ticket_offerings: offerings, goods, karaoke } };
}
