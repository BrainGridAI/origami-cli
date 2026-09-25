import {
  OrigamiApiError,
  OrigamiNetworkError,
  extractCode,
  extractHandoff,
  type RateLimitInfo,
} from "./errors.js";
import {
  DEFAULT_BASE_URL,
  isTerminalStatus,
  type Account,
  type Agent,
  type Campaign,
  type CampaignAgenticResponse,
  type CampaignPerson,
  type CampaignStats,
  type CampaignSummary,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type CreateProjectRequest,
  type CreateScheduledAgentRequest,
  type Credits,
  type DocumentDetail,
  type DocumentSummary,
  type EnrichmentRun,
  type EnrichmentRunDetail,
  type ListCampaignPeopleParams,
  type ListEnvelope,
  type ListParams,
  type ListRowsParams,
  type ListScheduledAgentsParams,
  type ListSequencesParams,
  type Project,
  type Row,
  type Run,
  type RunInclude,
  type RunSummary,
  type ScheduledAgent,
  type SendRunRequest,
  type SendRunResponse,
  type SequenceDetail,
  type SequenceSummary,
  type Table,
  type UpdateProjectRequest,
  type UpdateScheduledAgentRequest,
  type UploadFilesRequest,
  type UploadFilesResponse,
  type UpsertReceipt,
  type UpsertRowsFileRequest,
  type UpsertRowsRequest,
  type Workspace,
  type WorkspaceColumn,
} from "./types.js";

export type FetchLike = typeof globalThis.fetch;

export interface DebugEvent {
  phase: "request" | "response" | "retry" | "error";
  method: string;
  url: string;
  attempt: number;
  status?: number;
  durationMs?: number;
  message?: string;
}

export interface OrigamiClientOptions {
  /** API key (og_live_…). Required for all v2 endpoints. */
  apiKey?: string | undefined;
  /** API base URL. Defaults to https://origami.chat/api/v2. */
  baseUrl?: string | undefined;
  /** Project (child org) id sent as x-origami-project on org-scoped requests. */
  projectId?: string | undefined;
  /** Max automatic retries on 429 / 5xx / network errors. Default 3. Set 0 to disable. */
  maxRetries?: number | undefined;
  /** Per-request timeout in ms. Default 60000. */
  timeoutMs?: number | undefined;
  /** Injectable fetch (for testing). Defaults to global fetch. */
  fetch?: FetchLike | undefined;
  /** User-Agent header value. */
  userAgent?: string | undefined;
  /** Called with structured events when debug logging is enabled. */
  onDebug?: ((event: DebugEvent) => void) | undefined;
  /** Called before sleeping on a retry (e.g. to print a "waiting" notice). */
  onRetry?: ((info: { attempt: number; delayMs: number; status?: number; reason: string }) => void) | undefined;
  /** Injectable sleep (for testing). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export type V3QueryValue = string | number | boolean | Array<string | number> | undefined;

export interface V3Request {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path relative to /api/v3, already filled in (e.g. `/send/campaigns/abc/launch`). */
  path: string;
  query?: Record<string, V3QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Idempotency key for POSTs; a UUID is generated when omitted. */
  idempotencyKey?: string | undefined;
  /** Send x-origami-project when a project is configured. Default true. */
  project?: boolean;
  signal?: AbortSignal | undefined;
}

export interface V3Response {
  status: number;
  /** Parsed JSON body, when the response was JSON. */
  data: unknown;
  /** Raw body, when the response was not JSON (e.g. CSV). */
  text?: string;
  contentType: string;
  retryAfterMs: number | undefined;
}

interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, V3QueryValue>;
  body?: unknown;
  /** Send Authorization header. Default true. */
  auth?: boolean;
  /** Send x-origami-project header when a projectId is set. Default true. `/projects` + `/account` pass false. */
  project?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
}

interface JsonWithMeta<T> {
  data: T;
  retryAfterMs: number | undefined;
}

