import { describe, expect, it } from "vitest";
import { hasMeaningfulSmartCollectionCondition } from "../../src/shared/smart-collection-query";

describe("hasMeaningfulSmartCollectionCondition (CU-M5)", () => {
  it("preserves expression-only and legacy grouped searches when creating a collection", () => {
    expect(hasMeaningfulSmartCollectionCondition({ search: {
      clauses: [], expression: { root: { kind: "TERM", field: "filename", value: "hero" } },
    } })).toBe(true);
    expect(hasMeaningfulSmartCollectionCondition({ search: {
      clauses: [], groups: [[{ field: "filename", values: ["hero"] }]],
    } })).toBe(true);
    expect(hasMeaningfulSmartCollectionCondition({ search: { clauses: [], expression: { root: null } } })).toBe(false);
  });
  it("rejects empty definitions", () => {
    expect(hasMeaningfulSmartCollectionCondition({})).toBe(false);
    expect(
      hasMeaningfulSmartCollectionCondition({ search: { clauses: [] }, filters: [] }),
    ).toBe(false);
  });

  it("rejects sort-only definitions", () => {
    expect(
      hasMeaningfulSmartCollectionCondition({
        sort: { field: "name", order: "asc" },
      }),
    ).toBe(false);
  });

  it("accepts a non-empty search clause", () => {
    expect(
      hasMeaningfulSmartCollectionCondition({
        search: {
          clauses: [{ field: null, values: ["hero"], exclude: false }],
        },
      }),
    ).toBe(true);
  });

  it("accepts at least one filter clause", () => {
    expect(
      hasMeaningfulSmartCollectionCondition({
        filters: [{ field: "favorite", values: [], exclude: false }],
      }),
    ).toBe(true);
  });

  it("accepts search plus filters together", () => {
    expect(
      hasMeaningfulSmartCollectionCondition({
        search: {
          clauses: [{ field: "filename", values: ["cover"], exclude: false }],
        },
        filters: [{ field: "rating", values: ["5"], exclude: false }],
        sort: { field: "rating", order: "desc" },
      }),
    ).toBe(true);
  });
});
