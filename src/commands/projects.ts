import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import type { CreateProjectRequest, Project, UpdateProjectRequest } from "../api/types.js";
import { formatDateTime, printItem, printItems, type Column } from "../output/format.js";
import { ctxOf, emitAction, fetchList, moreHint, parseIntOption } from "./helpers.js";

const projectColumns: Column<Project>[] = [
  { header: "id", get: (p) => p.id },
  { header: "name", get: (p) => p.name },
  { header: "monthly_credits", get: (p) => (p.monthlyCredits == null ? "uncapped" : p.monthlyCredits) },
  { header: "spent", get: (p) => p.usage?.spent ?? 0 },
  { header: "reserved", get: (p) => p.usage?.reserved ?? 0 },
  { header: "created", get: (p) => formatDateTime(p.createdAt) },
];

function parseCredits(value: string | undefined): number | null | undefined {
  if (value == null) return undefined;
  if (value.toLowerCase() === "null" || value.toLowerCase() === "uncapped") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new OrigamiConfigError(`--monthly-credits must be a positive integer or "null" (got "${value}").`);
  }
  return Math.floor(n);
}

export function registerProjectsCommands(program: Command): void {
  const projects = program
    .command("projects")
    .aliases(["project", "p"])
    .description("Projects (child orgs) — managed from the parent org");

  projects
    .command("list", { isDefault: true })
    .alias("ls")
    .description("List projects")
    .option("--search <text>", "case-insensitive substring match on the name")
    .option("-n, --limit <n>", "max projects to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      const { items, nextCursor } = await fetchList(
        ctx.client,
        (cursor) => ctx.client.listProjects({ search: opts.search, limit, cursor }),
        { all: opts.all, cursor: opts.cursor },
      );
      printItems(items, projectColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  projects
    .command("create <name>")
    .description("Create a project (child org)")
    .option("--monthly-credits <n>", "monthly budget cap in credits (omit for uncapped)")
    .action(async (name: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const credits = parseCredits(opts.monthlyCredits);
      const request: CreateProjectRequest = {
        name,
        ...(credits !== undefined ? { monthlyCredits: credits } : {}),
      };
      const project = await ctx.client.createProject(request);
      emitAction(ctx, project, `created project ${project.id} (${project.name})`);
    });

  projects
    .command("get <projectId>")
    .description("Fetch a project")
    .action(async (projectId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const project = await ctx.client.getProject(projectId);
      printItem(project as unknown as Record<string, unknown>, projectColumns as never, {
        format: ctx.format,
        fields: ctx.fields,
      });
    });

  projects
    .command("update <projectId>")
    .description("Update a project's name / budget cap")
    .option("--name <name>", "new name")
    .option("--monthly-credits <n>", 'new cap, or "null" to clear it')
    .action(async (projectId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const credits = parseCredits(opts.monthlyCredits);
      const request: UpdateProjectRequest = {
        ...(opts.name ? { name: opts.name } : {}),
        ...(credits !== undefined ? { monthlyCredits: credits } : {}),
      };
      const project = await ctx.client.updateProject(projectId, request);
      emitAction(ctx, project, `updated project ${projectId}`);
    });

  projects
    .command("delete <projectId>")
    .aliases(["rm"])
    .description("Delete a project (two-step: preview, then --confirm)")
    .option("--confirm", "actually delete (without this you get an impact preview)")
    .option("--dry-run", "force the impact preview even with --confirm")
    .action(async (projectId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const confirm = Boolean(opts.confirm) && !opts.dryRun;
      const res = await ctx.client.deleteProject(projectId, { confirm, dryRun: Boolean(opts.dryRun) });
      emitAction(
        ctx,
        res,
        confirm ? `deleted project ${projectId}` : `preview only — re-run with --confirm to delete project ${projectId}`,
      );
    });
}