export interface WaitForRunOptions {
  include?: RunInclude[] | undefined;
  /** Overall poll ceiling in ms. Default 15 minutes. */
  timeoutMs?: number | undefined;
  /** Called after each poll with the latest run (still `running` or terminal). */
  onPoll?: ((run: Run) => void) | undefined;
  signal?: AbortSignal | undefined;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function includeParam(include?: RunInclude[]): string | undefined {
  return include && include.length > 0 ? include.join(",") : undefined;
}

/**
 * Typed HTTP client for the Origami Public API v2.
 *
 * Handles auth + project headers, JSON encoding, automatic retry/backoff on rate
 * limits and transient failures, request timeouts, cursor-based pagination, and
 * the async run-poll loop (`waitForRun`, honoring the `Retry-After` header).
 */
export class OrigamiClient {
  readonly baseUrl: string;
  readonly projectId: string | undefined;
  readonly maxRetries: number;
  readonly timeoutMs: number;

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly onDebug: OrigamiClientOptions["onDebug"];
  private readonly onRetry: OrigamiClientOptions["onRetry"];
  private readonly sleep: (ms: number) => Promise<void>;

  private _lastRateLimit: RateLimitInfo | undefined;

  constructor(options: OrigamiClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.projectId = options.projectId;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "origami-cli";
    this.onDebug = options.onDebug;
    this.onRetry = options.onRetry;
    this.sleep = options.sleep ?? defaultSleep;

    if (typeof this.fetchImpl !== "function") {
      throw new OrigamiNetworkError(
        "global fetch is not available; upgrade to Node 18+ or pass a fetch implementation",
        undefined,
      );
    }
  }

  /** Rate-limit info parsed from the most recent response, if any. */
  get lastRateLimit(): RateLimitInfo | undefined {
    return this._lastRateLimit;
  }

  // -------------------------------------------------------------------------
  // Agents & runs
  // -------------------------------------------------------------------------

  createAgent(request: CreateAgentRequest): Promise<CreateAgentResponse> {
    return this.requestJson<CreateAgentResponse>({ method: "POST", path: "/agents", body: request });
  }

  listAgents(params: ListParams & { search?: string } = {}): Promise<ListEnvelope<Agent>> {
    return this.requestJson<ListEnvelope<Agent>>({
      method: "GET",
      path: "/agents",
      query: { cursor: params.cursor, limit: params.limit, search: params.search },
    });
  }

  getAgent(agentId: string): Promise<Agent> {
    return this.requestJson<Agent>({ method: "GET", path: `/agents/${enc(agentId)}` });
  }

  archiveAgent(agentId: string): Promise<unknown> {
    return this.requestJson<unknown>({ method: "DELETE", path: `/agents/${enc(agentId)}` });
  }

  listAgentTables(agentId: string): Promise<ListEnvelope<Table>> {
    return this.requestJson<ListEnvelope<Table>>({ method: "GET", path: `/agents/${enc(agentId)}/tables` });
  }

  sendRun(agentId: string, request: SendRunRequest): Promise<SendRunResponse> {
    return this.requestJson<SendRunResponse>({
      method: "POST",
      path: `/agents/${enc(agentId)}/runs`,
      body: request,
    });
  }

  listRuns(agentId: string, params: ListParams = {}): Promise<ListEnvelope<RunSummary>> {
    return this.requestJson<ListEnvelope<RunSummary>>({
      method: "GET",
      path: `/agents/${enc(agentId)}/runs`,
      query: { cursor: params.cursor, limit: params.limit },
    });
  }

  getRun(agentId: string, runId: string, include?: RunInclude[]): Promise<Run> {
    return this.getRunWithMeta(agentId, runId, include).then((r) => r.data);
  }

  cancelRun(agentId: string): Promise<unknown> {
    return this.requestJson<unknown>({ method: "POST", path: `/agents/${enc(agentId)}/cancel` });
  }

