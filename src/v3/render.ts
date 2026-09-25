import type { CliContext } from "../context.js";
import { color } from "../output/color.js";
import { printItem, printItems, printJson, printText, writeOut, type Column } from "../output/format.js";
import { isJob } from "./jobs.js";
import type { V3Job } from "./types.js";

/** Keys shown first when a list is rendered as a table, in this order, when present. */
const PRIORITY_KEYS = [
  "id",
  "sequence_id",
  "recipient",
  "name",
  "display_name",
  "full_name",
  "status",
  "channel",
  "channels",
  "email",
  "linkedin_slug",
  "operation",
  "people_count",
  "row_count",
  "created_at",
];
const MAX_TABLE_COLUMNS = 8;

function isScalar(value: unknown): boolean {
  return value == null || ["string", "number", "boolean"].includes(typeof value) || isScalarArray(value);
}

function isScalarArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => v == null || ["string", "number", "boolean"].includes(typeof v));
}

/**
 * Columns for a list: scalar keys in priority-then-first-seen order. Tables cap at
 * 8 columns (`--fields` picks others; `-o json` shows everything); CSV keeps them all.
 */
export function autoColumns(items: unknown[], cap: number | undefined): Column<Record<string, unknown>>[] {
  const seen: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (key === "object" || key === "url") continue;
      if (isScalar(value) && !seen.includes(key)) seen.push(key);
    }
  }
  const ordered = [...PRIORITY_KEYS.filter((k) => seen.includes(k)), ...seen.filter((k) => !PRIORITY_KEYS.includes(k))];
  const keys = cap == null ? ordered : ordered.slice(0, cap);
  return keys.map((key) => ({ header: key, get: (row) => row[key] }));
}

export function renderList(ctx: CliContext, items: unknown[]): void {
  if (ctx.format === "json") {
    printJson(items);
    return;
  }
  const records = items.map((i) => (i && typeof i === "object" ? (i as Record<string, unknown>) : { value: i }));
  // An explicit --fields may name any key, scalar or not.
  const columns = ctx.fields?.length
    ? ctx.fields.map((key) => ({ header: key, get: (row: Record<string, unknown>) => row[key] }))
    : autoColumns(records, ctx.format === "table" ? MAX_TABLE_COLUMNS : undefined);
  printItems(records, columns, { format: ctx.format, fields: undefined });
}

export function renderJob(ctx: CliContext, job: V3Job): void {
  if (ctx.format === "json") {
    printJson(job);
    return;
  }
  const badge =
    job.status === "succeeded"
      ? color.green(job.status)
      : job.status === "failed"
        ? color.red(job.status)
        : color.yellow(job.status);
  const meta = [job.operation, job.phase].filter(Boolean).join(" · ");
  writeOut(`${color.bold("Job")} ${job.id}  ${badge}${meta ? `  ${color.dim(`(${meta})`)}` : ""}`);
  if (job.result != null) {
    writeOut("");
    writeOut(color.bold("Result:"));
    writeOut(JSON.stringify(job.result, null, 2));
  }
  if (job.error) {
    writeOut("");
    writeOut(color.red(`${job.error.code ?? "ERROR"}: ${job.error.message ?? ""}`));
  }
  if (job.status === "needs_input") {
    writeOut("");
    writeOut(color.bold("Needs input:"));
    writeOut(JSON.stringify(job.needs_input, null, 2));
    writeOut(color.dim(`↳ Answer with: origami jobs input ${job.id} --answers "<answer>"`));
  } else if (job.status === "queued" || job.status === "running") {
    writeOut(color.dim(`↳ Follow it with: origami jobs wait ${job.id}`));
  }
}

/** Render any v3 response body: Job, list envelope, object, or raw text. */
export function renderResponse(ctx: CliContext, data: unknown, text?: string): void {
  if (text != null) {
    printText(text);
    return;
  }
  if (data === undefined) {
    if (ctx.format === "json") printJson({ ok: true });
    else writeOut(color.green("✓ done"));
    return;
  }
  if (isJob(data)) {
    renderJob(ctx, data);
    return;
  }
  if (data && typeof data === "object" && (data as Record<string, unknown>).object === "list") {
    renderList(ctx, ((data as Record<string, unknown>).items as unknown[]) ?? []);
    return;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const columns = ctx.fields?.length
      ? ctx.fields.map((key) => ({ header: key, get: (row: Record<string, unknown>) => row[key] }))
      : undefined;
    printItem(record, columns, { format: ctx.format, fields: undefined });
    return;
  }
  printJson(data);
}
