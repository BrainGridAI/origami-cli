import type { Command } from "commander";

import { color } from "../output/color.js";
import { printJson, writeOut } from "../output/format.js";
import { ctxOf } from "./helpers.js";

/**
 * `origami credits`: shortcut for `origami account credits` (v3). The `account`
 * group itself is generated from the v3 catalog (src/v3/commands.ts).
 */
export function registerCreditsShortcut(program: Command): void {
  program
    .command("credits")
    .description("Credit balance (shortcut for `account credits`)")
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.requestV3({ method: "GET", path: "/account/credits" });
      const credits = res.data as { balance?: number; reserved?: number; available?: number };
      if (ctx.format === "json") {
        printJson(credits);
        return;
      }
      writeOut(`${color.bold("Credits")}  ${credits.available ?? credits.balance}`);
    });
}
