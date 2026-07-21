import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { OrigamiConfigError } from "../api/errors.js";
import { DEFAULT_BASE_URL } from "../api/types.js";

export interface ProfileConfig {
  api_key?: string;
  /** Default project (child org) id scoped onto requests via x-origami-project. */
  project_id?: string;
  base_url?: string;
}

export interface StoredConfig {
  version: 1;
  active_profile?: string;
  base_url?: string;
  profiles: Record<string, ProfileConfig>;
}

export const DEFAULT_PROFILE = "default";

export function configDir(): string {
  const override = process.env.ORIGAMI_CONFIG_DIR;
  if (override && override.trim()) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return join(xdg, "origami");
  return join(homedir(), ".config", "origami");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function emptyConfig(): StoredConfig {
  return { version: 1, profiles: {} };
}

export function loadConfig(): StoredConfig {
  const path = configPath();
  if (!existsSync(path)) return emptyConfig();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new OrigamiConfigError(`Failed to read config at ${path}: ${(err as Error).message}`);
  }
  if (!raw.trim()) return emptyConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OrigamiConfigError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const config = parsed as Partial<StoredConfig>;
  return {
    version: 1,
    active_profile: config.active_profile,
    base_url: config.base_url,
    profiles: config.profiles ?? {},
  };
}

export function saveConfig(config: StoredConfig): void {
  const dir = configDir();
  const path = configPath();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = join(dirname(path), `.config.${process.pid}.tmp`);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(tmp, serialized, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX permissions.
  }
}

export function getProfile(config: StoredConfig, name: string): ProfileConfig | undefined {
  return config.profiles[name];
}

export function upsertProfile(
  config: StoredConfig,
  name: string,
  patch: Partial<ProfileConfig>,
): StoredConfig {
  const existing = config.profiles[name] ?? {};
  const merged: ProfileConfig = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete (merged as Record<string, unknown>)[key];
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return {
    ...config,
    profiles: { ...config.profiles, [name]: merged },
  };
}

export function deleteProfile(config: StoredConfig, name: string): StoredConfig {
  const profiles = { ...config.profiles };
  delete profiles[name];
  const next: StoredConfig = { ...config, profiles };
  if (config.active_profile === name) delete next.active_profile;
  return next;
}

// ---------------------------------------------------------------------------
// Effective settings resolution (flags > env > profile > global config > default)
// ---------------------------------------------------------------------------

export interface ResolveInput {
  apiKey?: string | undefined;
  project?: string | undefined;
  baseUrl?: string | undefined;
  profile?: string | undefined;
  /** Pre-loaded config; loaded on demand when omitted. */
  config?: StoredConfig;
}

export type KeySource = "flag" | "env" | "profile" | "none";

export interface ResolvedSettings {
  apiKey: string | undefined;
  apiKeySource: KeySource;
  projectId: string | undefined;
  baseUrl: string;
  profileName: string;
  profile: ProfileConfig | undefined;
  config: StoredConfig;
}

export function resolveSettings(input: ResolveInput = {}): ResolvedSettings {
  const config = input.config ?? loadConfig();
  const profileName =
    input.profile ??
    process.env.ORIGAMI_PROFILE ??
    config.active_profile ??
    DEFAULT_PROFILE;
  const profile = config.profiles[profileName];

  const envKey = process.env.ORIGAMI_API_KEY?.trim() || undefined;

  let apiKey: string | undefined;
  let apiKeySource: KeySource = "none";
  if (input.apiKey) {
    apiKey = input.apiKey;
    apiKeySource = "flag";
  } else if (envKey) {
    apiKey = envKey;
    apiKeySource = "env";
  } else if (profile?.api_key) {
    apiKey = profile.api_key;
    apiKeySource = "profile";
  }

  const projectId =
    input.project ??
    process.env.ORIGAMI_PROJECT?.trim() ??
    profile?.project_id ??
    undefined;

  const baseUrl =
    input.baseUrl ??
    process.env.ORIGAMI_BASE_URL?.trim() ??
    profile?.base_url ??
    config.base_url ??
    DEFAULT_BASE_URL;

  return { apiKey, apiKeySource, projectId, baseUrl, profileName, profile, config };
}
