import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import {
  configPath,
  loadConfig,
  saveConfig,
  type ProfileConfig,
  type StoredConfig,
} from "../config/config.js";
import { createContext, type CliContext, type GlobalOptions } from "../context.js";
import { color } from "../output/color.js";
import { printItems, printJson, writeOut, type Column } from "../output/format.js";
import { maskKey } from "./auth.js";

function ctxOf(command: Command): CliContext {
  return createContext(command.optsWithGlobals() as GlobalOptions);
}

const GLOBAL_KEYS = ["base_url", "active_profile"] as const;
type GlobalKey = (typeof GLOBAL_KEYS)[number];

function redact(config: StoredConfig): StoredConfig {
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    profiles[name] = {
      ...profile,
      ...(profile.api_key ? { api_key: maskKey(profile.api_key) } : {}),
    };
  }
  return { ...config, profiles };
}

interface ProfileRow {
  name: string;
  active: string;
  authenticated: string;
  project: string;
  base_url: string;
}

const profileColumns: Column<ProfileRow>[] = [
  { header: "profile", get: (r) => r.name },
  { header: "active", get: (r) => r.active },
  { header: "authenticated", get: (r) => r.authenticated },
  { header: "project", get: (r) => r.project },
  { header: "base_url", get: (r) => r.base_url },
];

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Inspect and edit CLI configuration & profiles");

  config
    .command("path")
    .description("Print the path to the config file")
    .action(() => {
      writeOut(configPath());
    });

  config
    .command("show")
    .aliases(["list", "view"])
    .description("Show the full config (secrets redacted)")
    .action(() => {
      printJson(redact(loadConfig()));
    });

  config
    .command("get <key>")
    .description(`Get a global config value (${GLOBAL_KEYS.join(", ")})`)
    .action((key: string) => {
      assertGlobalKey(key);
      const value = loadConfig()[key as GlobalKey];
      writeOut(value == null ? "" : String(value));
    });

  config
    .command("set <key> <value>")
    .description(`Set a global config value (${GLOBAL_KEYS.join(", ")})`)
    .action((key: string, value: string) => {
      assertGlobalKey(key);
      const cfg = loadConfig();
      (cfg as unknown as Record<string, unknown>)[key] = value;
      saveConfig(cfg);
      writeOut(color.green(`✓ set ${key} = ${value}`));
    });

  config
    .command("unset <key>")
    .description("Remove a global config value")
    .action((key: string) => {
      assertGlobalKey(key);
      const cfg = loadConfig();
      delete (cfg as unknown as Record<string, unknown>)[key];
      saveConfig(cfg);
      writeOut(color.green(`✓ unset ${key}`));
    });

  config
    .command("profiles")
    .description("List configured profiles")
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const cfg = loadConfig();
      const rows: ProfileRow[] = Object.entries(cfg.profiles).map(([name, p]) => ({
        name,
        active: cfg.active_profile === name ? "*" : "",
        authenticated: p.api_key ? "yes" : "no",
        project: p.project_id ?? "",
        base_url: p.base_url ?? cfg.base_url ?? "",
      }));
      printItems(rows, profileColumns, { format: ctx.format, fields: ctx.fields });
    });

  config
    .command("use <profile>")
    .description("Set the active profile")
    .action((profile: string) => {
      const cfg = loadConfig();
      if (!cfg.profiles[profile]) {
        writeOut(color.yellow(`⚠ profile "${profile}" has no stored credentials yet.`));
      }
      cfg.active_profile = profile;
      saveConfig(cfg);
      writeOut(color.green(`✓ active profile → ${profile}`));
    });
}

function assertGlobalKey(key: string): void {
  if (!GLOBAL_KEYS.includes(key as GlobalKey)) {
    throw new OrigamiConfigError(`Unknown config key "${key}". Valid keys: ${GLOBAL_KEYS.join(", ")}.`);
  }
}
