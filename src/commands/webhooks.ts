import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Command } from "commander";

import { OrigamiConfigError } from "../api/errors.js";
import { color } from "../output/color.js";
import { printJson, writeOut } from "../output/format.js";
import { ctxOf } from "./helpers.js";

/**
 * Standard-Webhooks HMAC-SHA256 verification.
 * signedContent = `${id}.${timestamp}.${payload}`; the signature header is a
 * space-separated list of `v1,<base64sig>` tokens.
 */
export function verifySignature(input: {
  payload: string;
  secret: string;
  id: string;
  timestamp: string;
  signatureHeader: string;
}): boolean {
  const secretRaw = input.secret.startsWith("whsec_") ? input.secret.slice("whsec_".length) : input.secret;
  const key = Buffer.from(secretRaw, "base64");
  const signedContent = `${input.id}.${input.timestamp}.${input.payload}`;
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);
  for (const token of input.signatureHeader.split(" ")) {
    const parts = token.split(",");
    const sig = parts.length > 1 ? parts[1] : parts[0];
    if (!sig) continue;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) return true;
  }
  return false;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function registerWebhooksCommands(program: Command): void {
  const webhooks = program
    .command("webhooks")
    .aliases(["webhook"])
    .description("Webhook dev tools (verify signatures, receive events locally)");

  webhooks
    .command("verify")
    .description("Verify a Standard-Webhooks signature over a payload")
    .requiredOption("--secret <whsec>", "the endpoint signing secret (whsec_…)")
    .requiredOption("--id <id>", "the webhook-id header value")
    .requiredOption("--timestamp <ts>", "the webhook-timestamp header value")
    .requiredOption("--signature <sig>", "the webhook-signature header value")
    .option("--file <path>", "payload file (defaults to stdin)")
    .action(async (opts, command: Command) => {
      const ctx = ctxOf(command);
      const payload = opts.file ? readFileSync(opts.file, "utf8") : await readStdin();
      const ok = verifySignature({
        payload,
        secret: opts.secret,
        id: opts.id,
        timestamp: opts.timestamp,
        signatureHeader: opts.signature,
      });
      if (ctx.format === "json") {
        printJson({ valid: ok });
      } else {
        writeOut(ok ? color.green("✓ signature valid") : color.red("✗ signature INVALID"));
      }
      if (!ok) process.exitCode = 1;
    });

  webhooks
    .command("listen")
    .description("Run a local receiver that verifies + pretty-prints inbound webhook events")
    .option("-p, --port <port>", "port to listen on", "9333")
    .option("--secret <whsec>", "signing secret to verify inbound events (whsec_…)")
    .option("--path <path>", "only handle this path", "/")
    .action(async (opts) => {
      const port = Number(opts.port);
      if (!Number.isFinite(port) || port <= 0) throw new OrigamiConfigError(`Invalid --port "${opts.port}".`);

      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST" || (opts.path && req.url !== opts.path)) {
          res.writeHead(req.method === "GET" ? 200 : 404).end(req.method === "GET" ? "origami webhook listener\n" : "not found\n");
          return;
        }
        const body = await readRequestBody(req);
        const id = String(req.headers["webhook-id"] ?? "");
        const timestamp = String(req.headers["webhook-timestamp"] ?? "");
        const signature = String(req.headers["webhook-signature"] ?? "");

        let verified: boolean | null = null;
        if (opts.secret && signature) {
          verified = verifySignature({ payload: body, secret: opts.secret, id, timestamp, signatureHeader: signature });
        }

        const badge = verified == null ? color.dim("unverified") : verified ? color.green("verified") : color.red("BAD SIGNATURE");
        let parsed: unknown = body;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* leave as string */
        }
        const type = (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).type) || "event";
        writeOut(`${color.cyan("▶")} ${String(type)}  ${badge}  ${color.dim(new Date().toISOString())}`);
        printJson(parsed);

        if (verified === false) res.writeHead(400).end("invalid signature\n");
        else res.writeHead(200).end("ok\n");
      });

      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      process.stderr.write(
        color.dim(`Listening for webhooks on http://127.0.0.1:${port}${opts.path}  (Ctrl-C to stop)\n`),
      );
      // Keep the process alive until interrupted.
      await new Promise<void>(() => {});
    });
}
