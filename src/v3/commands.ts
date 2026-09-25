import { Command, Option } from "commander";

import type { V3QueryValue } from "../api/client.js";
import { OrigamiConfigError } from "../api/errors.js";
import { ctxOf, parseIntOption } from "../commands/helpers.js";
import type { CliContext } from "../context.js";
import { color } from "../output/color.js";
import { truncate } from "../output/format.js";
import { V3_OPERATIONS, V3_SPEC_VERSION } from "./catalog.js";
import { isJob, jobPollReporter, waitForJob } from "./jobs.js";
import { renderJob, renderList, renderResponse } from "./render.js";
import type { V3Field, V3Job, V3Operation, V3Param } from "./types.js";
import { coerceValue, collectList, flagName, parseJsonArg } from "./values.js";

/** Top-level command per v3 section, in help order. */
export const V3_SECTIONS: Record<string, string> = {
  send: "Send (v3): campaigns, people, templates, senders, approvals, launch",
  leads: "Leads (v3): lists, rows, columns, searches, enrichment",
  jobs: "Jobs (v3): the shared async resource; poll, wait, cancel, answer",
  account: "Account (v3): org, credits, senders, exclusions, projects, webhooks, keys",
};

/**
 * Long flags the CLI owns globally. A generated flag that would collide is prefixed
 * with `body-` (today only `send campaigns people schema put --body-fields`).
 */
const RESERVED_FLAGS = new Set([
  "api-key",
  "project",
  "profile",
  "base-url",
  "output",
  "fields",
  "color",
  "debug",
  "timeout",
  "max-retries",
  "retry",
  "data",
  "all",
  "wait",
  "wait-timeout",
  "idempotency-key",
]);

interface FlagBinding {
  field: V3Field;
  target: "query" | "body";
  attribute: string;
}

/** Command words for an operation id: `send.campaigns.stats.get` → [send, campaigns, stats, get]. */
export function commandPath(op: V3Operation): string[] {
  return op.id.split(".").map((s) => s.replace(/_/g, "-"));
}

function describeField(field: V3Field): string {
  const parts: string[] = [];
  if (field.description) parts.push(truncate(field.description, 110));
  if (field.enum?.length) parts.push(`one of: ${field.enum.join(" | ")}`);
  if (field.kind === "boolean") parts.push(`--no-${flagName(field.name)} sends false`);
  if (field.kind === "list") parts.push("comma-separated or repeated");
  if (field.kind === "json") parts.push("JSON, @file.json, or - for stdin");
  if (field.required) parts.push("required");
  return parts.join("; ");
}

function placeholder(field: V3Field): string {
  switch (field.kind) {
    case "integer":
    case "number":
      return "<n>";
    case "list":
      return "<values>";
    case "json":
      return "<json>";
    default:
      return field.enum?.length ? `<${field.enum.slice(0, 4).join("|")}>` : "<value>";
  }
}

/** Add one flag (or a --flag/--no-flag pair for booleans) and return its binding. */
function addFieldOption(command: Command, field: V3Field, target: "query" | "body", taken: Set<string>): FlagBinding {
  let name = flagName(field.name);
  if (RESERVED_FLAGS.has(name) || taken.has(name)) name = `${target}-${name}`;
  taken.add(name);
  const description = describeField(field);
  let option: Option;
  if (field.kind === "boolean") {
    option = new Option(`--${name}`, description);
    command.addOption(option);
    command.addOption(new Option(`--no-${name}`, `send ${field.name}: false`).hideHelp());
  } else {
    option = new Option(`--${name} ${placeholder(field)}`, description);
    if (field.kind === "list") option.argParser(collectList);
    command.addOption(option);
  }
  return { field, target, attribute: option.attributeName() };
}

function fillPath(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = values[name];
    if (value == null || value === "") throw new OrigamiConfigError(`Missing <${flagName(name)}>.`);
    return encodeURIComponent(value);
  });
}

