import { writeFileSync } from "node:fs";

import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import type { DocumentSummary, UploadFile, UploadMode } from "../api/types.js";
import { color } from "../output/color.js";
import { formatDateTime, printItems, printJson, printText, type Column } from "../output/format.js";
import { fileName, readFileBase64 } from "../util/fs.js";
import { ctxOf, emitAction, fetchList, moreHint, parseIntOption } from "./helpers.js";

const documentColumns: Column<DocumentSummary>[] = [
  { header: "id", get: (d) => d.id },
  { header: "filename", get: (d) => d.filename },
  { header: "kind", get: (d) => d.kind },
  { header: "status", get: (d) => d.status },
  { header: "path", get: (d) => d.vfsPath },
  { header: "updated", get: (d) => formatDateTime(d.updatedAt) },
];

const UPLOAD_MODES: readonly UploadMode[] = ["table", "append", "document"];

export function registerDocumentsCommands(program: Command): void {
  const docs = program
    .command("documents")
    .aliases(["docs", "doc"])
    .description("Workspace documents — upload, read, rename, delete");

  docs
    .command("list <workspaceId>")
    .alias("ls")
    .description("List a workspace's documents")
    .option("-n, --limit <n>", "max documents to fetch")
    .option("--cursor <cursor>", "start from a pagination cursor")
    .option("--all", "fetch every page")
    .action(async (workspaceId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const limit = parseIntOption(opts.limit, "limit");
      const { items, nextCursor } = await fetchList(
        ctx.client,
        (cursor) => ctx.client.listDocuments(workspaceId, { limit, cursor }),
        { all: opts.all, cursor: opts.cursor },
      );
      printItems(items, documentColumns, { format: ctx.format, fields: ctx.fields });
      moreHint(ctx, nextCursor, opts.all);
    });

  docs
    .command("upload <workspaceId> <file...>")
    .description("Upload files into a workspace (CSV → table by default)")
    .option("--mode <mode>", `ingest mode: ${UPLOAD_MODES.join(" | ")}`)
    .option("--table <id>", "target table id (required for --mode append)")
    .action(async (workspaceId: string, files: string[], opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const mode = opts.mode as UploadMode | undefined;
      if (mode && !UPLOAD_MODES.includes(mode)) {
        throw new OrigamiConfigError(`Invalid --mode "${mode}". One of: ${UPLOAD_MODES.join(", ")}.`);
      }
      if (mode === "append" && !opts.table) {
        throw new OrigamiConfigError("--mode append requires --table <id>.");
      }
      const payload: UploadFile[] = files.map((path) => ({
        filename: fileName(path),
        content: readFileBase64(path),
        ...(mode ? { mode } : {}),
        ...(opts.table ? { tableId: opts.table } : {}),
      }));
      const res = await ctx.client.uploadDocuments(workspaceId, { files: payload });
      emitAction(ctx, res, `uploaded ${files.length} file(s) to workspace ${workspaceId}`);
    });

  docs
    .command("get <workspaceId> <documentId>")
    .description("Read a document (metadata + content)")
    .option("--out <file>", "write the document content to a file")
    .action(async (workspaceId: string, documentId: string, opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const doc = await ctx.client.getDocument(workspaceId, documentId);
      if (opts.out) {
        writeFileSync(opts.out, doc.content ?? "");
        process.stderr.write(color.green(`✓ wrote ${doc.filename} to ${opts.out}\n`));
        return;
      }
      if (ctx.format === "json") printJson(doc);
      else printText(doc.content ?? "");
    });

  docs
    .command("rename <workspaceId> <documentId> <name>")
    .description("Rename a document")
    .action(async (workspaceId: string, documentId: string, name: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const doc = await ctx.client.renameDocument(workspaceId, documentId, name);
      emitAction(ctx, doc, `renamed document ${documentId} → ${doc.filename}`);
    });

  docs
    .command("delete <workspaceId> <documentId>")
    .aliases(["rm"])
    .description("Delete a document")
    .action(async (workspaceId: string, documentId: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      ctx.requireKey();
      const res = await ctx.client.deleteDocument(workspaceId, documentId);
      emitAction(ctx, res, `deleted document ${documentId}`);
    });
}
