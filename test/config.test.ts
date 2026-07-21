import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configPath,
  deleteProfile,
  emptyConfig,
  loadConfig,
  resolveSettings,
  saveConfig,
  upsertProfile,
} from "../src/config/config.js";

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "origami-cfg-"));
  process.env.ORIGAMI_CONFIG_DIR = dir;
  delete process.env.ORIGAMI_API_KEY;
  delete process.env.ORIGAMI_PROFILE;
  delete process.env.ORIGAMI_BASE_URL;
  delete process.env.ORIGAMI_PROJECT;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("config persistence", () => {
  it("round-trips profiles through disk with 0600 perms", () => {
    const cfg = upsertProfile(emptyConfig(), "work", { api_key: "og_live_abc", project_id: "p1" });
    saveConfig(cfg);
    expect(configPath()).toBe(join(dir, "config.json"));
    const loaded = loadConfig();
    expect(loaded.profiles.work).toEqual({ api_key: "og_live_abc", project_id: "p1" });
    // 0600 = owner read/write only.
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("upsert merges and can clear keys with undefined", () => {
    let cfg = upsertProfile(emptyConfig(), "p", { api_key: "og_live_abc", project_id: "p1" });
    cfg = upsertProfile(cfg, "p", { project_id: undefined });
    expect(cfg.profiles.p).toEqual({ api_key: "og_live_abc" });
  });

  it("deletes a profile and clears the active pointer", () => {
    let cfg = upsertProfile(emptyConfig(), "p", { api_key: "og_live_abc" });
    cfg.active_profile = "p";
    cfg = deleteProfile(cfg, "p");
    expect(cfg.profiles.p).toBeUndefined();
    expect(cfg.active_profile).toBeUndefined();
  });
});

describe("resolveSettings precedence", () => {
  it("prefers the flag key over env and profile", () => {
    process.env.ORIGAMI_API_KEY = "env-key";
    const cfg = upsertProfile(emptyConfig(), "default", { api_key: "profile-key" });
    saveConfig(cfg);
    const s = resolveSettings({ apiKey: "flag-key" });
    expect(s.apiKey).toBe("flag-key");
    expect(s.apiKeySource).toBe("flag");
  });

  it("falls back to env, then profile", () => {
    const cfg = upsertProfile(emptyConfig(), "default", { api_key: "profile-key" });
    saveConfig(cfg);
    process.env.ORIGAMI_API_KEY = "env-key";
    expect(resolveSettings().apiKeySource).toBe("env");
    delete process.env.ORIGAMI_API_KEY;
    const s = resolveSettings();
    expect(s.apiKey).toBe("profile-key");
    expect(s.apiKeySource).toBe("profile");
  });

  it("uses the default base url when unset", () => {
    const s = resolveSettings();
    expect(s.baseUrl).toBe("https://origami.chat/api/v2");
  });

  it("resolves project id from flag > env > profile", () => {
    const cfg = upsertProfile(emptyConfig(), "default", { api_key: "k", project_id: "profile-proj" });
    cfg.active_profile = "default";
    saveConfig(cfg);
    expect(resolveSettings().projectId).toBe("profile-proj");
    process.env.ORIGAMI_PROJECT = "env-proj";
    expect(resolveSettings().projectId).toBe("env-proj");
    expect(resolveSettings({ project: "flag-proj" }).projectId).toBe("flag-proj");
  });
});
