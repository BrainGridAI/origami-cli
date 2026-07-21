import { color } from "./color.js";

export interface TableOptions {
  /** Truncate any cell longer than this many characters (0 = no limit). */
  maxColWidth?: number;
}

/** Visible width of a string, ignoring ANSI escape sequences. */
function displayWidth(input: string): number {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\[[0-9;]*m/g, "").length;
}

function truncateCell(input: string, maxWidth: number): string {
  if (maxWidth <= 0 || input.length <= maxWidth) return input;
  if (maxWidth <= 1) return input.slice(0, maxWidth);
  return `${input.slice(0, maxWidth - 1)}…`;
}

function padEnd(input: string, width: number): string {
  const pad = width - displayWidth(input);
  return pad > 0 ? input + " ".repeat(pad) : input;
}

/** Render an aligned text table with a bold header row. */
export function renderTable(headers: string[], rows: string[][], options: TableOptions = {}): string {
  const maxColWidth = options.maxColWidth ?? 0;
  const normalizedRows = rows.map((row) =>
    headers.map((_, i) => truncateCell(String(row[i] ?? ""), maxColWidth)),
  );
  const normalizedHeaders = headers.map((h) => truncateCell(h, maxColWidth));

  const widths = normalizedHeaders.map((header, i) => {
    let width = displayWidth(header);
    for (const row of normalizedRows) {
      width = Math.max(width, displayWidth(row[i] ?? ""));
    }
    return width;
  });

  const lines: string[] = [];
  lines.push(
    normalizedHeaders.map((header, i) => color.bold(padEnd(header, widths[i] ?? 0))).join("  "),
  );
  for (const row of normalizedRows) {
    lines.push(row.map((cell, i) => padEnd(cell, widths[i] ?? 0)).join("  "));
  }
  return lines.join("\n");
}
