import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import type { SequenceStep, SequenceSummary } from "../api/types.js";
import { color } from "../output/color.js";
import { formatDateTime, printItems, printJson, truncate, writeOut, type Column } from "../output/format.js";
import { ctxOf, emitAction, fetchList, moreHint, parseIntOption } from "./helpers.js";

const sequenceColumns: Column<SequenceSummary>[] = [
  { header: "id", get: (s) => s.id },
  { header: "campaign", get: (s) => s.campaignId ?? "" },
  { header: "status", get: (s) => s.status },
  { header: "send_status", get: (s) => s.sendStatus ?? "" },
  { header: "table", get: (s) => s.tableId ?? "" },
];

export function registerSequencesCommands(program: Command): void {
  const sequences = program
    .command("sequences")
    .aliases(["sequence", "seq"])
    .description("Per-recipient outreach threads, v2 (prefer `origami send campaigns people`)");

  sequences
    .command("list")
    .alias("ls")
    .description("List sequences (scope by workspace, table, or column)")
    .option("-w, --workspace <id>", "scope to a workspace")
    .option("-t, --table <id>", "scope to a table")
    .option("--column <id>", "scope to an outreach column")
    .option("--status <status>", "filter by status")
    .option("--channel <channel>", "filter by channel (email | linkedin)")
    .option("--recipient <recipient>", "filter by recipient")
    .option("-n, --limit <n>", "max sequences to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      if (!opts.workspace && !opts.table && !opts.column) {
        throw new OrigamiConfigError("Provide one of --workspace, --table, or --column.");
      }
      const limit = parseIntOption(opts.limit, "limit");
      const fetchPage = opts.table && !opts.workspace && !opts.column
        ? (cursor: string | undefined) =>
            ctx.client.listTableSequences(opts.table, {
              status: opts.status,
              channel: opts.channel,
              recipient: opts.recipient,
              limit,
              cursor,
            })
        : (cursor: string | undefined) =>
            ctx.client.listSequences({
              workspaceId: opts.workspace,
              tableId: opts.table,
              columnId: opts.column,
              status: opts.status,
              channel: opts.channel,
              recipient: opts.recipient,
              limit,
              cursor,
            });
      const { items, nextCursor } = await fetchList(ctx.client, fetchPage, { all: opts.all, cursor: opts.cursor });
      printItems(items, sequenceColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  sequences
    .command("get <sequenceId>")
    .description("Fetch a sequence with its steps inline")
    .action(async (sequenceId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const seq = await ctx.client.getSequence(sequenceId);
      if (ctx.format === "json") {
        printJson(seq);
        return;
      }
      writeOut(`${color.bold("Sequence")} ${seq.id}  ${seq.status}  ${color.dim(seq.sendStatus ?? "")}`);
      writeOut("");
      for (const step of seq.steps ?? []) writeOut(renderStep(step));
    });

  sequences
    .command("stop <sequenceId>")
    .description("Stop a sequence (sent history preserved)")
    .option("--dry-run", "report what would happen without stopping")
    .action(async (sequenceId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.stopSequence(sequenceId, Boolean(opts.dryRun));
      emitAction(ctx, res, opts.dryRun ? `dry-run: would stop sequence ${sequenceId}` : `stopped sequence ${sequenceId}`);
    });

  sequences
    .command("delete <sequenceId>")
    .aliases(["rm"])
    .description("Delete a sequence (guarded if it has sent messages; use --force)")
    .option("--force", "also delete sequences with already-sent messages")
    .option("--dry-run", "report the would-be effect without deleting")
    .action(async (sequenceId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.deleteSequence(sequenceId, {
        force: Boolean(opts.force),
        dryRun: Boolean(opts.dryRun),
      });
      emitAction(ctx, res, opts.dryRun ? `dry-run: would delete sequence ${sequenceId}` : `deleted sequence ${sequenceId}`);
    });
}

function renderStep(step: SequenceStep): string {
  const when = step.sentAt
    ? `sent ${formatDateTime(step.sentAt)}`
    : step.scheduledAt
      ? `scheduled ${formatDateTime(step.scheduledAt)}`
      : "";
  const head = `  ${color.cyan(step.channel)} · ${step.kind} · ${step.status}  ${color.dim(when)}`;
  const subject = step.subject ? `\n    ${color.bold(step.subject)}` : "";
  const body = step.body ? `\n    ${truncate(step.body, 120)}` : "";
  return `${head}${subject}${body}`;
}
