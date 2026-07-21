import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OrigamiClient } from "../src/api/client.js";
import { streamResponseToFile } from "../src/util/download.js";

interface ReceivedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  project: string | undefined;
  body: string;
}

const received: ReceivedRequest[] = [];
let server: Server;
let baseUrl: string;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    received.push({
      method: req.method ?? "",
      path: url.pathname,
      auth: req.headers["authorization"],
      project: req.headers["x-origami-project"] as string | undefined,
      body,
    });
    const send = (status: number, payload: unknown, contentType = "application/json") => {
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };

    const p = url.pathname;
    if (req.method === "POST" && p === "/agents") {
      send(202, {
        agent: { object: "agent", id: "a1", name: "Austin founders", workspaceId: "w1", createdAt: "2026-01-01T00:00:00Z" },
        run: {
          object: "run",
          id: "r1",
          agentId: "a1",
          status: "completed",
          model: "origami-max",
          steps: { completed: 3, max: 50 },
          startedAt: "2026-01-01T00:00:00Z",
          workspaceId: "w1",
          request: { prompt: "x", model: "origami-max", focusTableIds: [] },
          response: {
            text: "Found 2 founders.",
            actions: [],
            tables: [{ object: "table", id: "t1", name: "Austin Founders", leadCount: 2, url: "https://origami.chat/x" }],
            transcriptTruncated: false,
          },
          todo: { pendingQuestions: [], nextActions: [] },
        },
        workspace: { object: "workspace", id: "w1", name: "ws", createdAt: "2026-01-01T00:00:00Z", createdByApi: true },
      });
    } else if (req.method === "GET" && p === "/tables/t1/rows" && url.searchParams.get("format") === "csv") {
      send(200, "name,website\nAcme,acme.com", "text/csv");
    } else if (req.method === "GET" && p === "/tables/t1/rows") {
      send(200, {
        object: "list",
        items: [{ object: "row", id: "row1", cells: { name: { type: "scalar", value: "Acme" } } }],
        nextCursor: null,
        total: 1,
        url: "/tables/t1/rows",
      });
    } else if (req.method === "GET" && p === "/account") {
      send(200, {
        object: "account",
        organization: { id: "o1", name: "Acme" },
        plan: { id: "pro", name: "Pro" },
        capabilities: { canUseApi: true, canRunScheduledTasks: true, concurrentAgents: 3 },
        workspaces: { used: 1, limit: 10 },
      });
    } else if (req.method === "GET" && p === "/blob") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "5" });
      res.end(Buffer.from("hello"));
    } else {
      send(404, { error: "not found", code: "NOT_FOUND" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

function client(projectId?: string): OrigamiClient {
  return new OrigamiClient({ apiKey: "og_live_tok", baseUrl, maxRetries: 0, ...(projectId ? { projectId } : {}) });
}

describe("integration against a live HTTP server", () => {
  it("creates an agent with auth + project headers and reads the built table", async () => {
    const res = await client("proj-9").createAgent({ prompt: "Find Austin founders" });
    expect(res.run.status).toBe("completed");
    expect(res.run.response?.tables[0]!.name).toBe("Austin Founders");
    const last = received.at(-1)!;
    expect(last.auth).toBe("Bearer og_live_tok");
    expect(last.project).toBe("proj-9");
    expect(JSON.parse(last.body)).toEqual({ prompt: "Find Austin founders" });
  });

  it("does not send the project header for account", async () => {
    const account = await client("proj-9").getAccount();
    expect(account.plan.name).toBe("Pro");
    expect(received.at(-1)!.project).toBeUndefined();
  });

  it("reads rows as JSON and as CSV", async () => {
    const page = await client().listRows("t1");
    expect(page.total).toBe(1);
    expect(page.items[0]!.id).toBe("row1");
    const csv = await client().getRowsCsv("t1");
    expect(csv).toBe("name,website\nAcme,acme.com");
  });

  it("streams a body to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "origami-dl-"));
    try {
      const response = await fetch(`${baseUrl}/blob`);
      const dest = join(dir, "blob.bin");
      const bytes = await streamResponseToFile(response, dest);
      expect(bytes).toBe(5);
      expect(readFileSync(dest, "utf8")).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
