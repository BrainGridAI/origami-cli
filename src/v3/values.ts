import { readFileSync } from "node:fs";

import { OrigamiConfigError } from "../api/errors.js";
import type { V3Field } from "./types.js";

/** Flag name for a field: snake_case → kebab-case (`dry_run` → `dry-run`). */
export function flagName(field: string): string {
  return field.replace(/_/g, "-");
}

/**
 * Read a JSON argument: an inline literal, `@path/to/file.json`, or `-` for stdin.
 * `readStdin` is injectable for tests.
 */
export function parseJsonArg(
  raw: string,
  label: string,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): unknown {
  let text = raw;
  if (raw === "-") text = readStdin();
  else if (raw.startsWith("@")) {
    const path = raw.slice(1);
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      throw new OrigamiConfigError(`--${label}: cannot read ${path} (${(err as Error).message}).`);
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OrigamiConfigError(
      `--${label} must be JSON (inline, @file.json, or - for stdin). Got: ${text.slice(0, 80)}`,
    );
  }
}

function parseNumber(raw: string, field: V3Field, integer: boolean): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    throw new OrigamiConfigError(
      `--${flagName(field.name)} must be ${integer ? "an integer" : "a number"} (got "${raw}").`,
    );
  }
  return n;
}

/**
 * Convert the raw commander value of a flag into the typed value the API expects.
 * Booleans arrive already typed; lists arrive as the array collected by `collectList`.
 */
export function coerceValue(field: V3Field, raw: unknown): unknown {
  if (raw === undefined) return undefined;
  switch (field.kind) {
    case "boolean":
      return Boolean(raw);
    case "integer":
      return parseNumber(String(raw), field, true);
    case "number":
      return parseNumber(String(raw), field, false);
    case "list": {
      const items = (Array.isArray(raw) ? raw : [raw]).map(String);
      if (field.itemKind) return items.map((v) => parseNumber(v, field, field.itemKind === "integer"));
      return items;
    }
    case "json":
      return typeof raw === "string" ? parseJsonArg(raw, flagName(field.name)) : raw;
    case "string":
    default: {
      const value = String(raw);
      if (field.enum && field.enum.length > 0 && !field.enum.includes(value)) {
        throw new OrigamiConfigError(
          `--${flagName(field.name)} must be one of: ${field.enum.join(", ")} (got "${value}").`,
        );
      }
      return value;
    }
  }
}

/** Commander option parser for list flags: repeatable and comma-separated (`--ids a,b --ids c`). */
export function collectList(value: string, previous: string[] | undefined): string[] {
  const parts = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return [...(previous ?? []), ...parts];
}
