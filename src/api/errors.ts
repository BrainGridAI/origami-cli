/** Base class for every error the CLI raises intentionally. */
export class OrigamiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised for local configuration / usage problems (bad flags, missing key, etc.). */
export class OrigamiConfigError extends OrigamiError {}

/** Raised when authentication material is missing or unusable before a request. */
export class OrigamiAuthError extends OrigamiError {}

/** A forwardable handoff link the caller's user can act on in-app (present on some 4xx). */
export interface Handoff {
  kind?: string;
  url: string;
  label?: string;
}

export interface OrigamiApiErrorInit {
  status: number;
  statusText: string;
  method: string;
  url: string;
  body?: unknown;
  /** Machine code from the response envelope (`code`), e.g. `PROJECT_NOT_FOUND`. */
  code?: string | undefined;
  requestId?: string | undefined;
  retryAfter?: number | undefined;
  handoff?: Handoff | undefined;
  rateLimit?: RateLimitInfo | undefined;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  retryAfter: number | null;
}

/** Raised when the Origami API returns a non-2xx response. */
export class OrigamiApiError extends OrigamiError {
  readonly status: number;
  readonly statusText: string;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfter: number | undefined;
  readonly handoff: Handoff | undefined;
  readonly rateLimit: RateLimitInfo | undefined;

  constructor(init: OrigamiApiErrorInit) {
    super(OrigamiApiError.format(init));
    this.status = init.status;
    this.statusText = init.statusText;
    this.method = init.method;
    this.url = init.url;
    this.body = init.body;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    this.handoff = init.handoff;
    this.rateLimit = init.rateLimit;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  get isConcurrentLimit(): boolean {
    return this.code === "CONCURRENT_LIMIT_EXCEEDED";
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isSubscriptionRequired(): boolean {
    return this.status === 402 || this.code === "SUBSCRIPTION_REQUIRED";
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  private static format(init: OrigamiApiErrorInit): string {
    const detail = extractMessage(init.body);
    const code = init.code ? ` [${init.code}]` : "";
    const base = `Origami API error ${init.status} ${init.statusText}${code} on ${init.method} ${redactUrl(init.url)}`;
    return detail ? `${base}: ${detail}` : base;
  }
}

/** Raised when a request fails at the network layer (DNS, timeout, connection reset). */
export class OrigamiNetworkError extends OrigamiError {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** Pull the machine `code` out of an error body ({ error, code }). */
export function extractCode(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return undefined;
}

/** Pull the forwardable handoff link out of an error body, if present. */
export function extractHandoff(body: unknown): Handoff | undefined {
  if (body && typeof body === "object") {
    const handoff = (body as Record<string, unknown>).handoff;
    if (handoff && typeof handoff === "object") {
      const url = (handoff as Record<string, unknown>).url;
      if (typeof url === "string" && url) {
        const h = handoff as Record<string, unknown>;
        return {
          url,
          ...(typeof h.kind === "string" ? { kind: h.kind } : {}),
          ...(typeof h.label === "string" ? { label: h.label } : {}),
        };
      }
    }
  }
  return undefined;
}

/** Pull a human-readable message out of an arbitrary error body. */
export function extractMessage(body: unknown): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body.trim() || undefined;
  if (typeof body === "object") {
    const record = body as Record<string, unknown>;
    // Origami's canonical envelope leads with `error`.
    for (const key of ["error", "message", "detail", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    if (record.details != null) {
      try {
        return JSON.stringify(record.details);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Strip query strings from URLs so ids/tokens embedded there never reach logs. */
export function redactUrl(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : `${url.slice(0, index)}?…`;
}
