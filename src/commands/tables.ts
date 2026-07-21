import { writeFileSync } from "node:fs";

import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import type {
  ListRowsParams,
  Table,
  UpsertRowsFileRequest,
  UpsertRowsRequest,
  WorkspaceColumn,
} from "../api/types.js";
import { color } from "../output/color.js";
import { formatDateTime, printItem, printItems, printJson, printText, type Column } from "../output/format.js";
import { parseFilter, parseRowJson, parseSort, splitList } from "../util/filters.js";
import { fileName, readFileBase64 } from "../util/fs.js";
import { ctxOf, emitAction, moreHint, parseIntOption, renderRows } from "./helpers.js";

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const tableColumns: Column<Table>[] = [
  { header: "id", get: (t) => t.id },
  { header: "name", get: (t) => t.name },
  { header: "leads", get: (t) => t.leadCount },
  { header: "columns", get: (t) => t.columns?.length ?? 0 },
  { header: "credits", get: (t) => t.credits?.lifetimeUsed ?? 0 },
  { header: "url", get: (t) => t.url },
];

const columnColumns: Column<WorkspaceColumn>[] = [
  { header: "id", get: (c) => c.id },
  { header: "name", get: (c) => c.name },
  { header: "kind", get: (c) => c.kind },
  { header: "slug", get: (c) => c.slug ?? "" },
  { header: "auto", get: (c) => (c.autoTrigger ? "yes" : "no") },
  { header: "credits", get: (c) => c.credits?.lifetimeUsed ?? 0 },
];

