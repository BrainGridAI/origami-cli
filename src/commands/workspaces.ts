import type { Command } from "commander";

import type { Workspace } from "../api/types.js";
import { formatDateTime, printItem, printItems, type Column } from "../output/format.js";
import { ctxOf, emitAction, fetchList, moreHint, parseIntOption } from "./helpers.js";

const workspaceColumns: Column<Workspace>[] = [
  { header: "id", get: (w) => w.id },
  { header: "name", get: (w) => w.name },
  { header: "created_by_api", get: (w) => (w.createdByApi ? "yes" : "no") },
  { header: "created", get: (w) => formatDateTime(w.createdAt) },
  { header: "url", get: (w) => w.url },
];

export function registerWorkspacesCommands(program: Command): void {
  const ws = program
    .command("workspaces")
    .aliases(["workspace", "ws"])
    .description("Workspaces — containers for tables, documents, agents, campaigns");

  ws
    .command("list", { isDefault: true })
    .alias("ls")
    .description("List workspaces")
    .option("--search <text>", "case-insensitive substring match on the name")
    .option("-n, --limit <n>", "max workspaces to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      const { items, nextCursor } = await fetchList(
        ctx.client,
        (cursor) => ctx.client.listWorkspaces({ search: opts.search, limit, cursor }),
        { all: opts.all, cursor: opts.cursor },
      );
      printItems(items, workspaceColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  ws
    .command("create")
    .description("Create (bootstrap) a workspace")
    .option("--name <name>", "workspace name")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const workspace = await ctx.client.createWorkspace(opts.name);
      emitAction(ctx, workspace, `created workspace ${workspace.id}`);
    });

  ws
    .command("get <workspaceId>")
    .description("Fetch a workspace")
    .action(async (workspaceId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const workspace = await ctx.client.getWorkspace(workspaceId);
      printItem(workspace as unknown as Record<string, unknown>, workspaceColumns as never, {
        format: ctx.format,
        fields: ctx.fields,
      });
    });

  ws
    .command("delete <workspaceId>")
    .aliases(["rm"])
    .description("Delete a workspace (two-step: preview, then --confirm)")
    .option("--confirm", "actually delete (without this you get an impact preview)")
    .option("--dry-run", "force the impact preview even with --confirm")
    .action(async (workspaceId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const confirm = Boolean(opts.confirm) && !opts.dryRun;
      const res = await ctx.client.deleteWorkspace(workspaceId, confirm);
      emitAction(
        ctx,
        res,
        confirm
          ? `deleted workspace ${workspaceId}`
          : `preview only — re-run with --confirm to delete workspace ${workspaceId}`,
      );
    });
}
