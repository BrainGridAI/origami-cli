import { describe, expect, it, vi } from "vitest";

import { OrigamiClient, type FetchLike } from "../src/api/client.js";
import { OrigamiNetworkError } from "../src/api/errors.js";

function run(status: string, retryAfter?: string): Response {
  return new Response(JSON.stringify({ object: "run", id: "r1", agentId: "a1", status, steps: { completed: 1, max: 30 } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(retryAfter != null ? { "retry-after": retryAfter } : {}),
    },
  });
}

function sequencedFetch(responses: Response[]): { fetch: FetchLike; count: () => number } {
  let i = 0;
  const fetch = (async () => {
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return res;
  }) as unknown as FetchLike;
  return { fetch, count: () => i };
}

describe("waitForRun", () => {
  it("polls until a terminal status and honors Retry-After", async () => {
    const { fetch, count } = sequencedFetch([run("running", "0"), run("running", "0"), run("completed")]);
    const sleep = vi.fn(async () => {});
    const client = new OrigamiClient({ apiKey: "og_live_x", fetch, sleep, maxRetries: 0 });

    const polls: string[] = [];
    const result = await client.waitForRun("a1", "r1", { onPoll: (r) => polls.push(r.status) });

    expect(result.status).toBe("completed");
    expect(count()).toBe(3); // running, running, completed
    expect(polls).toEqual(["running", "running", "completed"]);
    // Slept once per non-terminal poll, using the header value (0s here).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("defaults to a 15s interval when Retry-After is absent", async () => {
    const { fetch } = sequencedFetch([run("running"), run("completed")]);
    const sleep = vi.fn(async () => {});
    const client = new OrigamiClient({ apiKey: "og_live_x", fetch, sleep, maxRetries: 0 });
    await client.waitForRun("a1", "r1");
    expect(sleep).toHaveBeenCalledWith(15_000);
  });

  it("returns immediately when the first poll is already terminal", async () => {
    const { fetch, count } = sequencedFetch([run("needs_input")]);
    const sleep = vi.fn(async () => {});
    const client = new OrigamiClient({ apiKey: "og_live_x", fetch, sleep, maxRetries: 0 });
    const result = await client.waitForRun("a1", "r1");
    expect(result.status).toBe("needs_input");
    expect(count()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("times out while the run stays running", async () => {
    const { fetch } = sequencedFetch([run("running", "0")]);
    const sleep = vi.fn(async () => {});
    const client = new OrigamiClient({ apiKey: "og_live_x", fetch, sleep, maxRetries: 0 });
    await expect(client.waitForRun("a1", "r1", { timeoutMs: 0 })).rejects.toBeInstanceOf(OrigamiNetworkError);
  });
});
