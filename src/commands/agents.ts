import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import type { Agent, RunSummary, SendRunRequest } from "../api/types.js";
import type { CliContext } from "../context.js";
import { formatDateTime, printItem, printItems, truncate, type Column } from "../output/format.js";
import {
  ctxOf,
  emitAction,
  fetchList,
  moreHint,
  parseIntOption,
  pollReporter,
  renderRun,
  tableSummaryColumns,
} from "./helpers.js";
import { BRIEF_FLAGS, resolveModel, runBrief, type BriefOptions } from "./run.js";

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const agentColumns: Column<Agent>[] = [
  { header: "id", get: (a) => a.id },
  { header: "name", get: (a) => truncate(a.name, 40) },
  { header: "workspace", get: (a) => a.workspaceId },
  { header: "last_run", get: (a) => a.lastRun?.status ?? "" },
  { header: "created", get: (a) => formatDateTime(a.createdAt) },
];

const runColumns: Column<RunSummary>[] = [
  { header: "id", get: (r) => r.id },
  { header: "status", get: (r) => r.status },
  { header: "model", get: (r) => r.model },
  { header: "steps", get: (r) => `${r.steps.completed}/${r.steps.max}` },
  { header: "prompt", get: (r) => truncate(r.prompt, 50) },
  { header: "started", get: (r) => formatDateTime(r.startedAt) },
];

export function registerAgentsCommands(program: Command): void {
  const agents = program.command("agents").aliases(["agent", "a"]).description("AI workers — create, drive, and inspect");

  agents
    .command("list", { isDefault: true })
    .alias("ls")
    .description("List agents")
    .option("--search <text>", "case-insensitive substring match on the agent name")
    .option("-n, --limit <n>", "max agents to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      const { items, nextCursor } = await fetchList(
        ctx.client,
        (cursor) => ctx.client.listAgents({ search: opts.search, limit, cursor }),
        { all: opts.all, cursor: opts.cursor },
      );
      printItems(items, agentColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  agents
    .command("get <agentId>")
    .description("Fetch an agent (+ its last run)")
    .action(async (agentId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const agent = await ctx.client.getAgent(agentId);
      printItem(agent as unknown as Record<string, unknown>, agentColumns as never, {
        format: ctx.format,
        fields: ctx.fields,
      });
    });

  BRIEF_FLAGS(
    agents.command("create <prompt...>").description("Create an agent from a brief and poll it (same as `origami run`)"),
  ).action(async (prompt: string[], opts: BriefOptions, command: Command) => {
    const ctx = ctxOf(command);
    await runBrief(ctx, prompt.join(" "), opts);
  });

  agents
    .command("ask <agentId> <prompt...>")
    .description("Send a follow-up run to an agent (answer a question or ask for more)")
    .option("-m, --model <model>", "model: lite | max")
    .option("-t, --table <id>", "focus the follow-up on a table (repeatable)", collect, [])
    .option("--no-wait", "return immediately without polling")
    .option("--poll-timeout <seconds>", "max seconds to poll before giving up (default 900)")
    .action(async (agentId: string, prompt: string[], opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const model = resolveModel(opts.model);
      const focusTableIds: string[] = opts.table ?? [];
      const request: SendRunRequest = {
        prompt: prompt.join(" ").trim(),
        ...(focusTableIds.length ? { focusTableIds } : {}),
        ...(model ? { model } : {}),
      };
      if (!request.prompt) throw new OrigamiConfigError("A follow-up prompt is required.");
      const { run } = await ctx.client.sendRun(agentId, request);
      if (opts.wait === false) {
        emitAction(ctx, run, `started run ${run.id} on agent ${agentId} (${run.status})`);
        return;
      }
      const timeoutMs = (parseIntOption(opts.pollTimeout, "poll-timeout") ?? 900) * 1000;
      const terminal = await ctx.client.waitForRun(agentId, run.id, { timeoutMs, onPoll: pollReporter() });
      renderRun(ctx, terminal);
    });

  agents
    .command("runs <agentId>")
    .description("List an agent's run history")
    .option("-n, --limit <n>", "max runs to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (agentId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      const { items, nextCursor } = await fetchList(
        ctx.client,
        (cursor) => ctx.client.listRuns(agentId, { limit, cursor }),
        { all: opts.all, cursor: opts.cursor },
      );
      printItems(items, runColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  agents
    .command("run-get <agentId> <runId>")
    .description("Fetch a single run (optionally poll it to completion)")
    .option("--wait", "poll until the run reaches a terminal status")
    .option("--include <list>", "opt-in projections: stats,transcript")
    .option("--poll-timeout <seconds>", "max seconds to poll (with --wait; default 900)")
    .action(async (agentId: string, runId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const include = parseIncludeList(opts.include);
      if (opts.wait) {
        const timeoutMs = (parseIntOption(opts.pollTimeout, "poll-timeout") ?? 900) * 1000;
        const run = await ctx.client.waitForRun(agentId, runId, {
          ...(include ? { include } : {}),
          timeoutMs,
          onPoll: pollReporter(),
        });
        renderRun(ctx, run);
        return;
      }
      const run = await ctx.client.getRun(agentId, runId, include);
      renderRun(ctx, run);
    });

  agents
    .command("tables <agentId>")
    .description("List the tables in an agent's workspace")
    .action(async (agentId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const page = await ctx.client.listAgentTables(agentId);
      printItems(page.items, tableSummaryColumns, { format: ctx.format, fields: ctx.fields });
    });

  agents
    .command("cancel <agentId>")
    .description("Cancel the agent's currently-active run (kept work is preserved)")
    .action(async (agentId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.cancelRun(agentId);
      emitAction(ctx, res, `cancelled active run for agent ${agentId}`);
    });

  agents
    .command("archive <agentId>")
    .aliases(["rm", "delete"])
    .description("Archive (soft-delete) an agent")
    .action(async (agentId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.archiveAgent(agentId);
      emitAction(ctx, res, `archived agent ${agentId}`);
    });
}

function parseIncludeList(value: string | undefined): Array<"stats" | "transcript"> | undefined {
  if (!value) return undefined;
  const tokens = value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const out: Array<"stats" | "transcript"> = [];
  for (const token of tokens) {
    if (token === "stats" || token === "transcript") out.push(token);
    else throw new OrigamiConfigError(`Invalid --include token "${token}". Expected: stats, transcript.`);
  }
  return out.length ? out : undefined;
}
