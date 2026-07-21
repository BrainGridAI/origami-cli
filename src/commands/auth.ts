import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import { OrigamiClient } from "../api/client.js";
import { APP_ORIGIN, DEFAULT_BASE_URL } from "../api/types.js";
import {
  DEFAULT_PROFILE,
  deleteProfile,
  loadConfig,
  saveConfig,
  upsertProfile,
  type ProfileConfig,
} from "../config/config.js";
import { createContext, type CliContext, type GlobalOptions } from "../context.js";
import { color } from "../output/color.js";
import { printJson, writeOut } from "../output/format.js";

function ctxOf(command: Command): CliContext {
  return createContext(command.optsWithGlobals() as GlobalOptions);
}

function globalsOf(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function activeProfileName(globals: GlobalOptions): string {
  return globals.profile ?? process.env.ORIGAMI_PROFILE ?? loadConfig().active_profile ?? DEFAULT_PROFILE;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage API keys and profiles");

  auth
    .command("login")
    .description("Store an Origami API key for the active profile")
    .option("--key <key>", "API key to store (og_live_…)")
    .option("--project <id>", "default project (child org) to scope requests to")
    .option("--no-verify", "skip the post-login verification call (GET /account)")
    .option("--set-default", "make this the active profile")
    .action(async (opts, command: Command) => {
      const globals = globalsOf(command);
      const profileName = activeProfileName(globals);

      let key = opts.key as string | undefined;
      if (!key) key = await readKeyFromStdinOrPrompt();
      key = key.trim();
      if (!key) throw new OrigamiConfigError("No API key provided.");

      const patch: Partial<ProfileConfig> = {
        api_key: key,
        ...(opts.project ? { project_id: opts.project } : {}),
      };
      const config = loadConfig();
      const next = upsertProfile(config, profileName, patch);
      if (!next.active_profile || opts.setDefault) next.active_profile = profileName;
      saveConfig(next);

      if (opts.verify !== false) {
        await verifyKey(key, globals);
      }
      writeOut(color.green(`✓ stored API key for profile "${profileName}" (${maskKey(key)})`));
    });

  auth
    .command("status")
    .description("Show the resolved authentication for the active profile")
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const s = ctx.settings;
      let plan: string | null = null;
      if (s.apiKey) {
        try {
          const account = await ctx.client.getAccount();
          plan = `${account.plan.name} (${account.plan.id})`;
        } catch {
          plan = null;
        }
      }
      if (ctx.format === "json") {
        printJson({
          profile: s.profileName,
          authenticated: Boolean(s.apiKey),
          key_source: s.apiKeySource,
          key_preview: s.apiKey ? maskKey(s.apiKey) : null,
          project_id: s.projectId ?? null,
          base_url: s.baseUrl,
          plan,
        });
        return;
      }
      const lines = [
        `${color.bold("Profile")}       ${s.profileName}`,
        `${color.bold("Authenticated")} ${s.apiKey ? color.green("yes") : color.red("no")}`,
        `${color.bold("Key source")}    ${s.apiKeySource}`,
      ];
      if (s.apiKey) lines.push(`${color.bold("Key")}           ${maskKey(s.apiKey)}`);
      if (s.projectId) lines.push(`${color.bold("Project")}       ${s.projectId}`);
      lines.push(`${color.bold("Base URL")}      ${s.baseUrl}`);
      if (plan) lines.push(`${color.bold("Plan")}          ${plan}`);
      writeOut(lines.join("\n"));
    });

  auth
    .command("logout")
    .description("Remove stored credentials from the active profile")
    .option("--all", "delete the entire profile, not just the key")
    .action(async (opts, command: Command) => {
      const globals = globalsOf(command);
      const profileName = activeProfileName(globals);
      let config = loadConfig();
      if (!config.profiles[profileName]) {
        writeOut(color.dim(`Profile "${profileName}" has no stored credentials.`));
        return;
      }
      if (opts.all) {
        config = deleteProfile(config, profileName);
      } else {
        config = upsertProfile(config, profileName, { api_key: undefined, project_id: undefined });
      }
      saveConfig(config);
      writeOut(color.green(`✓ logged out of profile "${profileName}"`));
    });
}

async function verifyKey(key: string, globals: GlobalOptions): Promise<void> {
  const baseUrl = globals.baseUrl ?? process.env.ORIGAMI_BASE_URL ?? DEFAULT_BASE_URL;
  const client = new OrigamiClient({ apiKey: key, baseUrl, maxRetries: 1 });
  try {
    await client.getAccount();
  } catch (err) {
    writeOut(color.yellow(`⚠ key stored, but verification call failed: ${(err as Error).message}`));
    writeOut(color.dim(`  Create a key under Settings → Developers at ${APP_ORIGIN}`));
  }
}

// ---------------------------------------------------------------------------
// Secret input
// ---------------------------------------------------------------------------

async function readKeyFromStdinOrPrompt(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return promptSecret("Paste your Origami API key: ");
}

function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    let input = "";
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(input);
          return;
        }
        if (code === 3) {
          cleanup();
          reject(new OrigamiConfigError("Cancelled."));
          return;
        }
        if (code === 127 || code === 8) {
          input = input.slice(0, -1);
        } else if (code >= 32) {
          input += ch;
        }
      }
    };
    function cleanup(): void {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }
    stdin.on("data", onData);
  });
}
