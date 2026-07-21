import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { OrigamiConfigError } from "../api/errors.js";

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

/** Read a file and return its bytes base64-encoded (for the upload/upsert-file endpoints). */
export function readFileBase64(path: string): string {
  try {
    return readFileSync(path).toString("base64");
  } catch (err) {
    throw new OrigamiConfigError(`Failed to read file "${path}": ${(err as Error).message}`);
  }
}

/** Read a file as UTF-8 text. */
export function readFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new OrigamiConfigError(`Failed to read file "${path}": ${(err as Error).message}`);
  }
}

export function fileName(path: string): string {
  return basename(path);
}
