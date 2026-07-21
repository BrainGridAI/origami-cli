/**
 * Type definitions for the Origami Public API v2.
 *
 * Mirrors https://docs.origami.chat/ (the v2 OpenAPI spec). These types describe
 * the request/response payloads the client and commands exchange with the API.
 */

export const DEFAULT_BASE_URL = "https://origami.chat/api/v2";
/** Canonical app origin — used for deep links and login hints. */
export const APP_ORIGIN = "https://origami.chat";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type Model = "origami-lite" | "origami-max";
export const MODELS: readonly Model[] = ["origami-lite", "origami-max"];

/**
 * Normalize a user-friendly model alias to the public model id.
 * Accepts `lite`/`max` shorthands and the legacy `origami-fast`/`origami-mid`.
 */
export function normalizeModel(value: string): Model | undefined {
  const v = value.trim().toLowerCase();
  if (v === "lite" || v === "origami-lite" || v === "origami-fast" || v === "origami-mid") {
    return "origami-lite";
  }
  if (v === "max" || v === "origami-max") return "origami-max";
  return undefined;
}

export type RunStatus =
  | "running"
  | "completed"
  | "needs_input"
  | "step_cap_hit"
  | "incomplete"
  | "cancelled"
  | "errored"
  | "timed_out";

/** Terminal run states — anything that is not `running`. */
export function isTerminalStatus(status: string): boolean {
  return status !== "running";
}

