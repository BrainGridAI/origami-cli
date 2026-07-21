import type { Command } from "commander";

import type { CreateScheduledAgentRequest, ScheduledAgent, UpdateScheduledAgentRequest } from "../api/types.js";
import { formatDateTime, printItem, printItems, printJson, truncate, type Column } from "../output/format.js";
import { resolveModel } from "./run.js";
import { ctxOf, emitAction, fetchList, moreHint, parseIntOption } from "./helpers.js";

const scheduledColumns: Column<ScheduledAgent>[] = [
  { header: "id", get: (s) => s.id },
  { header: "name", get: (s) => truncate(s.name, 30) },
  { header: "cron", get: (s) => s.cron },
  { header: "enabled", get: (s) => (s.enabled ? "yes" : "no") },
  { header: "next_run", get: (s) => formatDateTime(s.nextRunAt) },
  { header: "last_run", get: (s) => formatDateTime(s.lastRunAt) },
];

export function registerScheduledCommands(program: Command): void {
  const scheduled = program
    .command("scheduled")
    .aliases(["scheduled-agents", "cron"])
    .description("Scheduled (recurring) agents");

  scheduled
    .command("list", { isDefault: true })
    .alias("ls")
    .description("List scheduled agents")
    .option("-w, --workspace <id>", "scope to a workspace")
    .option("--enabled <bool>", "filter by enabled: true | false")
    .option("-n, --limit <n>", "max to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      const enabled = opts.enabled == null ? undefined : opts.enabled === "true";
      const { items, nextCursor } = await fetchList(
        ctx.client,
        (cursor) => ctx.client.listScheduledAgents({ workspaceId: opts.workspace, enabled, limit, cursor }),
        { all: opts.all, cursor: opts.cursor },
      );
      printItems(items, scheduledColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  scheduled
    .command("create")
    .description("Create a scheduled agent (disabled by default)")
    .requiredOption("-w, --workspace <id>", "workspace to run in")
    .requiredOption("--name <name>", "agent name")
    .requiredOption("--prompt <prompt>", "the brief to run each time")
    .requiredOption("--cron <expr>", "cron schedule expression")
    .option("--description <text>", "optional description")
    .option("-m, --model <model>", "model: lite | max")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const model = resolveModel(opts.model);
      const request: CreateScheduledAgentRequest = {
        workspaceId: opts.workspace,
        name: opts.name,
        prompt: opts.prompt,
        cron: opts.cron,
        ...(opts.description ? { description: opts.description } : {}),
        ...(model ? { model } : {}),
      };
      const agent = await ctx.client.createScheduledAgent(request);
      emitAction(ctx, agent, `created scheduled agent ${agent.id} (${agent.enabled ? "enabled" : "disabled"})`);
    });

  scheduled
    .command("get <id>")
    .description("Fetch a scheduled agent")
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const agent = await ctx.client.getScheduledAgent(id);
      if (ctx.format === "json") printJson(agent);
      else printItem(agent as unknown as Record<string, unknown>, scheduledColumns as never, { format: ctx.format, fields: ctx.fields });
    });

  scheduled
    .command("update <id>")
    .description("Edit a scheduled agent")
    .option("--name <name>", "new name")
    .option("--prompt <prompt>", "new prompt")
    .option("--cron <expr>", "new cron expression")
    .option("--description <text>", "new description")
    .option("-m, --model <model>", "model: lite | max")
    .action(async (id: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const model = resolveModel(opts.model);
      const request: UpdateScheduledAgentRequest = {
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        ...(opts.cron ? { cron: opts.cron } : {}),
        ...(opts.description ? { description: opts.description } : {}),
        ...(model ? { model } : {}),
      };
      const agent = await ctx.client.updateScheduledAgent(id, request);
      emitAction(ctx, agent, `updated scheduled agent ${id}`);
    });

  scheduled
    .command("enable <id>")
    .description("Enable a scheduled agent")
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const agent = await ctx.client.enableScheduledAgent(id);
      emitAction(ctx, agent, `enabled scheduled agent ${id}`);
    });

  scheduled
    .command("disable <id>")
    .description("Disable a scheduled agent")
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const agent = await ctx.client.disableScheduledAgent(id);
      emitAction(ctx, agent, `disabled scheduled agent ${id}`);
    });

  scheduled
    .command("trigger <id>")
    .description("Manually trigger a run now")
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.triggerScheduledAgent(id);
      emitAction(ctx, res, `triggered scheduled agent ${id} → run ${res.runId}`);
    });

  scheduled
    .command("runs <id>")
    .description("Run history for a scheduled agent")
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const page = await ctx.client.listScheduledAgentRuns(id);
      printJson(page.items);
    });

  scheduled
    .command("delete <id>")
    .aliases(["rm"])
    .description("Delete (soft) a scheduled agent")
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.deleteScheduledAgent(id);
      emitAction(ctx, res, `deleted scheduled agent ${id}`);
    });
}
