import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliContext } from "../src/context.js";
import { renderRows } from "../src/commands/helpers.js";
import { setColorEnabled } from "../src/output/color.js";
import { printItems, type Column } from "../src/output/format.js";

interface Widget {
  id: string;
  name: string;
  count: number;
}

const columns: Column<Widget>[] = [
  { header: "id", get: (w) => w.id },
  { header: "name", get: (w) => w.name },
  { header: "count", get: (w) => w.count },
];

const items: Widget[] = [
  { id: "1", name: "Alpha", count: 3 },
  { id: "2", name: "Beta", count: 10 },
];

let out: string;

function capture(): void {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
}

beforeEach(() => {
  setColorEnabled(false);
  capture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printItems", () => {
  it("renders JSON", () => {
    printItems(items, columns, { format: "json" });
    expect(JSON.parse(out)).toEqual(items);
  });

  it("renders CSV with a header row", () => {
    printItems(items, columns, { format: "csv" });
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("id,name,count");
    expect(lines[1]).toBe("1,Alpha,3");
  });

  it("narrows columns with --fields", () => {
    printItems(items, columns, { format: "csv", fields: ["name"] });
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("name");
    expect(lines[1]).toBe("Alpha");
  });

  it("renders an aligned table", () => {
    printItems(items, columns, { format: "table" });
    expect(out).toContain("id");
    expect(out).toContain("Alpha");
    expect(out).toContain("Beta");
  });
});

describe("renderRows", () => {
  function ctx(format: "json" | "table" | "csv"): CliContext {
    return { format, fields: undefined } as unknown as CliContext;
  }

  it("flattens typed cells to { column: value } in JSON", () => {
    renderRows(ctx("json"), [
      { object: "row", id: "row1", cells: { name: { type: "scalar", value: "Acme" }, ceo: { type: "value", value: "Jane" } } },
    ]);
    expect(JSON.parse(out)).toEqual([{ id: "row1", name: "Acme", ceo: "Jane" }]);
  });

  it("passes flat rows through unchanged", () => {
    renderRows(ctx("json"), [{ name: "Acme", website: "acme.com" }]);
    expect(JSON.parse(out)).toEqual([{ name: "Acme", website: "acme.com" }]);
  });

  it("renders a CSV from typed cells", () => {
    renderRows(ctx("csv"), [{ object: "row", id: "row1", cells: { name: { type: "scalar", value: "Acme" } } }]);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("id,name");
    expect(lines[1]).toBe("row1,Acme");
  });
});
