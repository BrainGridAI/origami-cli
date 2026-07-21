# origami-cli

A comprehensive command-line interface for the [Origami API v2](https://docs.origami.chat/) —
run Origami's agent from a plain-English brief and get back a **table**, read and write rows, upsert
and enrich leads, manage campaigns and sequences, drive scheduled agents and projects, and check
your account and credits.

```
origami run "Find 30 B2B SaaS founders in Austin who raised seed in 2025"
# → creates an agent, polls it to completion, prints the resulting table
```

## Install

```bash
# from source (this repo)
pnpm install
pnpm build
npm link            # puts `origami` on your PATH

# or run without installing
node dist/index.js --help
```

Requires Node.js 18+.

## Authenticate

Create an API key under **Settings → Developers** in the [Origami app](https://origami.chat). Keys
look like `og_live_…` and are **parent-wide** (they can act on your org or any of its projects).

```bash
origami auth login                    # prompts for a key (hidden input), verifies it
origami auth login --key og_live_…    # non-interactive
echo "$KEY" | origami auth login      # from a pipe / secret manager
origami auth login --project <id>     # store a default project (child org) scope
```

Inspect or rotate:

```bash
origami auth status                   # resolved profile (key masked) + plan
origami auth logout                   # forget the active profile's key
```

The key can also come from the environment (handy for CI):

```bash
export ORIGAMI_API_KEY=og_live_…
origami account
```

## The core loop

Origami is agentic: you send a brief, an agent researches it in the background and builds a table,
then you read the rows.

```bash
# 1. Run a brief (creates an agent, polls to completion, prints the table)
origami run "Find 20 fintech CEOs in NYC" --model max

# 2. If the agent asks a question, answer it (same agent + conversation)
origami agents ask <agentId> "Only Series A and later, please"

# 3. Read the rows it built
origami tables rows <tableId>
origami tables rows <tableId> -o csv --out leads.csv     # export to a file

# 4. Bring your own data — upsert + enrich
origami tables upsert <tableId> --match domain \
  --row '{"domain":"acme.com"}' --row '{"domain":"globex.com"}'
origami enrichments get <enrichmentRunId> --wait          # poll until settled
```

`origami run` and `origami agents create` are the same flow; `run` is the friendly shortcut. Add
`--no-wait` to return the running run id instead of polling, then poll later with
`origami agents run-get <agentId> <runId> --wait`.

## Global options

Place these **after** the command (kubectl-style):

| Option | Description |
| --- | --- |
| `--api-key <key>` | API key (overrides profile/env) |
| `--project <id>` | scope the request to a project (child org) via `x-origami-project` |
| `--profile <name>` | configuration profile |
| `--base-url <url>` | override the API base URL |
| `-o, --output <format>` | `table` (default in a terminal), `json` (default when piped), or `csv` |
| `--fields <list>` | comma-separated columns to show (table/csv) |
| `--no-color` | disable colored output (also honors `NO_COLOR`) |
| `--debug` | log HTTP requests to stderr |
| `--timeout <ms>` | per-request timeout |
| `--max-retries <n>` / `--no-retry` | control automatic retries on 429/5xx |

Data goes to **stdout**; status, progress, and hints go to **stderr** — so `| jq` and `-o csv`
pipelines stay clean.

## Commands

### `run` / `agents`

```bash
origami run "<brief>" [--model lite|max] [--workspace <id>] [--table <id>]... [--rows] [--no-wait]
origami agents list [--search <text>] [--all]
origami agents get <agentId>
origami agents ask <agentId> "<follow-up>"
origami agents runs <agentId>
origami agents run-get <agentId> <runId> [--wait] [--include stats,transcript]
origami agents tables <agentId>
origami agents cancel <agentId>
origami agents archive <agentId>
```

### `tables`

```bash
origami tables list [--workspace <id>] [--all]
origami tables get <tableId> [--include stats]
origami tables columns <tableId>
origami tables rows <tableId> [--filter '<col> <op> [value]']... [--sort <col>:<asc|desc>] \
                              [--flat] [--no-defaults] [--limit <=200] [--all] [-o csv] [--out file.csv]
origami tables row <tableId> <rowId>
origami tables cell <tableId> <rowId> <columnId>
origami tables upsert <tableId> --match <slugs> (--row '<json>'... | --file rows.csv) \
                              [--no-enrich] [--reenrich-updated] [--batch-id <uuid>]
```

Filter operators: `contains`, `not_contains`, `equals`, `not_equals`, `is_empty`, `is_not_empty`,
`greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`.

### `enrichments`, `documents`, `workspaces`

```bash
origami enrichments list [--table <id>] [--all]
origami enrichments get <runId> [--wait]

origami documents list <workspaceId>
origami documents upload <workspaceId> <file...> [--mode table|append|document] [--table <id>]
origami documents get <workspaceId> <documentId> [--out <file>]
origami documents rename <workspaceId> <documentId> <name>
origami documents delete <workspaceId> <documentId>

origami workspaces list
origami workspaces create --name <name>
origami workspaces get <workspaceId>
origami workspaces delete <workspaceId> [--confirm]
```

### `campaigns`, `sequences`

```bash
origami campaigns list (--workspace <id> | --table <id>)
origami campaigns create <tableId> "<instructions>"     # agentic — drafts sequences, doesn't send
origami campaigns edit <campaignId> "<change>"          # agentic
origami campaigns people <campaignId> [--status <csv>] [--all]
origami campaigns stats <campaignId>
origami campaigns launch <campaignId> [--dry-run]       # also: pause / resume
origami campaigns delete <campaignId> [--confirm]

origami sequences list (--workspace <id> | --table <id> | --column <id>) [--status <s>]
origami sequences get <sequenceId>
origami sequences stop <sequenceId> [--dry-run]
origami sequences delete <sequenceId> [--force]
```

### `scheduled`, `projects`, `account`

```bash
origami scheduled list [--workspace <id>] [--enabled true|false]
origami scheduled create --workspace <id> --name <n> --prompt "<brief>" --cron "0 9 * * 1"
origami scheduled enable|disable|trigger <id>
origami scheduled runs <id>

origami projects list                                   # parent-org only
origami projects create <name> [--monthly-credits <n>]
origami projects update <id> [--name <n>] [--monthly-credits <n|null>]
origami projects delete <id> [--confirm]

origami account                                         # plan, capabilities, workspace usage
origami credits                                         # credit balance
```

### `webhooks` (local dev tools)

Origami webhooks are configured in the dashboard; these are local helpers for building a receiver.

```bash
origami webhooks verify --secret whsec_… --id <id> --timestamp <ts> --signature <sig> --file body.json
origami webhooks listen --port 9333 --secret whsec_…    # verify + pretty-print inbound events
```

### `config`

```bash
origami config path
origami config show                                     # secrets redacted
origami config profiles
origami config use <profile>
```

## Scripting

```bash
origami tables rows <id> -o json | jq '.[].website'
origami agents list --all -o csv > agents.csv
origami run "Find 50 founders" --rows -o json > result.json
```

## Reliability

The client automatically retries `408/429/500/502/503/504` and network errors with exponential
backoff (honoring `Retry-After`), and polls runs on the API's `Retry-After` cadence (15s). Rate
limits: 300 req/min per IP, 100 req/min per org; concurrent agent runs are plan-tunable.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | API or runtime error |
| `2` | usage / configuration error (bad flag, missing key) |

## Environment variables

| Variable | Description |
| --- | --- |
| `ORIGAMI_API_KEY` | API key (overrides the stored profile key) |
| `ORIGAMI_PROJECT` | default project id (`x-origami-project`) |
| `ORIGAMI_BASE_URL` | API base URL |
| `ORIGAMI_PROFILE` | default profile name |
| `ORIGAMI_CONFIG_DIR` | directory for the config file (default `~/.config/origami`) |
| `NO_COLOR` / `FORCE_COLOR` | disable / force colored output |

## Development

```bash
pnpm dev -- <args>        # run from source (tsx)
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest
pnpm build                # tsup → dist/index.js
```

## License

MIT
