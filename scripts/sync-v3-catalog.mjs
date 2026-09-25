#!/usr/bin/env node
// Regenerates src/v3/catalog.ts from Origami's published v3 OpenAPI spec.
//
//   pnpm sync:v3                      # fetch https://docs.origami.chat/openapi-v3.yaml
//   pnpm sync:v3 ./openapi-v3.yaml    # or read a local copy
//
// The catalog is the single source for every `origami jobs|account|leads|send`
// command: one entry per operation, with its path/query parameters and the
// top-level request-body fields the CLI turns into flags.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const SPEC_URL = "https://docs.origami.chat/openapi-v3.yaml";
const METHODS = ["get", "post", "put", "patch", "delete"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "src", "v3", "catalog.ts");

async function loadSpec(source) {
  if (source) return parse(readFileSync(source, "utf8"));
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`GET ${SPEC_URL} → ${res.status}`);
  return parse(await res.text());
}

function makeResolver(spec) {
  const resolve = (node) => {
    if (node && typeof node === "object" && typeof node.$ref === "string") {
      const target = node.$ref
        .replace(/^#\//, "")
        .split("/")
        .reduce((o, k) => (o == null ? undefined : o[k]), spec);
      if (target == null) throw new Error(`Unresolvable $ref ${node.$ref}`);
      return resolve(target);
    }
    return node;
  };
  return resolve;
}

/** First line of a description, trimmed, markdown emphasis stripped. */
function oneLine(text) {
  if (!text) return undefined;
  const line = String(text).trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1") || undefined;
}

/** Classify a schema into the value kinds the CLI knows how to parse. */
function kindOf(schema, resolve) {
  const s = resolve(schema) ?? {};
  let type = s.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null");
  if (!type && (s.oneOf || s.anyOf || s.allOf)) return { kind: "json" };
  if (!type && s.enum) type = "string";
  if (!type && s.properties) type = "object";
  switch (type) {
    case "string":
      return { kind: "string", ...(Array.isArray(s.enum) ? { enum: s.enum.filter((v) => v != null).map(String) } : {}) };
    case "integer":
      return { kind: "integer" };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "array": {
      const item = resolve(s.items) ?? {};
      let itemType = item.type;
      if (Array.isArray(itemType)) itemType = itemType.find((t) => t !== "null");
      if (itemType === "string" || itemType === "integer" || itemType === "number") {
        return { kind: "list", ...(itemType === "string" ? {} : { itemKind: itemType }) };
      }
      return { kind: "json" };
    }
    default:
      return { kind: "json" };
  }
}

function build(spec) {
  const resolve = makeResolver(spec);
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;

      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
        .map(resolve)
        .filter((p) => p.in === "path" || p.in === "query")
        .map((p) => ({
          name: p.name,
          in: p.in,
          required: Boolean(p.required || p.in === "path"),
          ...kindOf(p.schema, resolve),
          ...(oneLine(p.description) ? { description: oneLine(p.description) } : {}),
        }));

      // Path params in template order so positionals read left to right.
      const order = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      params.sort((a, b) => {
        if (a.in !== b.in) return a.in === "path" ? -1 : 1;
        if (a.in === "path") return order.indexOf(a.name) - order.indexOf(b.name);
        return 0;
      });

      const bodySchema = resolve(resolve(op.requestBody)?.content?.["application/json"]?.schema);
      const required = new Set(bodySchema?.required ?? []);
      const body = bodySchema
        ? Object.entries(bodySchema.properties ?? {}).map(([name, schema]) => ({
            name,
            required: required.has(name),
            ...kindOf(schema, resolve),
            ...(oneLine(resolve(schema)?.description) ? { description: oneLine(resolve(schema).description) } : {}),
          }))
        : undefined;

      // Response bodies are typed only for 202 (the shared Job); lists are recognized by
      // their `cursor` parameter, which every `{ object: "list" }` endpoint takes.
      const accepted = resolve(op.responses?.["202"])?.content?.["application/json"]?.schema;
      const returnsJob = String(accepted?.$ref ?? "").endsWith("/Job");
      const isList = method === "get" && params.some((p) => p.in === "query" && p.name === "cursor");

      ops.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        summary: oneLine(op.summary) ?? op.operationId,
        ...(op.tags?.[0] ? { tag: op.tags[0] } : {}),
        params,
        ...(body ? { body, bodyRequired: Boolean(resolve(op.requestBody)?.required) } : {}),
        ...(returnsJob ? { returnsJob: true } : {}),
        ...(isList ? { paginated: true } : {}),
        ...(op["x-mint"]?.href ? { docs: `https://docs.origami.chat${op["x-mint"].href}` } : {}),
      });
    }
  }
  return ops;
}

const spec = await loadSpec(process.argv[2]);
const ops = build(spec);

const header = `// AUTO-GENERATED by scripts/sync-v3-catalog.mjs from Origami's v3 OpenAPI spec
// (${SPEC_URL}, info.version ${JSON.stringify(spec.info?.version ?? "?")}). Do not hand-edit:
// run \`pnpm sync:v3\` to regenerate.

import type { V3Operation } from "./types.js";

export const V3_SPEC_VERSION = ${JSON.stringify(String(spec.info?.version ?? "?"))};

export const V3_OPERATIONS: V3Operation[] = `;

writeFileSync(outPath, `${header}${JSON.stringify(ops, null, 2)};\n`);
process.stdout.write(`Wrote ${ops.length} operations to ${outPath}\n`);
