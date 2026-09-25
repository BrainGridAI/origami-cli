import { createRequire } from "node:module";

import { Command, Option } from "commander";

import {
  OrigamiApiError,
  OrigamiAuthError,
  OrigamiConfigError,
  OrigamiError,
  OrigamiNetworkError,
} from "./api/errors.js";
import { registerCreditsShortcut } from "./commands/account.js";
import { registerAgentsCommands } from "./commands/agents.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerCampaignsCommands } from "./commands/campaigns.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerDocumentsCommands } from "./commands/documents.js";
import { registerEnrichmentsCommands } from "./commands/enrichments.js";
import { registerProjectsCommands } from "./commands/projects.js";
import { registerRunCommand } from "./commands/run.js";
import { registerScheduledCommands } from "./commands/scheduled.js";
import { registerSequencesCommands } from "./commands/sequences.js";
import { registerTablesCommands } from "./commands/tables.js";
import { registerWebhooksCommands } from "./commands/webhooks.js";
import { registerWorkspacesCommands } from "./commands/workspaces.js";
import { color } from "./output/color.js";
import { registerV3Commands, V3_SPEC_VERSION } from "./v3/commands.js";

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const GLOBAL_OPTION_SPECS: Array<[string, string]> = [
  ["--api-key <key>", "Origami API key (og_live_…)"],
  ["--project <id>", "scope requests to a project (child org) via x-origami-project"],
  ["--profile <name>", "configuration profile to use"],
  ["--base-url <url>", "override the API base URL"],
  ["-o, --output <format>", "output format: table | json | csv"],
  ["--fields <list>", "comma-separated columns to show (table/csv)"],
  ["--no-color", "disable colored output"],
  ["--debug", "log HTTP requests to stderr"],
  ["--timeout <ms>", "per-request timeout in milliseconds"],
  ["--max-retries <n>", "max retries on 429/5xx/network errors"],
  ["--no-retry", "disable automatic retries"],
];

/** Attach the shared options to a command so they can be placed after the command path. */
export function addGlobalOptions(command: Command): Command {
  const existingLongs = new Set(command.options.map((o) => o.long).filter(Boolean) as string[]);
  const existingShorts = new Set(command.options.map((o) => o.short).filter(Boolean) as string[]);
  for (const [flags, description] of GLOBAL_OPTION_SPECS) {
    const option = new Option(flags, description);
    if (option.long && existingLongs.has(option.long)) continue;
    if (option.short && existingShorts.has(option.short)) continue;
    command.addOption(option);
  }
  return command;
}

/** Attach the shared options to every leaf command (a command with no subcommands). */
function attachGlobalOptionsToLeaves(command: Command): void {
  if (command.commands.length === 0) {
    addGlobalOptions(command);
    return;
  }
  for (const sub of command.commands) attachGlobalOptionsToLeaves(sub);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("origami")
    .description(
      `Command-line interface for the Origami API: v3 (send, leads, jobs, account; spec ${V3_SPEC_VERSION}) plus the v2 agent surface`,
    )
    .version(readVersion(), "-v, --version", "print the CLI version")
    .showHelpAfterError("(add --help for usage)");

  program.addHelpText(
    "after",
    `
Global options (available on every command, placed after the command):
  --api-key <key>          Origami API key (og_live_…)
  --project <id>           scope requests to a project (child org)
  --profile <name>         configuration profile to use
  --base-url <url>         override the API base URL
  -o, --output <format>    output format: table | json | csv
  --fields <list>          comma-separated columns to show (table/csv)
  --no-color               disable colored output
  --debug                  log HTTP requests to stderr
  --timeout <ms>           per-request timeout in milliseconds
  --max-retries <n>        retries on 429/5xx/network errors (--no-retry to disable)

Environment variables:
  ORIGAMI_API_KEY    API key (overrides the stored profile key)
  ORIGAMI_PROJECT    default project id (x-origami-project)
  ORIGAMI_BASE_URL   API base URL
  ORIGAMI_PROFILE    default profile name
  ORIGAMI_CONFIG_DIR directory for the config file
  NO_COLOR           disable colored output

Examples (v3):
  origami send campaigns list --status active            campaigns by status
  origami send campaigns templates get <campaignId>      read the copy people will receive
  origami send campaigns launch <campaignId> --dry-run   the gates a real launch would check
  origami leads searches create --brief "Heads of RevOps at US SaaS" --count 25 --wait
  origami leads lists rows <listId> --all -o csv         export a list
  origami jobs wait <jobId>                              poll any async Job to completion
  origami account                                        org, plan, capabilities

Examples (v2 agent surface):
  origami auth login                                     store your API key
  origami run "Find 30 B2B SaaS founders in Austin who raised seed in 2025"
  origami tables rows <tableId> -o csv --out leads.csv   export a table to CSV
`,
  );

  // Order: v3 sections first, then the v2 agent surface.
  registerV3Commands(program);
  registerRunCommand(program);
  registerAgentsCommands(program);
  registerWorkspacesCommands(program);
  registerTablesCommands(program);
  registerEnrichmentsCommands(program);
  registerDocumentsCommands(program);
  registerCampaignsCommands(program);
  registerSequencesCommands(program);
  registerScheduledCommands(program);
  registerProjectsCommands(program);
  registerCreditsShortcut(program);
  registerWebhooksCommands(program);
  registerAuthCommands(program);
  registerConfigCommands(program);

  attachGlobalOptionsToLeaves(program);

  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    handleError(err);
    process.exitCode = exitCodeFor(err);
  }
}

function exitCodeFor(err: unknown): number {
  if (err instanceof OrigamiConfigError) return 2;
  return 1;
}

function handleError(err: unknown): void {
  const write = (msg: string) => process.stderr.write(`${msg}\n`);

  if (err instanceof OrigamiApiError) {
    write(color.red(`✗ ${err.message}`));
    if (err.isAuth) {
      write(color.dim("  Your API key may be missing, invalid, or lack access. Try `origami auth status`."));
    }
    if (err.isSubscriptionRequired) {
      write(color.dim("  Your plan doesn't include this. Upgrade to a plan with API access."));
    }
    if (err.isConcurrentLimit && err.retryAfter) {
      write(color.dim(`  Concurrent-run limit hit. Retry after ${err.retryAfter}s.`));
    } else if (err.isRateLimit && err.retryAfter) {
      write(color.dim(`  Rate limited. Retry after ${err.retryAfter}s.`));
    }
    if (err.code === "PROJECT_NOT_FOUND") {
      write(color.dim("  Check --project / ORIGAMI_PROJECT — the project id is unknown, cross-parent, or deleted."));
    }
    if (err.handoff?.url) {
      write(color.dim(`  ${err.handoff.label ?? "Resolve in-app"}: ${err.handoff.url}`));
    }
    return;
  }
  if (err instanceof OrigamiAuthError || err instanceof OrigamiConfigError) {
    write(color.red(`✗ ${err.message}`));
    return;
  }
  if (err instanceof OrigamiNetworkError) {
    write(color.red(`✗ ${err.message}`));
    write(color.dim("  Check your connection and --base-url."));
    return;
  }
  if (err instanceof OrigamiError) {
    write(color.red(`✗ ${err.message}`));
    return;
  }
  write(color.red(`✗ Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
}
