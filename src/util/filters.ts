import { OrigamiConfigError } from "../api/errors.js";
import {
  FILTER_OPERATORS,
  type FilterOperator,
  type RowFilter,
  type RowSort,
} from "../api/types.js";

const NO_VALUE_OPERATORS = new Set<FilterOperator>(["is_empty", "is_not_empty"]);

/**
 * Parse a `--filter` token into a RowFilter.
 * Form: `<column> <operator> [value]`, e.g.
 *   "website is_not_empty"
 *   "revenue greater_than 1000000"
 *   "company-name contains Acme"
 */
export function parseFilter(input: string): RowFilter {
  const trimmed = input.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    throw new OrigamiConfigError(
      `Invalid --filter "${input}". Expected "<column> <operator> [value]" (e.g. "website is_not_empty").`,
    );
  }
  const column = trimmed.slice(0, firstSpace);
  const rest = trimmed.slice(firstSpace + 1).trim();

  const secondSpace = rest.indexOf(" ");
  const operatorRaw = (secondSpace === -1 ? rest : rest.slice(0, secondSpace)).toLowerCase();
  const value = secondSpace === -1 ? "" : rest.slice(secondSpace + 1).trim();

  if (!FILTER_OPERATORS.includes(operatorRaw as FilterOperator)) {
    throw new OrigamiConfigError(
      `Invalid filter operator "${operatorRaw}". One of: ${FILTER_OPERATORS.join(", ")}.`,
    );
  }
  const operator = operatorRaw as FilterOperator;

  if (!column) {
    throw new OrigamiConfigError(`Invalid --filter "${input}": missing column slug.`);
  }
  if (!NO_VALUE_OPERATORS.has(operator) && value === "" && secondSpace === -1) {
    throw new OrigamiConfigError(`Filter operator "${operator}" needs a value (e.g. "${column} ${operator} <value>").`);
  }
  return { column, operator, value: coerce(value) };
}

/** Parse a `--sort` token like `revenue:desc` or `company-name`. */
export function parseSort(input: string): RowSort {
  const [column, dirRaw] = input.split(":");
  const col = (column ?? "").trim();
  if (!col) throw new OrigamiConfigError(`Invalid --sort "${input}". Expected "<column>[:asc|desc]".`);
  const direction = (dirRaw ?? "asc").trim().toLowerCase();
  if (direction !== "asc" && direction !== "desc") {
    throw new OrigamiConfigError(`Invalid sort direction "${direction}". Expected "asc" or "desc".`);
  }
  return { column: col, direction };
}

/** Best-effort coerce a filter value: numbers and booleans stay typed, everything else is a string. */
function coerce(value: string): unknown {
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Parse a `--row` JSON object token for upsert. */
export function parseRowJson(input: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new OrigamiConfigError(`Invalid --row JSON: ${(err as Error).message}\n  Got: ${input}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OrigamiConfigError(`--row must be a JSON object of { columnSlug: value }. Got: ${input}`);
  }
  return parsed as Record<string, unknown>;
}

/** Split a comma-separated list flag into trimmed, non-empty tokens. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
