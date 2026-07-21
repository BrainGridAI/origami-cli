import { OrigamiAuthError } from "./api/errors.js";
import { OrigamiClient, type DebugEvent } from "./api/client.js";
import { APP_ORIGIN } from "./api/types.js";
import { resolveSettings, type ResolvedSettings } from "./config/config.js";
import { setColorEnabled } from "./output/color.js";
import { color } from "./output/color.js";
import { parseFormat, type OutputFormat } from "./output/format.js";

/** Global options shared by every command (defined on the root program). */
export interface GlobalOptions {
  apiKey?: string;
  project?: string;
  profile?: string;
  baseUrl?: string;
  output?: string;
  fields?: string;
  color?: boolean;
  debug?: boolean;
  timeout?: string;
  retry?: boolean;
  maxRetries?: string;
}

export interface CliContext {
  settings: ResolvedSettings;
  format: OutputFormat;
  fields: string[] | undefined;
  debug: boolean;
  client: OrigamiClient;
  /** Returns the resolved API key or throws a helpful auth error. */
  requireKey(): string;
}

function computeColor(opts: GlobalOptions): boolean {
  if (opts.color === false) return false;
  if (process.env.NO_COLOR != null) return false;
  if (process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY);
}

export function createContext(opts: GlobalOptions): CliContext {
  setColorEnabled(computeColor(opts));

  const settings = resolveSettings({
    apiKey: opts.apiKey,
    project: opts.project,
    baseUrl: opts.baseUrl,
    profile: opts.profile,
  });

  const format = parseFormat(opts.output);
  const fields = opts.fields
    ? opts.fields.split(",").map((f) => f.trim()).filter(Boolean)
    : undefined;
  const debug = Boolean(opts.debug);

  const timeoutMs = opts.timeout ? Number(opts.timeout) : undefined;
  let maxRetries: number | undefined;
  if (opts.retry === false) maxRetries = 0;
  else if (opts.maxRetries != null) maxRetries = Number(opts.maxRetries);

  const client = new OrigamiClient({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    projectId: settings.projectId,
    ...(timeoutMs != null && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    ...(maxRetries != null && Number.isFinite(maxRetries) ? { maxRetries } : {}),
    onDebug: debug ? logDebug : undefined,
    onRetry: ({ attempt, delayMs, reason }) => {
      process.stderr.write(
        color.dim(`↻ ${reason}; retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt})\n`),
      );
    },
  });

  return {
    settings,
    format,
    fields,
    debug,
    client,
    requireKey(): string {
      if (!settings.apiKey) {
        throw new OrigamiAuthError(
          "No API key found. Provide one with --api-key, set ORIGAMI_API_KEY, or run `origami auth login`.\n" +
            `Create a key under Settings → Developers at ${APP_ORIGIN}`,
        );
      }
      return settings.apiKey;
    },
  };
}

function logDebug(event: DebugEvent): void {
  const parts = [color.dim(`[${event.phase}]`), event.method, event.url];
  if (event.status != null) parts.push(color.dim(`→ ${event.status}`));
  if (event.durationMs != null) parts.push(color.dim(`(${event.durationMs}ms)`));
  if (event.message) parts.push(color.dim(event.message));
  process.stderr.write(`${parts.join(" ")}\n`);
}
