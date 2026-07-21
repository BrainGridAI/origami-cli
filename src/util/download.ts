import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { OrigamiError } from "../api/errors.js";

export interface DownloadProgress {
  bytes: number;
  total: number | null;
}

/**
 * Stream an HTTP response body to a file on disk, reporting progress.
 * Returns the total number of bytes written.
 */
export async function streamResponseToFile(
  response: Response,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<number> {
  if (!response.body) {
    throw new OrigamiError("Response had no body to download.");
  }
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader != null && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : null;

  let bytes = 0;
  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  source.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    onProgress?.({ bytes, total });
  });

  // Stream to a temp file and rename on success so an interrupted transfer never
  // leaves a truncated file that a later run would treat as complete.
  const tmpPath = `${destPath}.part`;
  const dest = createWriteStream(tmpPath);
  try {
    await pipeline(source, dest);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  await rename(tmpPath, destPath);
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
