import type { Command } from "commander";

import type { Account } from "../api/types.js";
import { color } from "../output/color.js";
import { printJson, writeOut } from "../output/format.js";
import { ctxOf } from "./helpers.js";

function renderAccount(account: Account): void {
  const cap = account.capabilities;
  const ws = account.workspaces;
  const lines = [
    `${color.bold("Organization")}  ${account.organization.name ?? account.organization.id}`,
    `${color.bold("Plan")}          ${account.plan.name} (${account.plan.id})`,
    `${color.bold("API access")}    ${cap.canUseApi ? color.green("yes") : color.red("no")}`,
    `${color.bold("Scheduled")}     ${cap.canRunScheduledTasks ? color.green("yes") : color.red("no")}`,
    `${color.bold("Concurrency")}   ${cap.concurrentAgents == null ? "unlimited" : cap.concurrentAgents}`,
    `${color.bold("Workspaces")}    ${ws.used}${ws.limit == null ? "" : `/${ws.limit}`}`,
  ];
  writeOut(lines.join("\n"));
}

export function registerAccountCommands(program: Command): void {
  const account = program.command("account").aliases(["acct"]).description("Org account state — plan, capabilities, credits");

  account
    .command("get", { isDefault: true })
    .description("Org account overview")
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const data = await ctx.client.getAccount();
      if (ctx.format === "json") printJson(data);
      else renderAccount(data);
    });

  account
    .command("credits")
    .description("Credit balance")
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const credits = await ctx.client.getCredits();
      if (ctx.format === "json") printJson(credits);
      else writeOut(`${color.bold("Credits")}  ${credits.balance}`);
    });

  // Convenience top-level alias: `origami credits`.
  program
    .command("credits")
    .description("Credit balance (alias of `account credits`)")
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const credits = await ctx.client.getCredits();
      if (ctx.format === "json") printJson(credits);
      else writeOut(`${color.bold("Credits")}  ${credits.balance}`);
    });
}
