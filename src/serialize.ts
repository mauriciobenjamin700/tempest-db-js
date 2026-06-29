/**
 * tempest-db-js — row (de)serialization, à la Python's `model_dump` / `model_validate`.
 *
 * Rows in tempest-db-js are plain inferred objects. This module converts between three
 * representations, coercing each field by its column type:
 *
 *   - **Row** — native JS values (`Date`, `bigint`, `Uint8Array`, parsed JSON).
 *   - **Dict** — a plain object of native values, restricted to known columns.
 *   - **JSON** — a JSON-safe object (`Date` → ISO string, `bigint` → string,
 *     `Uint8Array` → base64), ready for `JSON.stringify`.
 *
 * `fromDict` rebuilds a validated Row from arbitrary input (e.g. an API payload),
 * coercing strings back to `Date`/`bigint`/`Uint8Array` and validating that
 * required columns are present.
 */

import { type Column, type InferModel, type ModelClass, columnsOf } from "./index.js";

/** Raised when `fromDict` input fails validation against the model. */
export class ValidationError extends Error {
  constructor(
    readonly table: string,
    readonly issues: readonly string[],
  ) {
    super(`Validation failed for ${table}:\n  - ${issues.join("\n  - ")}`);
    this.name = "ValidationError";
  }
}

/** Base64-encode bytes (Node `Buffer`, falling back to a manual encoder). */
function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64-decode to bytes. */
function fromBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode one native row value to its JSON-safe form, by column kind. */
function encodeValue(column: Column<unknown>, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (column.type.kind) {
    case "bigint":
      return typeof value === "bigint" ? value.toString() : value;
    case "date":
    case "datetime":
    case "timestamp":
      return value instanceof Date ? value.toISOString() : value;
    case "blob":
      return value instanceof Uint8Array ? toBase64(value) : value;
    default:
      return value;
  }
}

/** Decode one dict value to its native row form, by column kind. */
function decodeValue(column: Column<unknown>, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (column.type.kind) {
    case "bigint":
      return typeof value === "bigint" ? value : BigInt(value as string | number);
    case "date":
    case "datetime":
    case "timestamp":
      return value instanceof Date ? value : new Date(value as string | number);
    case "blob":
      return value instanceof Uint8Array ? value : fromBase64(value as string);
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "numeric":
      return typeof value === "string" ? value : String(value);
    case "boolean":
      return typeof value === "boolean" ? value : value === 1 || value === "true";
    case "smallint":
    case "integer":
    case "real":
    case "double":
      return typeof value === "number" ? value : Number(value);
    default:
      return value; // varchar/text/char/uuid/enum/time → string passthrough
  }
}

/**
 * Convert a row to a plain dict of native values, restricted to known columns.
 * Strips any non-column properties; keeps `Date`/`bigint`/`Uint8Array` as-is.
 *
 * @param model The model class.
 * @param row The row object.
 * @returns A plain object with one entry per column.
 */
export function toDict<C extends ModelClass>(
  model: C,
  row: InferModel<C>,
): Record<string, unknown> {
  const columns = columnsOf(model);
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(columns)) {
    out[name] = (row as Record<string, unknown>)[name] ?? null;
  }
  return out;
}

/**
 * Convert a row to a JSON-safe object: `Date` → ISO string, `bigint` → string,
 * `Uint8Array` → base64. Ready to hand to `JSON.stringify`.
 *
 * @param model The model class.
 * @param row The row object.
 * @returns A JSON-safe object with one entry per column.
 */
export function toJSON<C extends ModelClass>(
  model: C,
  row: InferModel<C>,
): Record<string, unknown> {
  const columns = columnsOf(model);
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(columns)) {
    out[name] = encodeValue(col, (row as Record<string, unknown>)[name] ?? null);
  }
  return out;
}

/** Convenience: `toJSON` then `JSON.stringify`. */
export function stringify<C extends ModelClass>(model: C, row: InferModel<C>): string {
  return JSON.stringify(toJSON(model, row));
}

/**
 * Build a validated row from an arbitrary dict/JSON object (e.g. an API body).
 *
 * Each known column is coerced from the input to its native type (strings back
 * to `Date`/`bigint`/`Uint8Array`, JSON strings parsed). A column that is
 * `notNull`, has no default, and is missing/null in the input is a validation
 * error. Unknown keys in the input are ignored.
 *
 * @param model The model class.
 * @param data The input object (parsed JSON or a plain dict).
 * @returns A typed row.
 * @throws ValidationError When a required column is absent.
 */
export function fromDict<C extends ModelClass>(
  model: C,
  data: Record<string, unknown>,
): InferModel<C> {
  const columns = columnsOf(model);
  const out: Record<string, unknown> = {};
  const issues: string[] = [];

  for (const [name, col] of Object.entries(columns)) {
    const present = name in data && data[name] !== undefined && data[name] !== null;
    if (!present) {
      const required = col.flags.notNull && !col.flags.hasDefault;
      if (required) {
        issues.push(`missing required column "${name}"`);
        continue;
      }
      out[name] = null;
      continue;
    }
    try {
      out[name] = decodeValue(col, data[name]);
    } catch (error) {
      issues.push(`column "${name}": ${(error as Error).message}`);
    }
  }

  if (issues.length > 0) {
    throw new ValidationError(model.tablename, issues);
  }
  return out as InferModel<C>;
}

/** Parse a JSON string then build a validated row. */
export function parse<C extends ModelClass>(model: C, json: string): InferModel<C> {
  return fromDict(model, JSON.parse(json) as Record<string, unknown>);
}

/**
 * Coerce a raw driver row into native row values, by column type. Unlike
 * `fromDict`, it does NOT validate required columns — a row read from the
 * database (or a projection) is taken as-is, only its values are normalized
 * (e.g. `0/1` → boolean, ISO string → `Date`, JSON string → object). Keys that
 * are not columns of the model pass through untouched.
 *
 * @param model The model class.
 * @param raw The raw row returned by the driver.
 * @returns The row with native-typed values.
 */
export function coerceRow<C extends ModelClass>(
  model: C,
  raw: Record<string, unknown>,
): InferModel<C> {
  const columns = columnsOf(model);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    const col = columns[name];
    out[name] = col ? decodeValue(col, value) : value;
  }
  return out as InferModel<C>;
}
