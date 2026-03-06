import { beforeEach, describe, expect, it } from "vitest";
import { getPaginationStrategy, Pagination } from "../../decorators/pagination.js";
import { Table } from "../../decorators/table.js";
import { OffsetPaginationStrategy } from "../../pagination/offset-strategy.js";
import { getGlobalPaginationRegistry, PaginationStrategyRegistry } from "../../pagination/strategy-registry.js";
import type { PaginationStrategy } from "../../pagination/types.js";
import { SelectBuilder } from "../../query/query-builder.js";
import { createPageable } from "../../repository/paging.js";

describe("OffsetPaginationStrategy", () => {
  const strategy = new OffsetPaginationStrategy();

  it("has name 'offset'", () => {
    expect(strategy.name).toBe("offset");
  });

  describe("applyToQuery", () => {
    it("applies LIMIT and OFFSET to SelectBuilder", () => {
      const builder = new SelectBuilder("users").columns("id", "name");
      const pageable = createPageable(2, 10);

      strategy.applyToQuery(builder, pageable);

      const query = builder.build();
      expect(query.sql).toContain("LIMIT");
      expect(query.sql).toContain("OFFSET");
      // page 2, size 10 -> OFFSET 20
      expect(query.params).toContain(10); // LIMIT
      expect(query.params).toContain(20); // OFFSET
    });

    it("applies sort ordering", () => {
      const builder = new SelectBuilder("users").columns("id", "name");
      const pageable = createPageable(0, 10, [
        { property: "name", direction: "ASC" },
        { property: "id", direction: "DESC" },
      ]);

      strategy.applyToQuery(builder, pageable);

      const query = builder.build();
      expect(query.sql).toContain('ORDER BY "name" ASC, "id" DESC');
    });

    it("works with page 0", () => {
      const builder = new SelectBuilder("users").columns("id");
      const pageable = createPageable(0, 5);

      strategy.applyToQuery(builder, pageable);

      const query = builder.build();
      expect(query.params).toContain(5); // LIMIT
      expect(query.params).toContain(0); // OFFSET 0
    });
  });

  describe("buildResult", () => {
    it("creates a Page with correct metadata", () => {
      const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const pageable = createPageable(0, 10);

      const page = strategy.buildResult(rows, pageable, 25);

      expect(page.content).toEqual(rows);
      expect(page.totalElements).toBe(25);
      expect(page.totalPages).toBe(3);
      expect(page.page).toBe(0);
      expect(page.size).toBe(10);
      expect(page.hasNext).toBe(true);
      expect(page.hasPrevious).toBe(false);
    });

    it("last page has hasNext=false", () => {
      const rows = [{ id: 1 }];
      const pageable = createPageable(2, 10);

      const page = strategy.buildResult(rows, pageable, 25);
      expect(page.hasNext).toBe(false);
      expect(page.hasPrevious).toBe(true);
    });

    it("single page has no next or previous", () => {
      const rows = [{ id: 1 }, { id: 2 }];
      const pageable = createPageable(0, 10);

      const page = strategy.buildResult(rows, pageable, 2);
      expect(page.hasNext).toBe(false);
      expect(page.hasPrevious).toBe(false);
      expect(page.totalPages).toBe(1);
    });
  });
});

describe("PaginationStrategyRegistry", () => {
  let registry: PaginationStrategyRegistry;

  beforeEach(() => {
    registry = new PaginationStrategyRegistry();
  });

  it("comes pre-registered with offset strategy", () => {
    expect(registry.has("offset")).toBe(true);
    expect(registry.getNames()).toContain("offset");
  });

  it("get returns the offset strategy", () => {
    const strategy = registry.get("offset");
    expect(strategy.name).toBe("offset");
  });

  it("get throws for unknown strategy", () => {
    expect(() => registry.get("unknown")).toThrow("Unknown pagination strategy");
    expect(() => registry.get("unknown")).toThrow("offset"); // mentions available
  });

  it("register adds a custom strategy", () => {
    const custom: PaginationStrategy = {
      name: "custom",
      applyToQuery() {},
      buildResult(rows) {
        return rows;
      },
    };

    registry.register(custom);
    expect(registry.has("custom")).toBe(true);
    expect(registry.get("custom")).toBe(custom);
  });

  it("register replaces existing strategy", () => {
    const custom: PaginationStrategy = {
      name: "offset",
      applyToQuery() {},
      buildResult() {
        return "custom";
      },
    };

    registry.register(custom);
    expect(registry.get("offset")).toBe(custom);
  });

  it("remove deletes a strategy", () => {
    expect(registry.remove("offset")).toBe(true);
    expect(registry.has("offset")).toBe(false);
  });

  it("remove returns false for non-existent strategy", () => {
    expect(registry.remove("nonexistent")).toBe(false);
  });

  it("getNames lists all registered strategies", () => {
    const custom: PaginationStrategy = {
      name: "custom",
      applyToQuery() {},
      buildResult(rows) {
        return rows;
      },
    };
    registry.register(custom);

    const names = registry.getNames();
    expect(names).toContain("offset");
    expect(names).toContain("custom");
  });
});

describe("getGlobalPaginationRegistry", () => {
  it("returns a registry with offset strategy", () => {
    const registry = getGlobalPaginationRegistry();
    expect(registry.has("offset")).toBe(true);
  });

  it("returns the same instance on repeated calls", () => {
    const r1 = getGlobalPaginationRegistry();
    const r2 = getGlobalPaginationRegistry();
    expect(r1).toBe(r2);
  });
});

describe("@Pagination decorator", () => {
  it("stores pagination strategy on entity class", () => {
    @Table("users")
    @Pagination("cursor")
    class User {
      id = 0;
      name = "";
    }

    expect(getPaginationStrategy(User)).toBe("cursor");
  });

  it("returns undefined for undecorated class", () => {
    class Plain {
      id = 0;
    }
    expect(getPaginationStrategy(Plain)).toBeUndefined();
  });

  it("supports different strategies per entity", () => {
    @Table("users")
    @Pagination("offset")
    class User {
      id = 0;
    }

    @Table("posts")
    @Pagination("keyset")
    class Post {
      id = 0;
    }

    expect(getPaginationStrategy(User)).toBe("offset");
    expect(getPaginationStrategy(Post)).toBe("keyset");
  });
});