export function registerTablesCommands(program: Command): void {
  const tables = program
    .command("tables")
    .aliases(["table", "t"])
    .description("Tables, columns, and rows");

  tables
    .command("list", { isDefault: true })
    .alias("ls")
    .description("List tables")
    .option("-w, --workspace <id>", "scope to one workspace")
    .option("-n, --limit <n>", "max tables to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      if (opts.all) {
        const items = await ctx.client.collect((cursor) =>
          ctx.client.listTables({ workspaceId: opts.workspace, limit, cursor }),
        );
        printItems(items, tableColumns, { format: ctx.format, fields: ctx.fields });
        return;
      }
      const page = await ctx.client.listTables({ workspaceId: opts.workspace, limit, cursor: opts.cursor });
      printItems(page.items, tableColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, page.nextCursor, opts.all);
    });

  tables
    .command("get <tableId>")
    .description("Fetch a table (name, lead count, columns, credits)")
    .option("--include <list>", "opt-in projections: stats")
    .action(async (tableId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const include = opts.include ? (splitList(opts.include).filter((t) => t === "stats") as Array<"stats">) : undefined;
      const table = await ctx.client.getTable(tableId, include);
      if (ctx.format === "json") {
        printJson(table);
        return;
      }
      printItem(table as unknown as Record<string, unknown>, tableColumns as never, {
        format: ctx.format,
        fields: ctx.fields,
      });
    });

  tables
    .command("columns <tableId>")
    .description("List a table's columns")
    .action(async (tableId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const page = await ctx.client.listColumns(tableId);
      printItems(page.items, columnColumns, { format: ctx.format, fields: ctx.fields });
    });

  tables
    .command("rows <tableId>")
    .description("Read a table's rows (filter, sort, paginate, export CSV)")
    .option("--filter <expr>", 'filter as "<column> <operator> [value]" (repeatable)', collect, [])
    .option("--sort <col:dir>", 'sort by column, e.g. "revenue:desc"')
    .option("--flat", "return v1-style flat { slug: value } rows")
    .option("--no-defaults", "ignore the table's saved filters/sort")
    .option("-n, --limit <n>", "max rows per page (up to 200)")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .option("--out <file>", "write CSV to a file (implies CSV output)")
    .action(async (tableId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();

      const filters = (opts.filter as string[]).map(parseFilter);
      const sort = opts.sort ? parseSort(opts.sort) : undefined;
      const limit = parseIntOption(opts.limit, "limit");
      if (limit != null && limit > 200) {
        throw new OrigamiConfigError("--limit for rows must be 200 or less.");
      }
      const params: ListRowsParams = {
        ...(filters.length ? { filters } : {}),
        ...(sort ? { sort } : {}),
        ...(opts.flat ? { flat: true } : {}),
        ...(opts.defaults === false ? { defaults: false } : {}),
        ...(limit != null ? { limit } : {}),
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      };

      const wantCsv = ctx.format === "csv" || Boolean(opts.out);
      if (wantCsv) {
        const csv = await ctx.client.getRowsCsv(tableId, params);
        if (opts.out) {
          writeFileSync(opts.out, csv);
          process.stderr.write(color.green(`✓ wrote ${csv.length} bytes to ${opts.out}\n`));
        } else {
          printText(csv);
        }
        return;
      }

      if (opts.all) {
        const items = await ctx.client.collect((cursor) => ctx.client.listRows(tableId, { ...params, cursor }));
        renderRows(ctx, items);
        return;
      }
      const page = await ctx.client.listRows(tableId, params);
      renderRows(ctx, page.items);
      if (page.total != null && ctx.format !== "json") {
        process.stderr.write(color.dim(`  ${page.items.length} shown of ${page.total} total\n`));
      }
      moreHint(ctx, page.nextCursor, opts.all);
    });

  tables
    .command("row <tableId> <rowId>")
    .description("Fetch a single row")
    .action(async (tableId: string, rowId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const row = await ctx.client.getRow(tableId, rowId);
      if (ctx.format === "json") printJson(row);
      else renderRows(ctx, [row]);
    });

  tables
    .command("cell <tableId> <rowId> <columnId>")
    .description("Fetch a single cell (with run metadata)")
    .action(async (tableId: string, rowId: string, columnId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const cell = await ctx.client.getCell(tableId, rowId, columnId);
      printJson(cell);
    });

  tables
    .command("upsert <tableId>")
    .description("Upsert rows on matchColumns (insert new, update matches)")
    .requiredOption("--match <slugs>", "comma-separated input-column slugs to match on")
    .option("--row <json>", "a row as a JSON object of { slug: value } (repeatable)", collect, [])
    .option("--file <csv>", "upsert from a CSV file (headers are column slugs)")
    .option("--no-enrich", "do not enrich freshly inserted rows")
    .option("--reenrich-updated", "also re-run enrichment on updated rows (re-spends credits)")
    .option("--batch-id <uuid>", "idempotency batch id (dedups retries)")
    .action(async (tableId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const matchColumns = splitList(opts.match);
      if (matchColumns.length === 0) throw new OrigamiConfigError("--match requires at least one column slug.");

      const rowInputs = opts.row as string[];
      if (opts.file && rowInputs.length > 0) {
        throw new OrigamiConfigError("Use either --row or --file, not both.");
      }

      let receipt;
      if (opts.file) {
        const request: UpsertRowsFileRequest = {
          content: readFileBase64(opts.file),
          filename: fileName(opts.file),
          matchColumns,
          enrich: opts.enrich !== false,
          reenrichUpdated: Boolean(opts.reenrichUpdated),
          ...(opts.batchId ? { batchId: opts.batchId } : {}),
        };
        receipt = await ctx.client.upsertRowsFromFile(tableId, request);
      } else {
        if (rowInputs.length === 0) {
          throw new OrigamiConfigError("Provide rows with --row '<json>' (repeatable) or a CSV with --file.");
        }
        const request: UpsertRowsRequest = {
          rows: rowInputs.map(parseRowJson),
          matchColumns,
          enrich: opts.enrich !== false,
          reenrichUpdated: Boolean(opts.reenrichUpdated),
          ...(opts.batchId ? { batchId: opts.batchId } : {}),
        };
        receipt = await ctx.client.upsertRows(tableId, request);
      }

      emitAction(
        ctx,
        receipt,
        `upserted → enrichment run ${receipt.id} ` +
          `(inserted ${receipt.counts.inserted}, updated ${receipt.counts.updated}, skipped ${receipt.counts.skipped}). ` +
          `Poll: origami enrichments get ${receipt.id}`,
      );
    });
}
