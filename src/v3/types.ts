/** How a parameter or body field's value is parsed from the command line. */
export type V3ValueKind = "string" | "integer" | "number" | "boolean" | "list" | "json";

export interface V3Field {
  name: string;
  required: boolean;
  kind: V3ValueKind;
  /** Allowed values for string fields. */
  enum?: string[];
  /** Element type for `list` fields other than string. */
  itemKind?: "integer" | "number";
  description?: string;
}

export interface V3Param extends V3Field {
  in: "path" | "query";
}

/** One v3 operation, as extracted from the OpenAPI spec by scripts/sync-v3-catalog.mjs. */
export interface V3Operation {
  /** Dotted operation id, e.g. `send.campaigns.launch`. Drives the command path. */
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path template relative to /api/v3, e.g. `/send/campaigns/{campaign_id}/launch`. */
  path: string;
  summary: string;
  tag?: string;
  params: V3Param[];
  /** Top-level JSON body fields (absent when the operation takes no body). */
  body?: V3Field[];
  bodyRequired?: boolean;
  /** The operation answers 202 with a Job. */
  returnsJob?: true;
  /** The operation answers with a `{ object: "list", items, next_cursor }` envelope. */
  paginated?: true;
  docs?: string;
}

/** The shared async Job resource (subset the CLI reads). */
export interface V3Job {
  object: "job";
  id: string;
  operation?: string;
  status: "queued" | "running" | "needs_input" | "succeeded" | "failed" | "cancelled";
  phase?: string | null;
  progress?: unknown;
  next_poll_at?: string | null;
  result?: unknown;
  error?: { code?: string; message?: string } | null;
  needs_input?: unknown;
  [key: string]: unknown;
}

export interface V3List<T = unknown> {
  object: "list";
  items: T[];
  next_cursor: string | null;
  url?: string;
}

export const JOB_TERMINAL = new Set(["succeeded", "failed", "cancelled", "needs_input"]);
