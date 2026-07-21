import { OrigamiConfigError } from "../api/errors.js";
import { color } from "./color.js";
import { renderTable } from "./table.js";

export type OutputFormat = "json" | "table" | "csv";

const FORMATS: readonly OutputFormat[] = ["json", "table", "csv"];

export function defaultFormat(): OutputFormat {
  return process.stdout.isTTY ? "table" : "json";
}

export function parseFormat(value: string | undefined): OutputFormat {
  if (!value) return defaultFormat();
  const normalized = value.toLowerCase();
  if (!FORMATS.includes(normalized as OutputFormat)) {
    throw new OrigamiConfigError(`Unknown output format "${value}". Expected one of: ${FORMATS.join(", ")}.`);
  }
  return normalized as OutputFormat;
}

export interface Column<T> {
  header: string;
  get: (row: T) => unknown;
}

export interface RenderOptions {
  format: OutputFormat;
  fields?: string[] | undefined;
  maxColWidth?: number | undefined;
}

export function writeOut(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function printJson(data: unknown): void {
  writeOut(JSON.stringify(data, null, 2));
}

/** Print raw text as-is (used for CSV exports and other text bodies). */
export function printText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

function selectColumns<T>(columns: Column<T>[], fields?: string[]): Column<T>[] {
  if (!fields || fields.length === 0) return columns;
  const wanted = fields.map((f) => f.trim().toLowerCase()).filter(Boolean);
  const selected: Column<T>[] = [];
  for (const field of wanted) {
    const match = columns.find((c) => c.header.toLowerCase() === field);
    if (match) selected.push(match);
  }
  return selected.length > 0 ? selected : columns;
}

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cellToString).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Print a list of items in the chosen format. */
export function printItems<T>(items: T[], columns: Column<T>[], options: RenderOptions): void {
  if (options.format === "json") {
    printJson(items);
    return;
  }

  const cols = selectColumns(columns, options.fields);
  const headers = cols.map((c) => c.header);
  const rows = items.map((item) => cols.map((c) => cellToString(c.get(item))));

  if (options.format === "csv") {
    const lines = [headers.map(csvEscape).join(",")];
    for (const row of rows) lines.push(row.map(csvEscape).join(","));
    writeOut(lines.join("\n"));
    return;
  }

  // table
  if (items.length === 0) {
    writeOut(color.dim("(no results)"));
    return;
  }
  writeOut(renderTable(headers, rows, { maxColWidth: options.maxColWidth ?? 60 }));
}

/**
 * Print a single object. For `table` output this renders a two-column
 * field/value view using the provided columns (or all own keys).
 */
export function printItem<T extends Record<string, unknown>>(
  item: T,
  columns: Column<T>[] | undefined,
  options: RenderOptions,
): void {
  if (options.format === "json") {
    printJson(item);
    return;
  }

  const rows: string[][] = columns
    ? columns.map((c) => [c.header, cellToString(c.get(item))])
    : Object.entries(item).map(([key, value]) => [key, cellToString(value)]);

  if (options.format === "csv") {
    const headers = rows.map((r) => r[0] ?? "");
    const values = rows.map((r) => r[1] ?? "");
    writeOut([headers.map(csvEscape).join(","), values.map(csvEscape).join(",")].join("\n"));
    return;
  }

  // table: field / value pairs
  const labelWidth = Math.max(0, ...rows.map((r) => (r[0] ?? "").length));
  const lines = rows.map(([label, value]) => `${color.bold((label ?? "").padEnd(labelWidth))}  ${value ?? ""}`);
  writeOut(lines.join("\n"));
}

/** Print a short success/status line (suppressed in json mode where callers print JSON). */
export function printSuccess(message: string): void {
  writeOut(`${color.green("✓")} ${message}`);
}

// ---------------------------------------------------------------------------
// Value formatters for columns
// ---------------------------------------------------------------------------

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** Truncate a long string for a table cell. */
export function truncate(value: string | null | undefined, max = 60): string {
  if (!value) return "";
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