async function drainList(
  ctx: CliContext,
  op: V3Operation,
  path: string,
  query: Record<string, V3QueryValue>,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor = query.cursor as string | undefined;
  do {
    const res = await ctx.client.requestV3({ method: op.method, path, query: { ...query, cursor } });
    const page = res.data as { items?: unknown[]; next_cursor?: string | null };
    items.push(...(page.items ?? []));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return items;
}

/** Build the leaf command for one operation. */
export function buildOperationCommand(op: V3Operation, name: string): Command {
  const command = new Command(name).description(op.summary);
  const pathParams = op.params.filter((p) => p.in === "path");
  const queryParams = op.params.filter((p) => p.in === "query");

  for (const p of pathParams) command.argument(`<${flagName(p.name)}>`, p.description ?? p.name);

  const taken = new Set<string>();
  const bindings: FlagBinding[] = [];
  for (const p of queryParams) bindings.push(addFieldOption(command, p, "query", taken));
  for (const f of op.body ?? []) bindings.push(addFieldOption(command, f, "body", taken));

  if (op.body) {
    command.option("--data <json>", "full request body as JSON, @file.json, or - for stdin (flags override its keys)");
  }
  if (op.method === "POST") {
    command.option("--idempotency-key <key>", "Idempotency-Key header (default: a fresh UUID, reused across retries)");
  }
  if (op.paginated) command.option("--all", "follow next_cursor and return every page");
  if (op.returnsJob) {
    command.option("--wait", "poll the returned Job until it finishes (honors next_poll_at)");
    command.option("--wait-timeout <seconds>", "give up waiting after this many seconds (default 1800)");
  }

  const httpLine = `${op.method} /api/v3${op.path}`;
  command.addHelpText("after", `\n${color.dim(httpLine)}${op.docs ? `\n${color.dim(`Docs: ${op.docs}`)}` : ""}`);

  command.action(async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    const opts = cmd.opts() as Record<string, unknown>;
    const positionals = args.slice(0, pathParams.length).map(String);
    const ctx = ctxOf(cmd);
    ctx.requireKey();

    const pathValues: Record<string, string> = {};
    pathParams.forEach((p, i) => (pathValues[p.name] = positionals[i] ?? ""));
    const path = fillPath(op.path, pathValues);

    const query: Record<string, V3QueryValue> = {};
    let body: Record<string, unknown> | undefined;
    if (op.body) {
      const base = opts.data !== undefined ? parseJsonArg(String(opts.data), "data") : {};
      if (!base || typeof base !== "object" || Array.isArray(base)) {
        throw new OrigamiConfigError("--data must be a JSON object.");
      }
      body = { ...(base as Record<string, unknown>) };
    }
    for (const b of bindings) {
      const value = coerceValue(b.field, opts[b.attribute]);
      if (value === undefined) continue;
      if (b.target === "query") query[b.field.name] = value as V3QueryValue;
      else if (body) body[b.field.name] = value;
    }

    const missing = [
      ...queryParams.filter((p: V3Param) => p.required && query[p.name] === undefined),
      ...(op.body ?? []).filter((f) => f.required && body?.[f.name] === undefined),
    ].map((f) => `--${flagName(f.name)}`);
    if (missing.length > 0) {
      throw new OrigamiConfigError(`Missing required ${missing.length === 1 ? "option" : "options"}: ${missing.join(", ")}`);
    }

    if (op.paginated && opts.all) {
      renderList(ctx, await drainList(ctx, op, path, query));
      return;
    }

    const res = await ctx.client.requestV3({
      method: op.method,
      path,
      query,
      ...(body !== undefined && (op.bodyRequired || Object.keys(body).length > 0) ? { body } : {}),
      idempotencyKey: opts.idempotencyKey as string | undefined,
    });

    if (op.returnsJob && opts.wait && isJob(res.data)) {
      const timeoutSec = parseIntOption(opts.waitTimeout as string | undefined, "wait-timeout");
      const job = await waitForJob(ctx.client, res.data.id, {
        ...(timeoutSec ? { timeoutMs: timeoutSec * 1000 } : {}),
        onPoll: jobPollReporter(),
      });
      renderJob(ctx, job);
      if (job.status === "failed") process.exitCode = 1;
      return;
    }

    renderResponse(ctx, res.data, res.text);
    if (op.paginated && ctx.format !== "json") {
      const next = (res.data as { next_cursor?: string | null } | undefined)?.next_cursor;
      if (next) {
        process.stderr.write(color.dim(`… more results available. Re-run with --all, or --cursor ${next}\n`));
      }
    }
  });

  return command;
}

