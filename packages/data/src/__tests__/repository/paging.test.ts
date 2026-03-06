import { describe, expect, it } from "vitest";
import { createPage, createPageable } from "../../repository/paging.js";

describe("createPageable", () => {
  it("returns page, size, and sort", () => {
    const pageable = createPageable(0, 10, [{ property: "name", direction: "ASC" }]);
    expect(pageable.page).toBe(0);
    expect(pageable.size).toBe(10);
    expect(pageable.sort).toEqual([{ property: "name", direction: "ASC" }]);
  });

  it("sort is undefined when not provided", () => {
    const pageable = createPageable(2, 25);
    expect(pageable.page).toBe(2);
    expect(pageable.size).toBe(25);
    expect(pageable.sort).toBeUndefined();
  });

  it("works with multiple sort entries", () => {
    const pageable = createPageable(0, 10, [
      { property: "lastName", direction: "ASC" },
      { property: "firstName", direction: "DESC" },
    ]);
    expect(pageable.sort).toHaveLength(2);
  });
});

describe("createPage", () => {
  it("calculates totalPages correctly", () => {
    const pageable = createPageable(0, 10);
    const page = createPage(["a", "b"], pageable, 25);
    expect(page.totalPages).toBe(3); // ceil(25/10) = 3
    expect(page.totalElements).toBe(25);
    expect(page.content).toEqual(["a", "b"]);
    expect(page.page).toBe(0);
    expect(page.size).toBe(10);
  });

  it("sets hasNext true when not on the last page", () => {
    const pageable = createPageable(0, 10);
    const page = createPage([], pageable, 25);
    expect(page.hasNext).toBe(true);
  });

  it("sets hasNext false on the last page", () => {
    const pageable = createPageable(2, 10);
    const page = createPage([], pageable, 25);
    expect(page.hasNext).toBe(false); // page 2, totalPages 3, 2 < 3-1 is false
  });

  it("sets hasPrevious false on the first page", () => {
    const pageable = createPageable(0, 10);
    const page = createPage([], pageable, 25);
    expect(page.hasPrevious).toBe(false);
  });

  it("sets hasPrevious true on page > 0", () => {
    const pageable = createPageable(1, 10);
    const page = createPage([], pageable, 25);
    expect(page.hasPrevious).toBe(true);
  });

  it("handles zero total elements", () => {
    const pageable = createPageable(0, 10);
    const page = createPage([], pageable, 0);
    expect(page.totalPages).toBe(0);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrevious).toBe(false);
    expect(page.content).toEqual([]);
  });

  it("handles single-page result", () => {
    const pageable = createPageable(0, 10);
    const page = createPage([1, 2, 3], pageable, 3);
    expect(page.totalPages).toBe(1);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrevious).toBe(false);
  });

  it("handles exact page boundary", () => {
    const pageable = createPageable(0, 5);
    const page = createPage([1, 2, 3, 4, 5], pageable, 10);
    expect(page.totalPages).toBe(2);
    expect(page.hasNext).toBe(true);
  });
});
