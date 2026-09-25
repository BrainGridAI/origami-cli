import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrigamiClient, type FetchLike } from "../src/api/client.js";
import { OrigamiConfigError } from "../src/api/errors.js";
import { buildProgram } from "../src/cli.js";
import { V3_OPERATIONS } from "../src/v3/catalog.js";
import { commandPath } from "../src/v3/commands.js";
import { nextPollDelay, waitForJob } from "../src/v3/jobs.js";
import type { V3Job } from "../src/v3/types.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let dir: string;
let calls: Call[];
let stdout: string;
const savedEnv = { ...process.env };

function stubFetch(responses: Array<Response | (() => Response)>): void {
  let i = 0;
  vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return typeof next === "function" ? next() : next;
  }) as unknown as FetchLike);
}

async function cli(...args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "origami", ...args, "--api-key", "og_live_test", "-o", "json"]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "origami-v3-"));
  process.env.ORIGAMI_CONFIG_DIR = dir;
  delete process.env.ORIGAMI_API_KEY;
  delete process.env.ORIGAMI_BASE_URL;
  delete process.env.ORIGAMI_PROJECT;
  calls = [];
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function leafCommands(command: Command, prefix: string[] = []): Array<{ path: string[]; command: Command }> {
  if (command.commands.length === 0) return [{ path: prefix, command }];
  return command.commands.flatMap((c) => leafCommands(c, [...prefix, c.name()]));
}

describe("v3 catalog", () => {
  it("covers every operation once, with unique dotted ids", () => {
    const ids = V3_OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(120);
    for (const op of V3_OPERATIONS) {
      expect(op.path.startsWith("/")).toBe(true);
      const pathParams = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(op.params.filter((p) => p.in === "path").map((p) => p.name)).toEqual(pathParams);
    }
  });

  it("registers a command for every operation, and no command repeats a flag", () => {
    const program = buildProgram();
    const v3Leaves = ["send", "leads", "jobs", "account"].flatMap((s) =>
      leafCommands(program.commands.find((c) => c.name() === s)!, [s]),
    );
    // 120 operations + the hand-written `jobs wait`.
    expect(v3Leaves.length).toBe(V3_OPERATIONS.length + 1);
    for (const { path, command } of v3Leaves) {
      const longs = command.options.map((o) => o.long).filter(Boolean);
      expect(new Set(longs).size, `duplicate flag on ${path.join(" ")}`).toBe(longs.length);
    }
  });

  it("names commands after the operation id", () => {
    const op = V3_OPERATIONS.find((o) => o.id === "send.campaigns.people.remove_bulk")!;
    expect(commandPath(op)).toEqual(["send", "campaigns", "people", "remove-bulk"]);
  });
});

