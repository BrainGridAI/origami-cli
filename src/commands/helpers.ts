import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import type { OrigamiClient } from "../api/client.js";
import type { ListEnvelope, Run, Table } from "../api/types.js";
import { createContext, type CliContext, type GlobalOptions } from "../context.js";
import { color } from "../output/color.js";
import { formatDateTime, printItems, printJson, printSuccess, truncate, writeOut, type Column } from "../output/format.js";

export function ctxOf(command: Command): CliContext {
  return createContext(command.optsWithGlobals() as GlobalOptions);
}

/**
 * Emit the result of a mutating action: raw JSON in json mode, otherwise a
 * friendly success line.
 */
export function emitAction(ctx: CliContext, data: unknown, message: string): void {
  if (ctx.format === "json") {
    printJson(data);
  } else {
    printSuccess(message);
  }
}

/** Parse a numeric option, throwing a config error on garbage. */
export function parseIntOption(value: string | undefined, label: string): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new OrigamiConfigError(`--${label} must be a positive number (got "${value}").`);
  }
  return Math.floor(n);
}

type FetchPage<T> = (cursor: string | undefined) => Promise<ListEnvelope<T>>;

export interface ListArgs {
  all?: boolean | undefined;
  cursor?: string | undefined;
}

/**
 * Fetch a list either as a single page (default; the server honors `--limit`)
 * or fully drained across cursors (`--all`).
 */
export async function fetchList<T>(
  client: OrigamiClient,
  fetchPage: FetchPage<T>,
  args: ListArgs,
): Promise<{ items: T[]; nextCursor: string | null; total?: number }> {
  if (args.all) {
    const items = await client.collect(fetchPage, undefined, args.cursor);
    return { items, nextCursor: null };
  }
  const page = await fetchPage(args.cursor);
  return { items: page.items, nextCursor: page.nextCursor, total: page.total };
}

/** Print a "more results available" hint to stderr (never stdout, so JSON stays clean). */
export function moreHint(ctx: CliContext, nextCursor: string | null, all: boolean | undefined): void {
  if (all || !nextCursor || ctx.format === "json") return;
  process.stderr.write(
    color.dim(`… more results available. Re-run with --all, or --cursor ${truncate(nextCursor, 24)}\n`),
  );
}

// ---------------------------------------------------------------------------
// Run rendering (shared by `run`, `agents ask`, `agents run-get`)
// ---------------------------------------------------------------------------

export const tableSummaryColumns: Column<Table>[] = [
  { header: "id", get: (t) => t.id },
  { header: "name", get: (t) => t.name },
  { header: "leads", get: (t) => t.leadCount },
  { header: "url", get: (t) => t.url },
];

const TERMINAL_HINT: Record<string, string> = {
  needs_input: "The agent needs input. Answer with: origami agents ask <agentId> \"<answer>\"",
  incomplete: "Recoverable — continue with: origami agents ask <agentId> \"<continue>\"",
  step_cap_hit: "Hit the plan step cap. Continue with a follow-up run, or upgrade for a higher cap.",
  timed_out: "Timed out. Send a follow-up run to continue.",
  errored: "The run errored. Retry, or contact support.",
  cancelled: "Run cancelled. Whatever the agent built so far is kept.",
};

/** Render a terminal (or in-progress) run for human consumption. In json mode, dumps the run. */
export function renderRun(ctx: CliContext, run: Run): void {
  if (ctx.format === "json") {
    printJson(run);
    return;
  }

  const status = run.status;
  const badge = status === "completed" ? color.green(status) : color.yellow(status);
  const steps = run.steps ? `${run.steps.completed}/${run.steps.max} steps` : "";
  const meta = [steps, run.model].filter(Boolean).join(", ");
  writeOut(`${color.bold("Run")} ${run.id}  ${badge}${meta ? `  ${color.dim(`(${meta})`)}` : ""}`);

  const resp = run.response;
  if (resp?.text) {
    writeOut("");
    writeOut(resp.text);
  }

  const tables = resp?.tables ?? [];
  if (tables.length > 0) {
    writeOut("");
    writeOut(color.bold(`Tables (${tables.length}):`));
    printItems(tables, tableSummaryColumns, { format: "table", fields: ctx.fields });
  }

  const questions = run.todo?.pendingQuestions ?? [];
  if (questions.length > 0) {
    writeOut("");
    writeOut(color.bold("Questions:"));
    for (const q of questions) {
      writeOut(`  ${color.yellow("?")} ${q.question}`);
      if (q.suggestedAnswers.length > 0) {
        writeOut(color.dim(`    options: ${q.suggestedAnswers.join(" | ")}`));
      }
    }
  }

  const hint = TERMINAL_HINT[status];
  if (hint) {
    writeOut("");
    writeOut(color.dim(`↳ ${hint.replace("<agentId>", run.agentId)}`));
  }
}

/** Extract a display value from a typed cell (`{ type, value }`) or return the raw value. */
function extractCellValue(cell: unknown): unknown {
  if (cell && typeof cell === "object" && "value" in (cell as Record<string, unknown>)) {
    return (cell as Record<string, unknown>).value;
  }
  return cell;
}

/** Normalize a Row (typed or flat) into a flat record of column → value. */
function toFlatRecord(item: unknown): Record<string, unknown> {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    const cells = obj.cells;
    if (cells && typeof cells === "object") {
      const out: Record<string, unknown> = { id: obj.id };
      for (const [k, v] of Object.entries(cells as Record<string, unknown>)) out[k] = extractCellValue(v);
      return out;
    }
    return obj;
  }
  return { value: item };
}

/** Render table rows (typed or flat) as JSON / a table / CSV. */
export function renderRows(ctx: CliContext, items: unknown[]): void {
  const records = items.map(toFlatRecord);
  if (ctx.format === "json") {
    printJson(records);
    return;
  }
  if (records.length === 0) {
    writeOut(color.dim("(no rows)"));
    return;
  }
  const keys: string[] = [];
  for (const r of records) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const cols: Column<Record<string, unknown>>[] = keys.map((k) => ({ header: k, get: (r) => r[k] }));
  printItems(records, cols, { format: ctx.format, fields: ctx.fields });
}

/** onPoll callback that writes a throttled progress line to stderr (TTY only). */
export function pollReporter(): (run: Run) => void {
  let last = 0;
  return (run: Run) => {
    if (!process.stderr.isTTY) return;
    const now = Date.now();
    if (run.status === "running" && now - last < 500) return;
    last = now;
    const line = `⏳ ${run.status} · ${run.steps.completed}/${run.steps.max} steps`;
    process.stderr.write(`\r${" ".repeat(60)}\r${color.dim(line)}`);
    if (run.status !== "running") process.stderr.write("\n");
  };
}

export { formatDateTime };
