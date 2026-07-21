import { describe, expect, it } from "vitest";

import { OrigamiConfigError } from "../src/api/errors.js";
import { parseFilter, parseRowJson, parseSort, splitList } from "../src/util/filters.js";

describe("parseFilter", () => {
  it("parses a no-value operator", () => {
    expect(parseFilter("website is_not_empty")).toEqual({
      column: "website",
      operator: "is_not_empty",
      value: "",
    });
  });

  it("coerces a numeric value", () => {
    expect(parseFilter("revenue greater_than 1000000")).toEqual({
      column: "revenue",
      operator: "greater_than",
      value: 1000000,
    });
  });

  it("keeps multi-word string values intact", () => {
    expect(parseFilter("company-name contains Acme Corp")).toEqual({
      column: "company-name",
      operator: "contains",
      value: "Acme Corp",
    });
  });

  it("rejects an unknown operator", () => {
    expect(() => parseFilter("x wat 1")).toThrow(OrigamiConfigError);
  });

  it("rejects a bare column", () => {
    expect(() => parseFilter("website")).toThrow(OrigamiConfigError);
  });
});

describe("parseSort", () => {
  it("parses column:direction", () => {
    expect(parseSort("revenue:desc")).toEqual({ column: "revenue", direction: "desc" });
  });

  it("defaults to asc", () => {
    expect(parseSort("name")).toEqual({ column: "name", direction: "asc" });
  });

  it("rejects a bad direction", () => {
    expect(() => parseSort("name:sideways")).toThrow(OrigamiConfigError);
  });
});

describe("parseRowJson", () => {
  it("parses a JSON object", () => {
    expect(parseRowJson('{"domain":"acme.com","name":"Acme"}')).toEqual({ domain: "acme.com", name: "Acme" });
  });

  it("rejects non-objects", () => {
    expect(() => parseRowJson("[1,2,3]")).toThrow(OrigamiConfigError);
    expect(() => parseRowJson("not json")).toThrow(OrigamiConfigError);
  });
});

describe("splitList", () => {
  it("splits and trims a comma list", () => {
    expect(splitList("domain, name ,, email")).toEqual(["domain", "name", "email"]);
  });
});