describe("v3 commands on the wire", () => {
  it("launch --dry-run posts dry_run to /api/v3 with an idempotency key", async () => {
    stubFetch([json({ object: "launch_preview", would_launch: false, blockers: [] })]);
    await cli("send", "campaigns", "launch", "camp-1", "--dry-run");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://origami.chat/api/v3/send/campaigns/camp-1/launch");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ dry_run: true });
    expect(calls[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(stdout)).toMatchObject({ object: "launch_preview" });
  });

  it("collapses a lone get into its group: `send campaigns stats <id>`", async () => {
    stubFetch([json({ object: "campaign_stats", contacted: 0 })]);
    await cli("send", "campaigns", "stats", "camp-1");
    expect(calls[0]!.url).toBe("https://origami.chat/api/v3/send/campaigns/camp-1/stats");
    expect(calls[0]!.method).toBe("GET");
  });

  it("runs the argument-free get as the group default: `origami account`", async () => {
    stubFetch([json({ object: "account", organization: { id: "o1" } })]);
    await cli("account");
    expect(calls[0]!.url).toBe("https://origami.chat/api/v3/account");
  });

  it("sends false for --no-<flag> and omits flags that were not given", async () => {
    stubFetch([json({ object: "campaign_settings" })]);
    await cli("send", "campaigns", "settings", "patch", "camp-1", "--no-auto-lead-refill-enabled", "--require-message-approval");
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ auto_lead_refill_enabled: false, require_message_approval: true });
  });

  it("merges --data with flags, flags winning", async () => {
    stubFetch([json({ object: "campaign", id: "c2" })]);
    const file = join(dir, "body.json");
    writeFileSync(file, JSON.stringify({ name: "from file", channels: ["email"] }));
    await cli("send", "campaigns", "create", "--data", `@${file}`, "--channels", "linkedin");
    expect(calls[0]!.body).toEqual({ name: "from file", channels: ["linkedin"] });
  });

  it("parses JSON flags and renames a flag that collides with a global option", async () => {
    stubFetch([json({ object: "person_schema", fields: [] })]);
    await cli("send", "campaigns", "people", "schema", "put", "camp-1", "--body-fields", '[{"key":"title"}]');
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual({ fields: [{ key: "title" }] });
  });

  it("joins repeated and comma-separated list query flags", async () => {
    stubFetch([json({ object: "list", items: [], next_cursor: null })]);
    await cli("leads", "lists", "rows", "list", "list-1", "--ids", "r1,r2", "--ids", "r3", "--sort", "created_at");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v3/leads/lists/list-1/rows");
    expect(url.searchParams.get("ids")).toBe("r1,r2,r3");
    expect(url.searchParams.get("sort")).toBe("created_at");
  });

  it("rejects an enum value the spec does not allow, before any request", async () => {
    stubFetch([json({})]);
    await expect(cli("leads", "lists", "rows", "list", "list-1", "--sort", "nope")).rejects.toBeInstanceOf(
      OrigamiConfigError,
    );
    expect(calls).toHaveLength(0);
  });

  it("names missing required body fields, before any request", async () => {
    stubFetch([json({})]);
    await expect(cli("send", "campaigns", "create", "--name", "x")).rejects.toThrow(/--channels/);
    expect(calls).toHaveLength(0);
  });

  it("--all follows next_cursor and prints every item", async () => {
    stubFetch([
      json({ object: "list", items: [{ id: "a" }], next_cursor: "c2" }),
      json({ object: "list", items: [{ id: "b" }], next_cursor: null }),
    ]);
    await cli("send", "campaigns", "list", "--all");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("c2");
    expect(JSON.parse(stdout)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("prints non-JSON bodies (CSV exports) verbatim", async () => {
    stubFetch([new Response("id,name\nr1,Ada\n", { status: 200, headers: { "content-type": "text/csv" } })]);
    await cli("leads", "lists", "rows", "list", "list-1", "--format", "csv");
    expect(stdout).toBe("id,name\nr1,Ada\n");
  });
});

describe("v3 client", () => {
  it("reuses the same idempotency key when a POST is retried", async () => {
    const seen: string[] = [];
    let n = 0;
    const fetch = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)["idempotency-key"]!);
      n += 1;
      return n === 1 ? new Response("", { status: 503 }) : json({ ok: true });
    }) as unknown as FetchLike;
    const client = new OrigamiClient({ apiKey: "k", fetch, sleep: async () => {} });
    await client.requestV3({ method: "POST", path: "/send/campaigns/c/launch", body: {} });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("derives the v3 base from a custom v2 base URL", () => {
    const client = new OrigamiClient({ baseUrl: "http://localhost:3000/api/v2/" });
    expect(client.v3BaseUrl).toBe("http://localhost:3000/api/v3");
  });
});

describe("waitForJob", () => {
  const job = (status: V3Job["status"], next?: string): V3Job => ({
    object: "job",
    id: "job-1",
    status,
    ...(next ? { next_poll_at: next } : {}),
  });

  it("waits until next_poll_at, clamped to 1-30s", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(nextPollDelay(job("running", "2026-09-24T12:00:07Z"), undefined, now)).toBe(7_000);
    expect(nextPollDelay(job("running", "2026-09-24T11:59:00Z"), undefined, now)).toBe(1_000);
    expect(nextPollDelay(job("running", "2026-09-24T13:00:00Z"), undefined, now)).toBe(30_000);
    expect(nextPollDelay(job("running"), 2_500, now)).toBe(2_500);
  });

  it("polls until a terminal status and returns that Job", async () => {
    const bodies = [job("queued"), job("running"), job("succeeded")];
    let i = 0;
    const fetch = (async () => json(bodies[i++])) as unknown as FetchLike;
    const client = new OrigamiClient({ apiKey: "k", fetch });
    const slept: number[] = [];
    const result = await waitForJob(client, "job-1", { sleep: async (ms) => void slept.push(ms) });
    expect(result.status).toBe("succeeded");
    expect(slept).toHaveLength(2);
  });

  it("stops on needs_input so the caller can answer it", async () => {
    const fetch = (async () => json(job("needs_input"))) as unknown as FetchLike;
    const client = new OrigamiClient({ apiKey: "k", fetch });
    const result = await waitForJob(client, "job-1", { sleep: async () => {} });
    expect(result.status).toBe("needs_input");
  });
});
