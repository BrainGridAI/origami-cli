import type { Command } from "commander";

import type { EnrichmentRun, EnrichmentRunDetail } from "../api/types.js";
import { color } from "../output/color.js";
import { formatDateTime, printItem, printItems, printJson, type Column } from "../output/format.js";
import { ctxOf, fetchList, moreHint, parseIntOption } from "./helpers.js";

const runColumns: Column<EnrichmentRun>[] = [
  { header: "id", get: (r) => r.id },
  { header: "table", get: (r) => r.tableId },
  { header: "type", get: (r) => r.type },
  { header: "status", get: (r) => r.status },
  { header: "created", get: (r) => formatDateTime(r.createdAt) },
  { header: "completed", get: (r) => formatDateTime(r.completedAt) },
];

const detailColumns: Column<EnrichmentRunDetail>[] = [
  { header: "id", get: (r) => r.id },
  { header: "table", get: (r) => r.tableId },
  { header: "type", get: (r) => r.type },
  { header: "status", get: (r) => r.status },
  { header: "rows", get: (r) => r.rowCount },
  { header: "enriched", get: (r) => `${r.enrichments.completed}/${r.enrichments.total}` },
  { header: "pending", get: (r) => r.enrichments.pending },
  { header: "failed", get: (r) => r.enrichments.failed },
  { header: "credits", get: (r) => r.creditsUsed },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSettled(detail: EnrichmentRunDetail): boolean {
  return detail.enrichments.pending <= 0 || detail.completedAt != null;
}

export function registerEnrichmentsCommands(program: Command): void {
  const runs = program
    .command("enrichments")
    .aliases(["enrichment-runs", "batches"])
    .description("Enrichment runs — the tracked batches of column-over-row work");

  runs
    .command("list", { isDefault: true })
    .alias("ls")
    .description("List enrichment runs")
    .option("-t, --table <id>", "scope to one table")
    .option("-n, --limit <n>", "max runs to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      const fetchPage = opts.table
        ? (cursor: string | undefined) => ctx.client.listTableEnrichmentRuns(opts.table, { limit, cursor })
        : (cursor: string | undefined) => ctx.client.listEnrichmentRuns({ limit, cursor });
      const { items, nextCursor } = await fetchList(ctx.client, fetchPage, { all: opts.all, cursor: opts.cursor });
      printItems(items, runColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  runs
    .command("get <runId>")
    .description("Track an enrichment run (status, counts, credits, per-row outcomes)")
    .option("--wait", "poll until the run settles (all cells done)")
    .option("--interval <seconds>", "poll interval in seconds (with --wait; default 3)")
    .option("--timeout <seconds>", "max seconds to poll (with --wait; default 300)")
    .action(async (runId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();

      let detail = await ctx.client.getEnrichmentRun(runId);

      if (opts.wait && !isSettled(detail)) {
        const intervalMs = (parseIntOption(opts.interval, "interval") ?? 3) * 1000;
        const deadline = Date.now() + (parseIntOption(opts.timeout, "timeout") ?? 300) * 1000;
        while (!isSettled(detail) && Date.now() < deadline) {
          if (process.stderr.isTTY) {
            process.stderr.write(
              color.dim(`\r⏳ ${detail.status} · ${detail.enrichments.completed}/${detail.enrichments.total} enriched, ${detail.enrichments.pending} pending   `),
            );
          }
          await sleep(intervalMs);
          detail = await ctx.client.getEnrichmentRun(runId);
        }
        if (process.stderr.isTTY) process.stderr.write("\n");
      }

      if (ctx.format === "json") {
        printJson(detail);
        return;
      }
      printItem(detail as unknown as Record<string, unknown>, detailColumns as never, {
        format: ctx.format,
        fields: ctx.fields,
      });
    });
}
