import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import type { CampaignAgenticResponse, CampaignPerson, CampaignSummary } from "../api/types.js";
import type { CliContext } from "../context.js";
import { color } from "../output/color.js";
import { formatDateTime, printItems, printItem, printJson, truncate, writeOut, type Column } from "../output/format.js";
import { ctxOf, emitAction, fetchList, moreHint, parseIntOption, pollReporter, renderRun } from "./helpers.js";

const campaignColumns: Column<CampaignSummary>[] = [
  { header: "id", get: (c) => c.id ?? "" },
  { header: "name", get: (c) => truncate(c.name, 40) },
  { header: "status", get: (c) => c.status },
  { header: "people", get: (c) => c.peopleCount },
  { header: "slug", get: (c) => c.slug ?? "" },
];

const peopleColumns: Column<CampaignPerson>[] = [
  { header: "sequence", get: (p) => p.sequenceId },
  { header: "recipient", get: (p) => p.recipient ?? "" },
  { header: "send_status", get: (p) => p.sendStatus },
  { header: "fit", get: (p) => (p.fitScore == null ? "" : p.fitScore) },
  { header: "added", get: (p) => formatDateTime(p.addedAt) },
];

/** Poll an agentic campaign create/edit response to completion (unless --no-wait). */
async function resolveAgentic(
  ctx: CliContext,
  res: CampaignAgenticResponse,
  wait: boolean,
  verb: string,
): Promise<void> {
  if (!wait) {
    if (ctx.format === "json") printJson(res);
    else {
      writeOut(`${color.green("✓")} ${verb} run ${res.run.id} started on agent ${res.agent.id} (${res.run.status})`);
      writeOut(color.dim(`  poll with: origami agents run-get ${res.agent.id} ${res.run.id} --wait`));
    }
    return;
  }
  const run = await ctx.client.waitForRun(res.agent.id, res.run.id, { onPoll: pollReporter() });
  renderRun(ctx, run);
}

export function registerCampaignsCommands(program: Command): void {
  const campaigns = program
    .command("campaigns")
    .aliases(["campaign", "c"])
    .description("Outreach campaigns, v2 agentic surface (prefer `origami send campaigns`)");

  campaigns
    .command("list")
    .alias("ls")
    .description("List campaigns (by workspace or table)")
    .option("-w, --workspace <id>", "list a workspace's campaigns")
    .option("-t, --table <id>", "list campaigns that send from a table")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      if (!opts.workspace && !opts.table) {
        throw new OrigamiConfigError("Provide --workspace <id> or --table <id>.");
      }
      const page = opts.workspace
        ? await ctx.client.listWorkspaceCampaigns(opts.workspace)
        : await ctx.client.listTableCampaigns(opts.table);
      printItems(page.items, campaignColumns, { format: ctx.format, fields: ctx.fields });
    });

  campaigns
    .command("create <tableId> <instructions...>")
    .description("Create a campaign on a table (agentic — drafts sequences, does not send)")
    .option("--no-wait", "return immediately without polling the drafting run")
    .action(async (tableId: string, instructions: string[], opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const text = instructions.join(" ").trim();
      if (!text) throw new OrigamiConfigError("Campaign instructions are required.");
      const res = await ctx.client.createCampaign(tableId, text);
      await resolveAgentic(ctx, res, opts.wait !== false, "campaign create");
    });

  campaigns
    .command("edit <campaignId> <instructions...>")
    .description("Request a content change to a campaign (agentic)")
    .option("--no-wait", "return immediately without polling the run")
    .action(async (campaignId: string, instructions: string[], opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const text = instructions.join(" ").trim();
      if (!text) throw new OrigamiConfigError("Edit instructions are required.");
      const res = await ctx.client.editCampaign(campaignId, text);
      await resolveAgentic(ctx, res, opts.wait !== false, "campaign edit");
    });

  campaigns
    .command("get <campaignId>")
    .description("Fetch a campaign")
    .action(async (campaignId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const campaign = await ctx.client.getCampaign(campaignId);
      printJson(campaign);
    });

  campaigns
    .command("stats <campaignId>")
    .description("Campaign performance stats")
    .action(async (campaignId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const stats = await ctx.client.getCampaignStats(campaignId);
      if (ctx.format === "json") printJson(stats);
      else printItem(stats as unknown as Record<string, unknown>, undefined, { format: ctx.format, fields: ctx.fields });
    });

  campaigns
    .command("people <campaignId>")
    .aliases(["sequences"])
    .description("List the people enrolled in a campaign")
    .option("--search <text>", "substring match over recipient / identity")
    .option("--status <list>", "CSV of send-status buckets to include")
    .option("-n, --limit <n>", "max people to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (campaignId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      const { items, nextCursor } = await fetchList(
        ctx.client,
        (cursor) => ctx.client.listCampaignPeople(campaignId, { search: opts.search, status: opts.status, limit, cursor }),
        { all: opts.all, cursor: opts.cursor },
      );
      printItems(items, peopleColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  campaigns
    .command("launch <campaignId>")
    .aliases(["send"])
    .description("Launch (activate) a campaign and run the send pipeline")
    .option("--dry-run", "report what would happen without launching")
    .action(async (campaignId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.launchCampaign(campaignId, Boolean(opts.dryRun));
      emitAction(ctx, res, opts.dryRun ? `dry-run: would launch campaign ${campaignId}` : `launched campaign ${campaignId}`);
    });

  campaigns
    .command("pause <campaignId>")
    .description("Pause a campaign")
    .option("--dry-run", "report what would happen without pausing")
    .action(async (campaignId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.pauseCampaign(campaignId, Boolean(opts.dryRun));
      emitAction(ctx, res, opts.dryRun ? `dry-run: would pause campaign ${campaignId}` : `paused campaign ${campaignId}`);
    });

  campaigns
    .command("resume <campaignId>")
    .description("Resume a paused campaign")
    .option("--dry-run", "report what would happen without resuming")
    .action(async (campaignId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.resumeCampaign(campaignId, Boolean(opts.dryRun));
      emitAction(ctx, res, opts.dryRun ? `dry-run: would resume campaign ${campaignId}` : `resumed campaign ${campaignId}`);
    });

  campaigns
    .command("delete <campaignId>")
    .aliases(["rm"])
    .description("Delete a campaign (two-step: preview, then --confirm)")
    .option("--confirm", "actually delete (without this you get an impact preview)")
    .option("--dry-run", "force the impact preview even with --confirm")
    .action(async (campaignId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const confirm = Boolean(opts.confirm) && !opts.dryRun;
      const res = await ctx.client.deleteCampaign(campaignId, { confirm, dryRun: Boolean(opts.dryRun) });
      emitAction(
        ctx,
        res,
        confirm ? `deleted campaign ${campaignId}` : `preview only — re-run with --confirm to delete campaign ${campaignId}`,
      );
    });
}
