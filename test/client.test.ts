import { describe, expect, it } from "vitest";

import { OrigamiClient, type FetchLike } from "../src/api/client.js";
import { OrigamiApiError, OrigamiNetworkError } from "../src/api/errors.js";

interface Recorded {
  url: string;
  init: RequestInit;
}

function mockFetch(responses: Array<Response | (() => Response)>): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === "function" ? next() : next;
  }) as unknown as FetchLike;
  return { fetch, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeClient(fetch: FetchLike, overrides = {}): OrigamiClient {
  return new OrigamiClient({
    apiKey: "og_live_test",
    projectId: "proj-1",
    fetch,
    sleep: async () => {},
    maxRetries: 3,
    ...overrides,
  });
}

describe("OrigamiClient request shaping", () => {
  it("sends auth + project headers and a JSON body for createAgent", async () => {
    const { fetch, calls } = mockFetch([
      json({ agent: { id: "a1" }, run: { id: "r1", status: "running" }, workspace: { id: "w1" } }, { status: 202 }),
    ]);
    const client = makeClient(fetch);

    await client.createAgent({ prompt: "Find 20 SaaS founders", model: "origami-max" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://origami.chat/api/v2/agents");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer og_live_test");
    expect(headers["x-origami-project"]).toBe("proj-1");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({ prompt: "Find 20 SaaS founders", model: "origami-max" });
  });

  it("omits the project header on /projects and /account", async () => {
    const { fetch, calls } = mockFetch([json({ object: "list", items: [], nextCursor: null, url: "/projects" }), json({ object: "account" })]);
    const client = makeClient(fetch);
    await client.listProjects();
    await client.getAccount();
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["x-origami-project"]).toBeUndefined();
      expect(headers["authorization"]).toBe("Bearer og_live_test");
    }
    expect(calls[0]!.url).toBe("https://origami.chat/api/v2/projects");
    expect(calls[1]!.url).toBe("https://origami.chat/api/v2/account");
  });

  it("encodes ids into the run path and serializes include", async () => {
    const { fetch, calls } = mockFetch([json({ id: "r 1", status: "completed" })]);
    const client = makeClient(fetch, { maxRetries: 0 });
    await client.getRun("a/1", "r 1", ["stats", "transcript"]);
    expect(calls[0]!.url).toBe(
      "https://origami.chat/api/v2/agents/a%2F1/runs/r%201?include=stats%2Ctranscript",
    );
  });

  it("requests CSV rows with a text/csv Accept and format=csv", async () => {
    const { fetch, calls } = mockFetch([
      new Response("name\nAcme", { status: 200, headers: { "content-type": "text/csv" } }),
    ]);
    const client = makeClient(fetch);
    const csv = await client.getRowsCsv("t1", { limit: 200 });
    expect(csv).toBe("name\nAcme");
    const call = calls[0]!;
    expect(call.url).toContain("/tables/t1/rows");
    expect(call.url).toContain("format=csv");
    expect(call.url).toContain("limit=200");
    expect((call.init.headers as Record<string, string>)["accept"]).toBe("text/csv");
  });

  it("serializes row filters and sort as JSON query params", async () => {
    const { fetch, calls } = mockFetch([json({ object: "list", items: [], nextCursor: null, total: 0, url: "/x" })]);
    const client = makeClient(fetch);
    await client.listRows("t1", {
      filters: [{ column: "website", operator: "is_not_empty", value: "" }],
      sort: { column: "score", direction: "desc" },
    });
    const url = new URL(calls[0]!.url);
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual([
      { column: "website", operator: "is_not_empty", value: "" },
    ]);
    expect(JSON.parse(url.searchParams.get("sort")!)).toEqual({ column: "score", direction: "desc" });
  });
});

describe("OrigamiClient pagination", () => {
  it("follows nextCursor across pages via collect", async () => {
    const { fetch } = mockFetch([
      json({ object: "list", items: [{ id: "a" }, { id: "b" }], nextCursor: "c2", url: "/agents" }),
      json({ object: "list", items: [{ id: "c" }], nextCursor: null, url: "/agents" }),
    ]);
    const client = makeClient(fetch);
    const all = await client.collect((cursor) => client.listAgents({ cursor }));
    expect(all.map((a) => (a as { id: string }).id)).toEqual(["a", "b", "c"]);
  });

  it("respects a limit and stops early", async () => {
    const { fetch, calls } = mockFetch([
      json({ object: "list", items: [{ id: "a" }, { id: "b" }], nextCursor: "c2", url: "/agents" }),
      json({ object: "list", items: [{ id: "c" }], nextCursor: null, url: "/agents" }),
    ]);
    const client = makeClient(fetch);
    const some = await client.collect((cursor) => client.listAgents({ cursor }), 2);
    expect(some).toHaveLength(2);
    expect(calls).toHaveLength(1); // stopped before page 2
  });
});

describe("OrigamiClient retry + errors", () => {
  it("retries on 429 then succeeds, tracking rate-limit headers", async () => {
    const { fetch, calls } = mockFetch([
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0", "x-ratelimit-limit-global": "100", "x-ratelimit-remaining-global": "0" },
      }),
      json({ object: "list", items: [], nextCursor: null, url: "/agents" }, {
        headers: {
          "content-type": "application/json",
          "x-ratelimit-limit-global": "100",
          "x-ratelimit-remaining-global": "99",
        },
      }),
    ]);
    const client = makeClient(fetch);
    const res = await client.listAgents();
    expect(res.items).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(client.lastRateLimit?.limit).toBe(100);
    expect(client.lastRateLimit?.remaining).toBe(99);
  });

  it("maps a 404 with an error envelope to an OrigamiApiError (code + message)", async () => {
    const { fetch } = mockFetch([
      new Response(JSON.stringify({ error: "Table not found", code: "TABLE_NOT_FOUND" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const client = makeClient(fetch, { maxRetries: 0 });
    await expect(client.getTable("missing")).rejects.toMatchObject({
      status: 404,
      isNotFound: true,
      code: "TABLE_NOT_FOUND",
    });
    await expect(client.getTable("missing")).rejects.toBeInstanceOf(OrigamiApiError);
  });

  it("gives up after maxRetries on repeated 500s", async () => {
    const { fetch, calls } = mockFetch([() => new Response("boom", { status: 500 })]);
    const client = makeClient(fetch, { maxRetries: 2 });
    await expect(client.getAccount()).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it("throws OrigamiNetworkError after exhausting retries on persistent network errors", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      throw new Error("boom");
    }) as unknown as FetchLike;
    const client = makeClient(fetch, { maxRetries: 2 });
    await expect(client.getAccount()).rejects.toBeInstanceOf(OrigamiNetworkError);
    expect(calls).toBe(3);
  });
});