  /**
   * Poll a run until it reaches a terminal status, honoring the `Retry-After`
   * header (default 15s). Returns the terminal run object.
   */
  async waitForRun(agentId: string, runId: string, options: WaitForRunOptions = {}): Promise<Run> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (options.signal?.aborted) throw new OrigamiNetworkError("Aborted while waiting for run.", undefined);
      const { data: run, retryAfterMs } = await this.getRunWithMeta(agentId, runId, options.include);
      options.onPoll?.(run);
      if (isTerminalStatus(run.status)) return run;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new OrigamiNetworkError(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for run ${runId} (still running).`,
          undefined,
        );
      }
      const wait = Math.min(retryAfterMs ?? DEFAULT_POLL_INTERVAL_MS, remaining);
      await this.sleep(wait);
    }
  }

  private async getRunWithMeta(agentId: string, runId: string, include?: RunInclude[]): Promise<JsonWithMeta<Run>> {
    return this.requestJsonWithMeta<Run>({
      method: "GET",
      path: `/agents/${enc(agentId)}/runs/${enc(runId)}`,
      query: { include: includeParam(include) },
    });
  }

  // -------------------------------------------------------------------------
  // Workspaces & documents
  // -------------------------------------------------------------------------

  listWorkspaces(params: ListParams & { search?: string } = {}): Promise<ListEnvelope<Workspace>> {
    return this.requestJson<ListEnvelope<Workspace>>({
      method: "GET",
      path: "/workspaces",
      query: { cursor: params.cursor, limit: params.limit, search: params.search },
    });
  }

  createWorkspace(name?: string): Promise<Workspace> {
    return this.requestJson<Workspace>({ method: "POST", path: "/workspaces", body: name ? { name } : {} });
  }

  getWorkspace(workspaceId: string): Promise<Workspace> {
    return this.requestJson<Workspace>({ method: "GET", path: `/workspaces/${enc(workspaceId)}` });
  }

  deleteWorkspace(workspaceId: string, confirm: boolean): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "DELETE",
      path: `/workspaces/${enc(workspaceId)}`,
      query: { confirm: confirm ? "true" : undefined },
    });
  }

  listDocuments(workspaceId: string, params: ListParams = {}): Promise<ListEnvelope<DocumentSummary>> {
    return this.requestJson<ListEnvelope<DocumentSummary>>({
      method: "GET",
      path: `/workspaces/${enc(workspaceId)}/documents`,
      query: { cursor: params.cursor, limit: params.limit },
    });
  }

  uploadDocuments(workspaceId: string, request: UploadFilesRequest): Promise<UploadFilesResponse> {
    return this.requestJson<UploadFilesResponse>({
      method: "POST",
      path: `/workspaces/${enc(workspaceId)}/documents`,
      body: request,
    });
  }

  getDocument(workspaceId: string, documentId: string): Promise<DocumentDetail> {
    return this.requestJson<DocumentDetail>({
      method: "GET",
      path: `/workspaces/${enc(workspaceId)}/documents/${enc(documentId)}`,
    });
  }

  renameDocument(workspaceId: string, documentId: string, name: string): Promise<DocumentSummary> {
    return this.requestJson<DocumentSummary>({
      method: "PATCH",
      path: `/workspaces/${enc(workspaceId)}/documents/${enc(documentId)}`,
      body: { name },
    });
  }

  deleteDocument(workspaceId: string, documentId: string): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "DELETE",
      path: `/workspaces/${enc(workspaceId)}/documents/${enc(documentId)}`,
    });
  }

  // -------------------------------------------------------------------------
  // Tables, columns, rows
  // -------------------------------------------------------------------------

  listTables(params: ListParams & { workspaceId?: string } = {}): Promise<ListEnvelope<Table>> {
    return this.requestJson<ListEnvelope<Table>>({
      method: "GET",
      path: "/tables",
      query: { cursor: params.cursor, limit: params.limit, workspaceId: params.workspaceId },
    });
  }

  getTable(tableId: string, include?: Array<"stats">): Promise<Table> {
    return this.requestJson<Table>({
      method: "GET",
      path: `/tables/${enc(tableId)}`,
      query: { include: include && include.length ? include.join(",") : undefined },
    });
  }

  listColumns(tableId: string): Promise<ListEnvelope<WorkspaceColumn>> {
    return this.requestJson<ListEnvelope<WorkspaceColumn>>({
      method: "GET",
      path: `/tables/${enc(tableId)}/columns`,
    });
  }

  listRows(tableId: string, params: ListRowsParams = {}): Promise<ListEnvelope<Row>> {
    return this.requestJson<ListEnvelope<Row>>({
      method: "GET",
      path: `/tables/${enc(tableId)}/rows`,
      query: this.rowQuery(params),
    });
  }

  /** Fetch rows as a CSV string (`format=csv`). */
  async getRowsCsv(tableId: string, params: ListRowsParams = {}): Promise<string> {
    const res = await this.requestRaw({
      method: "GET",
      path: `/tables/${enc(tableId)}/rows`,
      query: { ...this.rowQuery(params), format: "csv" },
      headers: { accept: "text/csv" },
    });
    return res.text();
  }

  private rowQuery(params: ListRowsParams): RequestOptions["query"] {
    return {
      cursor: params.cursor,
      limit: params.limit,
      filters: params.filters && params.filters.length ? JSON.stringify(params.filters) : undefined,
      sort: params.sort ? JSON.stringify(params.sort) : undefined,
      cells: params.flat ? "flat" : undefined,
      defaults: params.defaults === false ? "false" : undefined,
    };
  }

  getRow(tableId: string, rowId: string): Promise<Row> {
    return this.requestJson<Row>({ method: "GET", path: `/tables/${enc(tableId)}/rows/${enc(rowId)}` });
  }

  getCell(tableId: string, rowId: string, columnId: string): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "GET",
      path: `/tables/${enc(tableId)}/rows/${enc(rowId)}/cells/${enc(columnId)}`,
    });
  }

  upsertRows(tableId: string, request: UpsertRowsRequest): Promise<UpsertReceipt> {
    return this.requestJson<UpsertReceipt>({
      method: "POST",
      path: `/tables/${enc(tableId)}/rows/upsert`,
      body: request,
    });
  }

  upsertRowsFromFile(tableId: string, request: UpsertRowsFileRequest): Promise<UpsertReceipt> {
    return this.requestJson<UpsertReceipt>({
      method: "POST",
      path: `/tables/${enc(tableId)}/rows/upsert-file`,
      body: request,
    });
  }

  // -------------------------------------------------------------------------
  // Enrichment runs
  // -------------------------------------------------------------------------

  listEnrichmentRuns(params: ListParams & { tableId?: string } = {}): Promise<ListEnvelope<EnrichmentRun>> {
    return this.requestJson<ListEnvelope<EnrichmentRun>>({
      method: "GET",
      path: "/enrichment-runs",
      query: { cursor: params.cursor, limit: params.limit, tableId: params.tableId },
    });
  }

  listTableEnrichmentRuns(tableId: string, params: ListParams = {}): Promise<ListEnvelope<EnrichmentRun>> {
    return this.requestJson<ListEnvelope<EnrichmentRun>>({
      method: "GET",
      path: `/tables/${enc(tableId)}/enrichment-runs`,
      query: { cursor: params.cursor, limit: params.limit },
    });
  }

  getEnrichmentRun(runId: string): Promise<EnrichmentRunDetail> {
    return this.requestJson<EnrichmentRunDetail>({ method: "GET", path: `/enrichment-runs/${enc(runId)}` });
  }

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------

  listWorkspaceCampaigns(workspaceId: string): Promise<ListEnvelope<CampaignSummary>> {
    return this.requestJson<ListEnvelope<CampaignSummary>>({
      method: "GET",
      path: `/workspaces/${enc(workspaceId)}/campaigns`,
    });
  }

  listTableCampaigns(tableId: string): Promise<ListEnvelope<CampaignSummary>> {
    return this.requestJson<ListEnvelope<CampaignSummary>>({
      method: "GET",
      path: `/tables/${enc(tableId)}/campaigns`,
    });
  }

  createCampaign(tableId: string, instructions: string): Promise<CampaignAgenticResponse> {
    return this.requestJson<CampaignAgenticResponse>({
      method: "POST",
      path: `/tables/${enc(tableId)}/campaigns`,
      body: { instructions },
    });
  }

  getCampaign(campaignId: string): Promise<Campaign> {
    return this.requestJson<Campaign>({ method: "GET", path: `/campaigns/${enc(campaignId)}` });
  }

  getCampaignStats(campaignId: string): Promise<CampaignStats> {
    return this.requestJson<CampaignStats>({ method: "GET", path: `/campaigns/${enc(campaignId)}/stats` });
  }

  listCampaignPeople(
    campaignId: string,
    params: ListCampaignPeopleParams = {},
  ): Promise<ListEnvelope<CampaignPerson>> {
    return this.requestJson<ListEnvelope<CampaignPerson>>({
      method: "GET",
      path: `/campaigns/${enc(campaignId)}/people`,
      query: { cursor: params.cursor, limit: params.limit, search: params.search, status: params.status },
    });
  }

  editCampaign(campaignId: string, instructions: string): Promise<CampaignAgenticResponse> {
    return this.requestJson<CampaignAgenticResponse>({
      method: "POST",
      path: `/campaigns/${enc(campaignId)}/edits`,
      body: { instructions },
    });
  }

  launchCampaign(campaignId: string, dryRun = false): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "POST",
      path: `/campaigns/${enc(campaignId)}/launch`,
      query: { dryRun: dryRun ? "true" : undefined },
    });
  }

  pauseCampaign(campaignId: string, dryRun = false): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "POST",
      path: `/campaigns/${enc(campaignId)}/pause`,
      query: { dryRun: dryRun ? "true" : undefined },
    });
  }

  resumeCampaign(campaignId: string, dryRun = false): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "POST",
      path: `/campaigns/${enc(campaignId)}/resume`,
      query: { dryRun: dryRun ? "true" : undefined },
    });
  }

  deleteCampaign(campaignId: string, opts: { confirm?: boolean; dryRun?: boolean } = {}): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "DELETE",
      path: `/campaigns/${enc(campaignId)}`,
      query: { confirm: opts.confirm ? "true" : undefined, dryRun: opts.dryRun ? "true" : undefined },
    });
  }

  // -------------------------------------------------------------------------
  // Sequences
  // -------------------------------------------------------------------------

  listSequences(params: ListSequencesParams): Promise<ListEnvelope<SequenceSummary>> {
    return this.requestJson<ListEnvelope<SequenceSummary>>({
      method: "GET",
      path: "/sequences",
      query: {
        cursor: params.cursor,
        limit: params.limit,
        workspaceId: params.workspaceId,
        tableId: params.tableId,
        columnId: params.columnId,
        status: params.status,
        channel: params.channel,
        recipient: params.recipient,
      },
    });
  }

  listTableSequences(
    tableId: string,
    params: Omit<ListSequencesParams, "workspaceId" | "tableId" | "columnId"> = {},
  ): Promise<ListEnvelope<SequenceSummary>> {
    return this.requestJson<ListEnvelope<SequenceSummary>>({
      method: "GET",
      path: `/tables/${enc(tableId)}/sequences`,
      query: {
        cursor: params.cursor,
        limit: params.limit,
        status: params.status,
        channel: params.channel,
        recipient: params.recipient,
      },
    });
  }

  getSequence(sequenceId: string): Promise<SequenceDetail> {
    return this.requestJson<SequenceDetail>({ method: "GET", path: `/sequences/${enc(sequenceId)}` });
  }

  stopSequence(sequenceId: string, dryRun = false): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "POST",
      path: `/sequences/${enc(sequenceId)}/stop`,
      query: { dryRun: dryRun ? "true" : undefined },
    });
  }

  deleteSequence(sequenceId: string, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "DELETE",
      path: `/sequences/${enc(sequenceId)}`,
      query: { force: opts.force ? "true" : undefined, dryRun: opts.dryRun ? "true" : undefined },
    });
  }

  // -------------------------------------------------------------------------
  // Scheduled agents
  // -------------------------------------------------------------------------

  listScheduledAgents(params: ListScheduledAgentsParams = {}): Promise<ListEnvelope<ScheduledAgent>> {
    return this.requestJson<ListEnvelope<ScheduledAgent>>({
      method: "GET",
      path: "/scheduled-agents",
      query: {
        cursor: params.cursor,
        limit: params.limit,
        workspaceId: params.workspaceId,
        enabled: params.enabled,
      },
    });
  }

  createScheduledAgent(request: CreateScheduledAgentRequest): Promise<ScheduledAgent> {
    return this.requestJson<ScheduledAgent>({ method: "POST", path: "/scheduled-agents", body: request });
  }

  getScheduledAgent(id: string): Promise<ScheduledAgent> {
    return this.requestJson<ScheduledAgent>({ method: "GET", path: `/scheduled-agents/${enc(id)}` });
  }

  updateScheduledAgent(id: string, request: UpdateScheduledAgentRequest): Promise<ScheduledAgent> {
    return this.requestJson<ScheduledAgent>({ method: "PATCH", path: `/scheduled-agents/${enc(id)}`, body: request });
  }

  deleteScheduledAgent(id: string): Promise<unknown> {
    return this.requestJson<unknown>({ method: "DELETE", path: `/scheduled-agents/${enc(id)}` });
  }

  enableScheduledAgent(id: string): Promise<ScheduledAgent> {
    return this.requestJson<ScheduledAgent>({ method: "POST", path: `/scheduled-agents/${enc(id)}/enable` });
  }

  disableScheduledAgent(id: string): Promise<ScheduledAgent> {
    return this.requestJson<ScheduledAgent>({ method: "POST", path: `/scheduled-agents/${enc(id)}/disable` });
  }

  triggerScheduledAgent(id: string): Promise<{ runId: string }> {
    return this.requestJson<{ runId: string }>({ method: "POST", path: `/scheduled-agents/${enc(id)}/trigger` });
  }

  listScheduledAgentRuns(id: string): Promise<ListEnvelope<Record<string, unknown>>> {
    return this.requestJson<ListEnvelope<Record<string, unknown>>>({
      method: "GET",
      path: `/scheduled-agents/${enc(id)}/runs`,
    });
  }

  // -------------------------------------------------------------------------
  // Projects (parent-scoped; never send x-origami-project)
  // -------------------------------------------------------------------------

  listProjects(params: ListParams & { search?: string } = {}): Promise<ListEnvelope<Project>> {
    return this.requestJson<ListEnvelope<Project>>({
      method: "GET",
      path: "/projects",
      project: false,
      query: { cursor: params.cursor, limit: params.limit, search: params.search },
    });
  }

  createProject(request: CreateProjectRequest): Promise<Project> {
    return this.requestJson<Project>({ method: "POST", path: "/projects", project: false, body: request });
  }

  getProject(projectId: string): Promise<Project> {
    return this.requestJson<Project>({ method: "GET", path: `/projects/${enc(projectId)}`, project: false });
  }

  updateProject(projectId: string, request: UpdateProjectRequest): Promise<Project> {
    return this.requestJson<Project>({
      method: "PATCH",
      path: `/projects/${enc(projectId)}`,
      project: false,
      body: request,
    });
  }

  deleteProject(projectId: string, opts: { confirm?: boolean; dryRun?: boolean } = {}): Promise<unknown> {
    return this.requestJson<unknown>({
      method: "DELETE",
      path: `/projects/${enc(projectId)}`,
      project: false,
      query: { confirm: opts.confirm ? "true" : undefined, dryRun: opts.dryRun ? "true" : undefined },
    });
  }

  // -------------------------------------------------------------------------
  // Account (always parent-scoped)
  // -------------------------------------------------------------------------

  getAccount(): Promise<Account> {
    return this.requestJson<Account>({ method: "GET", path: "/account", project: false });
  }

  getCredits(): Promise<Credits> {
    return this.requestJson<Credits>({ method: "GET", path: "/account/credits", project: false });
  }

  // -------------------------------------------------------------------------
  // v3 (named operations; see src/v3)
  // -------------------------------------------------------------------------

  /** Base URL of the v3 API, derived from the configured base (`…/api/v2` → `…/api/v3`). */
  get v3BaseUrl(): string {
    return `${this.baseUrl.replace(/\/api\/v\d+$/, "")}/api/v3`;
  }

  /**
   * Send one v3 request. JSON responses are parsed; anything else (e.g. `format=csv`
   * row exports) comes back as text. Every POST carries an `Idempotency-Key` (the
   * caller's, or a fresh UUID) that is reused across automatic retries, so a retried
   * send or launch never runs twice.
   */
  async requestV3(request: V3Request): Promise<V3Response> {
    const headers: Record<string, string> = { ...request.headers };
    if (request.method === "POST" && !Object.keys(headers).some((h) => h.toLowerCase() === "idempotency-key")) {
      headers["idempotency-key"] = request.idempotencyKey ?? crypto.randomUUID();
    }
    const options: RequestOptions = {
      method: request.method,
      path: this.v3BaseUrl + request.path,
      query: request.query,
      body: request.body,
      headers,
      project: request.project,
      signal: request.signal,
    };
    const res = await this.send(options);
    const retryAfterMs = retryAfterFromHeaders(res.headers);
    if (!res.ok) throw await this.toApiError(options, res);
    const contentType = res.headers.get("content-type") ?? "";
    const text = res.status === 204 ? "" : await res.text();
    if (!text) return { status: res.status, data: undefined, contentType, retryAfterMs };
    if (contentType.includes("json") || /^[[{]/.test(text.trim())) {
      try {
        return { status: res.status, data: JSON.parse(text) as unknown, contentType, retryAfterMs };
      } catch {
        // fall through to text
      }
    }
    return { status: res.status, data: undefined, text, contentType, retryAfterMs };
  }

  // -------------------------------------------------------------------------
  // Pagination helpers
  // -------------------------------------------------------------------------

  /** Lazily iterate every item of a list endpoint, following `nextCursor`. */
  async *iterate<T>(
    fetchPage: (cursor: string | undefined) => Promise<ListEnvelope<T>>,
    startCursor?: string,
  ): AsyncGenerator<T, void, undefined> {
    let cursor = startCursor;
    do {
      const page = await fetchPage(cursor);
      for (const item of page.items) yield item;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** Collect items across pages, optionally stopping after `limit` items. */
  async collect<T>(
    fetchPage: (cursor: string | undefined) => Promise<ListEnvelope<T>>,
    limit?: number,
    startCursor?: string,
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.iterate(fetchPage, startCursor)) {
      out.push(item);
      if (limit != null && out.length >= limit) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Core request machinery
  // -------------------------------------------------------------------------

  private async requestJson<T>(options: RequestOptions): Promise<T> {
    return (await this.requestJsonWithMeta<T>(options)).data;
  }

  private async requestJsonWithMeta<T>(options: RequestOptions): Promise<JsonWithMeta<T>> {
    const res = await this.send(options);
    const retryAfterMs = retryAfterFromHeaders(res.headers);
    if (!res.ok) throw await this.toApiError(options, res);
    if (res.status === 204) return { data: undefined as T, retryAfterMs };
    const text = await res.text();
    if (!text) return { data: undefined as T, retryAfterMs };
    try {
      return { data: JSON.parse(text) as T, retryAfterMs };
    } catch {
      throw new OrigamiApiError({
        status: res.status,
        statusText: res.statusText,
        method: options.method,
        url: this.baseUrl + options.path,
        body: `Expected JSON response but got: ${text.slice(0, 200)}`,
        rateLimit: this._lastRateLimit,
      });
    }
  }

  private async requestRaw(options: RequestOptions): Promise<Response> {
    const res = await this.send(options);
    if (!res.ok) throw await this.toApiError(options, res);
    return res;
  }

  private async send(options: RequestOptions): Promise<Response> {
    const url = this.buildUrl(options.path, options.query);
    const headers = this.buildHeaders(options);
    const hasBody = options.body !== undefined && options.method !== "GET" && options.method !== "HEAD";
    const bodyText = hasBody ? JSON.stringify(options.body) : undefined;

    let attempt = 0;
    // Total tries = maxRetries + 1.
    for (;;) {
      const start = Date.now();
      this.debug({ phase: "request", method: options.method, url, attempt });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
      const onExternalAbort = () => controller.abort((options.signal as AbortSignal).reason);
      if (options.signal) {
        if (options.signal.aborted) controller.abort(options.signal.reason);
        else options.signal.addEventListener("abort", onExternalAbort, { once: true });
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: options.method,
          headers,
          body: bodyText,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onExternalAbort);
        if (options.signal?.aborted) throw new OrigamiNetworkError("Request aborted", err);
        const isTimeout = controller.signal.aborted;
        this.debug({ phase: "error", method: options.method, url, attempt, message: describeError(err) });
        if (attempt < this.maxRetries) {
          const delayMs = backoffDelay(attempt);
          this.onRetry?.({ attempt: attempt + 1, delayMs, reason: isTimeout ? "timeout" : "network error" });
          await this.sleep(delayMs);
          attempt += 1;
          continue;
        }
        throw new OrigamiNetworkError(
          `${isTimeout ? "Request timed out" : "Network request failed"}: ${describeError(err)}`,
          err,
        );
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onExternalAbort);
      }

      this._lastRateLimit = parseRateLimit(res.headers);
      this.debug({
        phase: "response",
        method: options.method,
        url,
        attempt,
        status: res.status,
        durationMs: Date.now() - start,
      });

      if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
        const retryAfterMs = res.status === 429 ? retryAfterFromHeaders(res.headers) : undefined;
        const delayMs = retryAfterMs ?? backoffDelay(attempt);
        this.onRetry?.({
          attempt: attempt + 1,
          delayMs,
          status: res.status,
          reason: res.status === 429 ? "rate limited" : `server error ${res.status}`,
        });
        this.debug({ phase: "retry", method: options.method, url, attempt, status: res.status });
        await res.arrayBuffer().catch(() => undefined);
        await this.sleep(delayMs);
        attempt += 1;
        continue;
      }

      return res;
    }
  }

  private async toApiError(options: RequestOptions, res: Response): Promise<OrigamiApiError> {
    const body = await readBody(res);
    const retryAfterMs = retryAfterFromHeaders(res.headers);
    return new OrigamiApiError({
      status: res.status,
      statusText: res.statusText,
      method: options.method,
      url: this.buildUrl(options.path, options.query),
      body,
      code: extractCode(body),
      handoff: extractHandoff(body),
      requestId: res.headers.get("x-request-id") ?? undefined,
      retryAfter: retryAfterMs != null ? retryAfterMs / 1000 : undefined,
      rateLimit: this._lastRateLimit,
    });
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const base = path.startsWith("http") ? path : this.baseUrl + path;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private buildHeaders(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
      ...options.headers,
    };
    if (options.body !== undefined && options.method !== "GET" && options.method !== "HEAD") {
      headers["content-type"] = "application/json";
    }
    if (options.auth !== false && this.apiKey) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    if (options.project !== false && this.projectId) {
      headers["x-origami-project"] = this.projectId;
    }
    return headers;
  }

  private debug(event: DebugEvent): void {
    this.onDebug?.(event);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function parseRateLimit(headers: Headers): RateLimitInfo {
  // v2 reports a `-global` bucket; v3 reports `-org`. Either falls back to the per-IP bucket.
  const limit =
    numericHeader(headers, "x-ratelimit-limit-global") ??
    numericHeader(headers, "x-ratelimit-limit-org") ??
    numericHeader(headers, "x-ratelimit-limit-ip");
  const remaining =
    numericHeader(headers, "x-ratelimit-remaining-global") ??
    numericHeader(headers, "x-ratelimit-remaining-org") ??
    numericHeader(headers, "x-ratelimit-remaining-ip");
  const retryAfterMs = retryAfterFromHeaders(headers);
  return {
    limit,
    remaining,
    retryAfter: retryAfterMs != null ? retryAfterMs / 1000 : null,
  };
}

function numericHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Returns the Retry-After delay in milliseconds, or undefined if absent/invalid. */
function retryAfterFromHeaders(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw == null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function backoffDelay(attempt: number): number {
  const base = 500 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(base + jitter, 8_000);
}

async function readBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("json") || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
