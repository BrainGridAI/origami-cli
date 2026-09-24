import type { OrigamiClient } from "../api/client.js";
import { OrigamiNetworkError } from "../api/errors.js";
import { JOB_TERMINAL, type V3Job } from "./types.js";

export interface WaitForJobOptions {
  /** Overall ceiling in ms. Default 30 minutes (Jobs stay running through enrichment). */
  timeoutMs?: number;
  onPoll?: (job: V3Job) => void;
  /** Injectable clock + sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 30_000;
const DEFAULT_POLL_MS = 5_000;

export function isJob(value: unknown): value is V3Job {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).object === "job");
}

/**
 * How long to wait before the next poll: the Job's own `next_poll_at` when present,
 * else the response's Retry-After, else 5s; clamped to 1-30s.
 */
export function nextPollDelay(job: V3Job, retryAfterMs: number | undefined, now: number): number {
  let delay: number | undefined;
  if (job.next_poll_at) {
    const at = Date.parse(job.next_poll_at);
    if (Number.isFinite(at)) delay = at - now;
  }
  delay ??= retryAfterMs ?? DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, delay));
}

/**
 * Poll `GET /jobs/{job_id}` until the Job leaves queued/running. `needs_input`
 * counts as a stop: the Job waits on an answer (`origami jobs input`).
 */
export async function waitForJob(client: OrigamiClient, jobId: string, options: WaitForJobOptions = {}): Promise<V3Job> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  for (;;) {
    const res = await client.requestV3({ method: "GET", path: `/jobs/${encodeURIComponent(jobId)}` });
    const job = res.data as V3Job;
    options.onPoll?.(job);
    if (JOB_TERMINAL.has(job.status)) return job;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new OrigamiNetworkError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for job ${jobId} (still ${job.status}). ` +
          `Resume with: origami jobs wait ${jobId}`,
        undefined,
      );
    }
    await sleep(Math.min(nextPollDelay(job, res.retryAfterMs, now()), remaining));
  }
}

/** Throttled one-line progress reporter on stderr (TTY only). */
export function jobPollReporter(): (job: V3Job) => void {
  return (job: V3Job) => {
    if (!process.stderr.isTTY) return;
    const phase = job.phase ? ` · ${job.phase}` : "";
    process.stderr.write(`\r${" ".repeat(70)}\r⏳ ${job.status}${phase}`);
    if (JOB_TERMINAL.has(job.status)) process.stderr.write("\n");
  };
}
