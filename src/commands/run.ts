import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import {
  normalizeModel,
  type CreateAgentRequest,
  type Model,
  type RunInclude,
} from "../api/types.js";
import type { CliContext } from "../context.js";
import { color } from "../output/color.js";
import { printJson, writeOut } from "../output/format.js";
import { ctxOf, parseIntOption, pollReporter, renderRows, renderRun } from "./helpers.js";

const DEFAULT_POLL_TIMEOUT_S = 900;

export interface BriefOptions {
  model?: string;
  workspace?: string;
  table?: string[];
  name?: string;
  wait?: boolean;
  pollTimeout?: string;
  include?: string;
  rows?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Validate and normalize a `--model` flag. */
export function resolveModel(value: string | undefined): Model | undefined {
  if (!value) return undefined;
  const model = normalizeModel(value);
  if (!model) {
    throw new OrigamiConfigError(`Invalid --model "${value}". Expected: lite | max (origami-lite | origami-max).`);
  }
  return model;
}

function parseInclude(value: string | undefined): RunInclude[] | undefined {
  if (!value) return undefined;
  const tokens = value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const out: RunInclude[] = [];
  for (const token of tokens) {
    if (token === "stats" || token === "transcript") out.push(token);
    else throw new OrigamiConfigError(`Invalid --include token "${token}". Expected: stats, transcript.`);
  }
  return out.length ? out : undefined;
}

/**
 * Create an agent from a prompt and (unless --no-wait) poll it to completion,
 * then render the result. Shared by `run` and `agents create`.
 */
export async function runBrief(ctx: CliContext, prompt: string, opts: BriefOptions): Promise<void> {
  ctx.requireKey();
  const trimmed = prompt.trim();
  if (!trimmed) throw new OrigamiConfigError("A brief (prompt) is required.");

  const model = resolveModel(opts.model);
  const include = parseInclude(opts.include);
  const focusTableIds = opts.table ?? [];

  const request: CreateAgentRequest = {
    prompt: trimmed,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.workspace ? { workspaceId: opts.workspace } : {}),
    ...(focusTableIds.length ? { focusTableIds } : {}),
    ...(model ? { model } : {}),
  };

  const created = await ctx.client.createAgent(request);

  if (opts.wait === false) {
    if (ctx.format === "json") {
      printJson(created);
    } else {
      writeOut(`${color.green("✓")} agent ${created.agent.id} started run ${created.run.id} (${created.run.status})`);
      writeOut(color.dim(`  poll with: origami agents run-get ${created.agent.id} ${created.run.id} --wait`));
    }
    return;
  }

  const timeoutMs = (parseIntOption(opts.pollTimeout, "poll-timeout") ?? DEFAULT_POLL_TIMEOUT_S) * 1000;
  const run = await ctx.client.waitForRun(created.agent.id, created.run.id, {
    ...(include ? { include } : {}),
    timeoutMs,
    onPoll: pollReporter(),
  });

  if (opts.rows && run.response?.tables?.length) {
    const firstTable = run.response.tables[0]!;
    const rowsPage = await ctx.client.listRows(firstTable.id, { flat: true, limit: 100 });
    if (ctx.format === "json") {
      printJson({ run, rows: rowsPage.items });
      return;
    }
    renderRun(ctx, run);
    writeOut("");
    writeOut(color.bold(`Rows in "${firstTable.name}" (${rowsPage.items.length}):`));
    renderRows(ctx, rowsPage.items);
    return;
  }

  renderRun(ctx, run);
}

const BRIEF_FLAGS = (cmd: Command): Command =>
  cmd
    .option("-m, --model <model>", "model: lite | max (origami-lite | origami-max)")
    .option("-w, --workspace <id>", "run inside an existing workspace")
    .option("-t, --table <id>", "focus the agent on a table (repeatable)", collect, [])
    .option("--name <label>", "human-readable label for the agent")
    .option("--no-wait", "return immediately with the running run id (don't poll)")
    .option("--poll-timeout <seconds>", `max seconds to poll before giving up (default ${DEFAULT_POLL_TIMEOUT_S})`)
    .option("--include <list>", "opt-in projections while polling: stats,transcript")
    .option("--rows", "after completion, also dump the first result table's rows");

/** Register the top-level `run` command (hero flow). */
export function registerRunCommand(program: Command): void {
  BRIEF_FLAGS(
    program
      .command("run <brief...>")
      .description("Run an agent from a plain-English brief and poll it to completion"),
  ).action(async (brief: string[], opts: BriefOptions, command: Command) => {
    const ctx = ctxOf(command);
    await runBrief(ctx, brief.join(" "), opts);
  });
}

export { BRIEF_FLAGS };