/** `origami jobs wait <job_id>`: the one command v3 does not spell out as an operation. */
function buildJobsWait(): Command {
  return new Command("wait")
    .description("Poll a Job until it succeeds, fails, is cancelled, or needs input")
    .argument("<job-id>", "job id")
    .option("--wait-timeout <seconds>", "give up after this many seconds (default 1800)")
    .action(async (jobId: string, opts: { waitTimeout?: string }, cmd: Command) => {
      const ctx = ctxOf(cmd);
      ctx.requireKey();
      const timeoutSec = parseIntOption(opts.waitTimeout, "wait-timeout");
      const job: V3Job = await waitForJob(ctx.client, jobId, {
        ...(timeoutSec ? { timeoutMs: timeoutSec * 1000 } : {}),
        onPoll: jobPollReporter(),
      });
      renderJob(ctx, job);
      if (job.status === "failed") process.exitCode = 1;
    });
}

type Trie = { op?: V3Operation; kids: Map<string, Trie> };

/**
 * Register every v3 operation as `origami <section> <group…> <verb>`. A group whose
 * only operation is `get` collapses into the group (`send campaigns stats <id>`),
 * and an argument-free `get` next to siblings becomes the group's default
 * (`origami account`, `origami account credits`).
 */
export function registerV3Commands(program: Command, operations: V3Operation[] = V3_OPERATIONS): void {
  // 1. Build the word tree.
  const trie: Trie = { kids: new Map() };
  for (const op of operations) {
    let node = trie;
    for (const word of commandPath(op)) {
      let next = node.kids.get(word);
      if (!next) {
        next = { kids: new Map() };
        node.kids.set(word, next);
      }
      node = next;
    }
    node.op = op;
  }

  // 2. Materialize commander commands.
  const attach = (parent: Command, word: string, node: Trie, depth: number): void => {
    // Collapse `group get` when get is the group's only operation.
    if (!node.op && node.kids.size === 1 && node.kids.has("get") && node.kids.get("get")!.kids.size === 0) {
      parent.addCommand(buildOperationCommand(node.kids.get("get")!.op!, word));
      return;
    }
    if (node.op && node.kids.size === 0) {
      parent.addCommand(buildOperationCommand(node.op, word));
      return;
    }
    const group = new Command(word).description(
      depth === 0 ? (V3_SECTIONS[word] ?? word) : `${word}: ${[...node.kids.keys()].join(", ")}`,
    );
    if (depth === 0 && word === "jobs") group.addCommand(buildJobsWait());
    for (const [childWord, child] of node.kids) {
      const argFreeGet =
        childWord === "get" && child.op && child.kids.size === 0 && !child.op.params.some((p) => p.in === "path");
      if (argFreeGet) {
        group.addCommand(buildOperationCommand(child.op!, "get"), { isDefault: true });
        continue;
      }
      attach(group, childWord, child, depth + 1);
    }
    if (node.op) {
      // An operation that is also a group (none in the spec today): expose it as `run`.
      group.addCommand(buildOperationCommand(node.op, "run"));
    }
    parent.addCommand(group);
  };

  const order = Object.keys(V3_SECTIONS);
  const sections = [...trie.kids.entries()].sort(
    ([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
  );
  for (const [word, node] of sections) attach(program, word, node, 0);
}

export { V3_SPEC_VERSION };