export const FILTER_OPERATORS = [
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type ColumnKind = "input" | "enrichment" | "score" | "sequence";

export type UploadMode = "table" | "append" | "document";

// ---------------------------------------------------------------------------
// List envelope
// ---------------------------------------------------------------------------

export interface ListEnvelope<T> {
  object: "list";
  items: T[];
  nextCursor: string | null;
  url: string;
  /** Some list endpoints (rows, campaign people, scheduled agents) add a total. */
  total?: number;
}

/** Common list query parameters. */
export interface ListParams {
  cursor?: string | undefined;
  limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Agents & runs
// ---------------------------------------------------------------------------

export interface UploadedRunAttachment {
  kind: "document" | "table";
  documentId?: string;
  tableId?: string;
}

export interface CreateAgentRequest {
  prompt: string;
  name?: string;
  workspaceId?: string | null;
  focusTableIds?: string[];
  attachments?: UploadedRunAttachment[];
  model?: Model;
}

export interface SendRunRequest {
  prompt: string;
  focusTableIds?: string[];
  attachments?: UploadedRunAttachment[];
  model?: Model;
}

export interface AgentSummary {
  object: "agent";
  id: string;
  name: string;
  workspaceId: string;
  createdAt: string;
}

export interface Agent extends AgentSummary {
  apiKeyOwned?: boolean;
  lastRun?: RunSummary | null;
}

export interface RunSteps {
  completed: number;
  max: number;
}

export interface RunSummary {
  object: "run";
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  model: Model;
  steps: RunSteps;
  startedAt: string;
  completedAt?: string | null;
}

export interface RunAction {
  type: string;
  tableId: string;
  tableName?: string | null;
  columnId?: string | null;
  columnName?: string | null;
  count?: number;
  leadCount?: number | null;
  deletedAt?: string | null;
}

export interface RunResponse {
  text: string | null;
  actions: RunAction[];
  tables: Table[];
  transcript?: unknown[] | null;
  transcriptTruncated?: boolean;
}

export interface PendingQuestion {
  type: "single-choice" | "confirm";
  question: string;
  suggestedAnswers: string[];
  freeformOption: string;
}

export interface NextAction {
  label: string;
  type?: string;
  tableSlug?: string;
}

export interface RunTodo {
  pendingQuestions: PendingQuestion[];
  nextActions: NextAction[];
}

export interface Run extends RunSummary {
  workspaceId: string;
  request: {
    prompt: string;
    model: Model;
    focusTableIds: string[];
  };
  response: RunResponse | null;
  todo: RunTodo;
}

export interface CreateAgentResponse {
  agent: AgentSummary;
  run: Run;
  workspace: {
    object: "workspace";
    id: string;
    name: string;
    createdAt: string;
    createdByApi: boolean;
  };
}

export interface SendRunResponse {
  run: Run;
}

export type RunInclude = "stats" | "transcript";

// ---------------------------------------------------------------------------
// Workspaces & documents
// ---------------------------------------------------------------------------

export interface Workspace {
  object: "workspace";
  id: string;
  name: string;
  createdByApi: boolean;
  url: string;
  createdAt: string;
}

export interface DocumentSummary {
  object: "document";
  id: string;
  documentId: string;
  filename: string;
  vfsPath: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
}

export interface UploadFile {
  filename: string;
  content: string;
  mode?: UploadMode;
  tableId?: string;
}

export interface UploadFilesRequest {
  files: UploadFile[];
}

export interface UploadFilesResponse {
  results: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tables, columns, rows
// ---------------------------------------------------------------------------

export interface CreditsLifetime {
  lifetimeUsed: number;
}

export interface CellsLiveness {
  running: number;
  errored: number;
}

export interface WorkspaceColumn {
  object: "column";
  id: string;
  name: string;
  type: string;
  kind: ColumnKind;
  slug: string | null;
  autoTrigger: boolean;
  credits: CreditsLifetime;
  cells: CellsLiveness;
}

export interface Table {
  object: "table";
  id: string;
  workspaceId: string;
  name: string;
  leadCount: number;
  columns: WorkspaceColumn[];
  credits: CreditsLifetime;
  cells: CellsLiveness;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface Row {
  object: "row";
  id: string;
  cells: Record<string, unknown>;
}

export interface RowFilter {
  column: string;
  operator: FilterOperator;
  value: unknown;
}

export interface RowSort {
  column: string;
  direction: "asc" | "desc";
}

export interface ListRowsParams extends ListParams {
  filters?: RowFilter[] | undefined;
  sort?: RowSort | undefined;
  /** Return v1-style `{ slug: value }` rows. */
  flat?: boolean | undefined;
  /** Disable the table's saved default filters/sort. */
  defaults?: boolean | undefined;
}

export interface UpsertRowsRequest {
  rows: Array<Record<string, unknown>>;
  matchColumns: string[];
  enrich?: boolean;
  reenrichUpdated?: boolean;
  batchId?: string;
}

export interface UpsertRowsFileRequest {
  content: string;
  matchColumns: string[];
  filename?: string;
  enrich?: boolean;
  reenrichUpdated?: boolean;
  batchId?: string;
}

export interface UpsertReceipt {
  object: "enrichment_run";
  id: string;
  batchId: string;
  counts: { inserted: number; updated: number; skipped: number };
}

// ---------------------------------------------------------------------------
// Enrichment runs
// ---------------------------------------------------------------------------

export interface EnrichmentRun {
  object: "enrichment_run";
  id: string;
  batchId: string;
  tableId: string;
  type: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export interface EnrichmentRunDetail extends EnrichmentRun {
  rowCount: number;
  enrichments: { total: number; completed: number; pending: number; failed: number };
  creditsUsed: number;
  outcomes?: Array<{ inputIndex: number; rowId: string | null; outcome: string }>;
  outcomeCounts?: { inserted: number; updated: number; skipped: number };
}

// ---------------------------------------------------------------------------
// Campaigns, sequences, steps
// ---------------------------------------------------------------------------

export type CampaignStatus = "draft" | "active" | "paused";

export interface CampaignSummary {
  object: "campaign";
  id: string | null;
  slug: string | null;
  name: string;
  status: CampaignStatus;
  peopleCount: number;
}

export interface Campaign {
  object: "campaign";
  id: string;
  slug: string | null;
  name: string;
  status: CampaignStatus;
  workspaceId: string;
  tableId: string | null;
  channels: { email: boolean; linkedin: boolean };
  settings: Record<string, unknown>;
  brief: unknown;
  outOfLeads: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignPerson {
  object: "campaign_person";
  sequenceId: string;
  rowId: string | null;
  recipient: string | null;
  sendStatus: string;
  stopReason: string | null;
  profile: unknown;
  fitExplanation: string | null;
  fitScore: number | null;
  addedAt: string | null;
}

export interface CampaignStats {
  object: "campaign_stats";
  found: number;
  contacted: number;
  hasEmail: boolean;
  hasLinkedin: boolean;
  connectAccepted: number;
  connectSent: number;
  connectionRate: number;
  replied: number;
  replyRate: number;
}

export interface ListCampaignPeopleParams extends ListParams {
  search?: string | undefined;
  status?: string | undefined;
}

export interface CampaignAgenticResponse {
  agent: AgentSummary;
  run: Run;
  table?: { object: "table"; id: string; name: string };
  campaign?: { object: "campaign"; id: string; name: string };
}

export interface SequenceSummary {
  object: "sequence";
  id: string;
  sequenceId: string;
  campaignId: string | null;
  status: string;
  stopReason: string | null;
  sendStatus: string | null;
  tableId: string | null;
  columnId: string | null;
  rowId: string | null;
  workspaceId: string | null;
  url: string | null;
}

export interface SequenceStep {
  object: "step";
  id: string;
  stepId: string;
  channel: string;
  kind: string;
  status: string;
  subject: string | null;
  body: string | null;
  recipient: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
}

export interface SequenceDetail extends SequenceSummary {
  steps: SequenceStep[];
}

export interface ListSequencesParams extends ListParams {
  workspaceId?: string | undefined;
  tableId?: string | undefined;
  columnId?: string | undefined;
  status?: string | undefined;
  channel?: string | undefined;
  recipient?: string | undefined;
}

// ---------------------------------------------------------------------------
// Scheduled agents
// ---------------------------------------------------------------------------

export interface ScheduledAgent {
  object: "scheduled_agent";
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  cron: string;
  model: string | null;
  enabled: boolean;
  planBlocked: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  url: string;
}

export interface CreateScheduledAgentRequest {
  workspaceId: string;
  name: string;
  prompt: string;
  cron: string;
  description?: string;
  model?: Model;
}

export interface UpdateScheduledAgentRequest {
  name?: string;
  prompt?: string;
  cron?: string;
  description?: string;
  model?: Model;
  enabled?: boolean;
}

export interface ListScheduledAgentsParams extends ListParams {
  workspaceId?: string | undefined;
  enabled?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface Project {
  object: "project";
  id: string;
  name: string;
  monthlyCredits: number | null;
  usage: { spent: number; reserved: number };
  createdAt: string;
}

export interface CreateProjectRequest {
  name: string;
  monthlyCredits?: number | null;
}

export interface UpdateProjectRequest {
  name?: string;
  monthlyCredits?: number | null;
}

// ---------------------------------------------------------------------------
// Account & credits
// ---------------------------------------------------------------------------

export interface Account {
  object: "account";
  organization: { id: string; name: string | null };
  plan: { id: string; name: string };
  capabilities: {
    canUseApi: boolean;
    canRunScheduledTasks: boolean;
    concurrentAgents: number | null;
  };
  workspaces: { used: number; limit: number | null };
}

export interface Credits {
  object: "credits";
  balance: number;
  currency: "credits";
}
