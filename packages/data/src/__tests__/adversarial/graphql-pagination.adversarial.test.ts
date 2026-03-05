import { describe, it, expect } from "vitest";
import {
  OffsetPaginationAdapter,
  RelayCursorPaginationAdapter,
  KeysetPaginationAdapter,
  getDefaultPaginationAdapter,
} from "../../graphql/pagination-adapter.js";
import type { GraphQLPaginationAdapter } from "../../graphql/pagination-adapter.js";

// ==========================================================================
// OffsetPaginationAdapter — adversarial
// ==========================================================================

describe("OffsetPaginationAdapter — adversarial", () => {
  const adapter = new OffsetPaginationAdapter();

  it("has name 'offset'", () => {
    expect(adapter.name).toBe("offset");
  });

  describe("generateSharedTypes", () => {
    it("produces PageInfo type with required fields", () => {
      const sdl = adapter.generateSharedTypes();
      expect(sdl).toContain("type PageInfo");
      expect(sdl).toContain("hasNextPage: Boolean!");
      expect(sdl).toContain("hasPreviousPage: Boolean!");
      expect(sdl).toContain("totalElements: Int!");
      expect(sdl).toContain("totalPages: Int!");
      expect(sdl).toContain("page: Int!");
      expect(sdl).toContain("size: Int!");
    });
  });

  describe("generateConnectionType", () => {
    it("produces TypeOffsetConnection with content and pageInfo", () => {
      const sdl = adapter.generateConnectionType("User");
      expect(sdl).toContain("type UserOffsetConnection");
      expect(sdl).toContain("content: [User!]!");
      expect(sdl).toContain("pageInfo: PageInfo!");
    });

    it("works with any type name", () => {
      const sdl = adapter.generateConnectionType("MyLongEntityName");
      expect(sdl).toContain("type MyLongEntityNameOffsetConnection");
    });

    it("empty type name — produces valid but weird SDL", () => {
      const sdl = adapter.generateConnectionType("");
      expect(sdl).toContain("type OffsetConnection");
    });
  });

  describe("generateQueryArgs", () => {
    it("includes page, size, sort with defaults", () => {
      const args = adapter.generateQueryArgs();
      expect(args).toContain("page: Int = 0");
      expect(args).toContain("size: Int = 20");
      expect(args).toContain("sort: String");
    });
  });

  describe("mapResolverArgs", () => {
    it("maps provided args", () => {
      const result = adapter.mapResolverArgs({ page: 2, size: 50, sort: "name,asc" });
      expect(result).toEqual({ page: 2, size: 50, sort: "name,asc" });
    });

    it("defaults page to 0 and size to 20 when not provided", () => {
      const result = adapter.mapResolverArgs({});
      expect(result).toEqual({ page: 0, size: 20, sort: undefined });
    });

    it("null page/size — null ?? fallback applies", () => {
      const result = adapter.mapResolverArgs({ page: null, size: null });
      expect(result.page).toBe(0);
      expect(result.size).toBe(20);
    });

    it("zero page is allowed, zero size throws", () => {
      expect(() => adapter.mapResolverArgs({ page: 0, size: 0 })).toThrow("Invalid size");
    });

    it("negative values throw validation errors", () => {
      expect(() => adapter.mapResolverArgs({ page: -1, size: 10 })).toThrow("Invalid page");
      expect(() => adapter.mapResolverArgs({ page: 0, size: -10 })).toThrow("Invalid size");
    });

    it("extra args are ignored", () => {
      const result = adapter.mapResolverArgs({ page: 1, size: 10, evil: "injection" });
      expect(result).not.toHaveProperty("evil");
    });
  });

  describe("mapResult", () => {
    it("maps Page to GraphQL Connection shape", () => {
      const page = {
        content: [{ id: 1 }, { id: 2 }],
        hasNext: true,
        hasPrevious: false,
        totalElements: 100,
        totalPages: 10,
        page: 0,
        size: 10,
      };
      const result = adapter.mapResult(page) as any;
      expect(result.content).toEqual(page.content);
      expect(result.pageInfo.hasNextPage).toBe(true);
      expect(result.pageInfo.hasPreviousPage).toBe(false);
      expect(result.pageInfo.totalElements).toBe(100);
    });

    it("maps empty page", () => {
      const page = {
        content: [],
        hasNext: false,
        hasPrevious: false,
        totalElements: 0,
        totalPages: 0,
        page: 0,
        size: 10,
      };
      const result = adapter.mapResult(page) as any;
      expect(result.content).toEqual([]);
      expect(result.pageInfo.hasNextPage).toBe(false);
    });

    it("undefined fields in result — passed through as undefined", () => {
      const result = adapter.mapResult({}) as any;
      expect(result.pageInfo.hasNextPage).toBeUndefined();
    });
  });
});

// ==========================================================================
// RelayCursorPaginationAdapter — adversarial
// ==========================================================================

describe("RelayCursorPaginationAdapter — adversarial", () => {
  const adapter = new RelayCursorPaginationAdapter();

  it("has name 'cursor'", () => {
    expect(adapter.name).toBe("cursor");
  });

  describe("generateSharedTypes", () => {
    it("produces RelayPageInfo (not PageInfo — avoids conflict with offset)", () => {
      const sdl = adapter.generateSharedTypes();
      expect(sdl).toContain("type RelayPageInfo");
      expect(sdl).not.toContain("type PageInfo {"); // distinct from offset PageInfo
      expect(sdl).toContain("hasNextPage: Boolean!");
      expect(sdl).toContain("hasPreviousPage: Boolean!");
      expect(sdl).toContain("startCursor: String");
      expect(sdl).toContain("endCursor: String");
    });
  });

  describe("generateConnectionType", () => {
    it("produces Edge and Connection types per Relay spec", () => {
      const sdl = adapter.generateConnectionType("User");
      expect(sdl).toContain("type UserEdge");
      expect(sdl).toContain("node: User!");
      expect(sdl).toContain("cursor: String!");
      expect(sdl).toContain("type UserConnection");
      expect(sdl).toContain("edges: [UserEdge!]!");
      expect(sdl).toContain("pageInfo: RelayPageInfo!");
      expect(sdl).toContain("totalCount: Int!");
    });
  });

  describe("generateQueryArgs", () => {
    it("includes first, after, last, before", () => {
      const args = adapter.generateQueryArgs();
      expect(args).toContain("first: Int");
      expect(args).toContain("after: String");
      expect(args).toContain("last: Int");
      expect(args).toContain("before: String");
    });
  });

  describe("mapResolverArgs", () => {
    it("maps forward pagination args", () => {
      const result = adapter.mapResolverArgs({ first: 10, after: "cursor123" });
      expect(result).toEqual({ first: 10, after: "cursor123", last: undefined, before: undefined });
    });

    it("maps backward pagination args", () => {
      const result = adapter.mapResolverArgs({ last: 5, before: "cursor456" });
      expect(result).toEqual({ first: undefined, after: undefined, last: 5, before: "cursor456" });
    });

    it("empty args — all undefined", () => {
      const result = adapter.mapResolverArgs({});
      expect(result).toEqual({ first: undefined, after: undefined, last: undefined, before: undefined });
    });

    it("first AND last both provided — passed through (no validation)", () => {
      const result = adapter.mapResolverArgs({ first: 10, last: 5 });
      expect(result.first).toBe(10);
      expect(result.last).toBe(5);
    });

    it("negative first — throws validation error", () => {
      expect(() => adapter.mapResolverArgs({ first: -1 })).toThrow("Invalid first");
    });
  });

  describe("mapResult", () => {
    it("passes CursorPage through unchanged", () => {
      const cursorPage = {
        edges: [{ node: { id: 1 }, cursor: "abc" }],
        pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: "abc", endCursor: "abc" },
        totalCount: 100,
      };
      expect(adapter.mapResult(cursorPage)).toBe(cursorPage);
    });

    it("any object passed through — no validation", () => {
      const garbage = { foo: "bar" };
      expect(adapter.mapResult(garbage)).toBe(garbage);
    });
  });
});

// ==========================================================================
// KeysetPaginationAdapter — adversarial
// ==========================================================================

describe("KeysetPaginationAdapter — adversarial", () => {
  const adapter = new KeysetPaginationAdapter();

  it("has name 'keyset'", () => {
    expect(adapter.name).toBe("keyset");
  });

  describe("generateSharedTypes", () => {
    it("returns empty string (no shared types needed)", () => {
      expect(adapter.generateSharedTypes()).toBe("");
    });
  });

  describe("generateConnectionType", () => {
    it("produces KeysetPage type (not Connection)", () => {
      const sdl = adapter.generateConnectionType("User");
      expect(sdl).toContain("type UserKeysetPage");
      expect(sdl).toContain("content: [User!]!");
      expect(sdl).toContain("size: Int!");
      expect(sdl).toContain("hasNext: Boolean!");
      expect(sdl).toContain("lastValue: String");
      expect(sdl).toContain("lastId: String");
    });
  });

  describe("generateQueryArgs", () => {
    it("includes size, sortColumn (required), sortDirection, afterValue, afterId", () => {
      const args = adapter.generateQueryArgs();
      expect(args).toContain("size: Int = 20");
      expect(args).toContain("sortColumn: String!");
      expect(args).toContain('sortDirection: String = "ASC"');
      expect(args).toContain("afterValue: String");
      expect(args).toContain("afterId: String");
    });
  });

  describe("mapResolverArgs", () => {
    it("maps basic args with defaults", () => {
      const result = adapter.mapResolverArgs({ sortColumn: "name" });
      expect(result).toEqual({
        size: 20,
        sortColumn: "name",
        sortDirection: "ASC",
        afterValue: undefined,
        afterId: undefined,
      });
    });

    it("maps all args", () => {
      const result = adapter.mapResolverArgs({
        size: 50,
        sortColumn: "score",
        sortDirection: "desc",
        afterValue: "100",
        afterId: "42",
      });
      expect(result.size).toBe(50);
      expect(result.sortColumn).toBe("score");
      expect(result.sortDirection).toBe("DESC"); // uppercased
      expect(result.afterValue).toBe("100");
      expect(result.afterId).toBe("42");
    });

    it("sortDirection lowercased input — uppercased", () => {
      const result = adapter.mapResolverArgs({ sortColumn: "x", sortDirection: "desc" });
      expect(result.sortDirection).toBe("DESC");
    });

    it("sortDirection missing — defaults to ASC", () => {
      const result = adapter.mapResolverArgs({ sortColumn: "x" });
      expect(result.sortDirection).toBe("ASC");
    });

    it("null size — defaults to 20", () => {
      const result = adapter.mapResolverArgs({ sortColumn: "x", size: null });
      expect(result.size).toBe(20);
    });

    it("missing sortColumn — throws validation error", () => {
      expect(() => adapter.mapResolverArgs({})).toThrow("sortColumn is required");
    });

    it("invalid sortDirection — throws validation error", () => {
      expect(() => adapter.mapResolverArgs({ sortColumn: "x", sortDirection: "INVALID" }))
        .toThrow("Invalid sortDirection");
    });
  });

  describe("mapResult", () => {
    it("maps KeysetPage to GraphQL shape with stringified lastValue/lastId", () => {
      const keysetPage = {
        content: [{ id: 1 }],
        size: 10,
        hasNext: true,
        lastValue: 42,
        lastId: 1,
      };
      const result = adapter.mapResult(keysetPage) as any;
      expect(result.content).toEqual([{ id: 1 }]);
      expect(result.size).toBe(10);
      expect(result.hasNext).toBe(true);
      expect(result.lastValue).toBe("42"); // stringified
      expect(result.lastId).toBe("1"); // stringified
    });

    it("null lastValue/lastId — stays null", () => {
      const page = { content: [], size: 10, hasNext: false, lastValue: null, lastId: null };
      const result = adapter.mapResult(page) as any;
      expect(result.lastValue).toBeNull();
      expect(result.lastId).toBeNull();
    });

    it("undefined lastValue/lastId — becomes null (undefined != null is false)", () => {
      const page = { content: [], size: 10, hasNext: false, lastValue: undefined, lastId: undefined };
      const result = adapter.mapResult(page) as any;
      // undefined != null => false => null branch
      expect(result.lastValue).toBeNull();
      expect(result.lastId).toBeNull();
    });

    it("zero lastValue — stringified to '0'", () => {
      const page = { content: [], size: 10, hasNext: false, lastValue: 0, lastId: 0 };
      const result = adapter.mapResult(page) as any;
      expect(result.lastValue).toBe("0");
      expect(result.lastId).toBe("0");
    });

    it("boolean lastValue — stringified", () => {
      const page = { content: [], size: 10, hasNext: false, lastValue: false, lastId: false };
      const result = adapter.mapResult(page) as any;
      expect(result.lastValue).toBe("false");
      expect(result.lastId).toBe("false");
    });

    it("object lastValue — JSON.stringified", () => {
      const page = { content: [], size: 10, hasNext: false, lastValue: { a: 1 }, lastId: { b: 2 } };
      const result = adapter.mapResult(page) as any;
      expect(result.lastValue).toBe('{"a":1}');
      expect(result.lastId).toBe('{"b":2}');
    });
  });
});

// ==========================================================================
// getDefaultPaginationAdapter
// ==========================================================================

describe("getDefaultPaginationAdapter", () => {
  it("returns OffsetPaginationAdapter", () => {
    const adapter = getDefaultPaginationAdapter();
    expect(adapter.name).toBe("offset");
    expect(adapter).toBeInstanceOf(OffsetPaginationAdapter);
  });

  it("returns new instance each call", () => {
    const a1 = getDefaultPaginationAdapter();
    const a2 = getDefaultPaginationAdapter();
    expect(a1).not.toBe(a2);
  });
});

// ==========================================================================
// Cross-adapter: SDL conflict avoidance
// ==========================================================================

describe("Cross-adapter SDL — adversarial", () => {
  it("offset PageInfo vs relay RelayPageInfo — no name collision", () => {
    const offset = new OffsetPaginationAdapter();
    const relay = new RelayCursorPaginationAdapter();
    const offsetSdl = offset.generateSharedTypes();
    const relaySdl = relay.generateSharedTypes();
    // Verify they use different type names
    expect(offsetSdl).toContain("type PageInfo");
    expect(relaySdl).toContain("type RelayPageInfo");
    expect(relaySdl).not.toContain("type PageInfo {");
  });

  it("offset OffsetConnection vs relay Connection — no collision", () => {
    const offset = new OffsetPaginationAdapter();
    const relay = new RelayCursorPaginationAdapter();
    const offsetConn = offset.generateConnectionType("User");
    const relayConn = relay.generateConnectionType("User");
    expect(offsetConn).toContain("type UserOffsetConnection");
    expect(relayConn).toContain("type UserConnection");
    // No collision — different type names
  });

  it("keyset uses different type name — no collision with Connection", () => {
    const keyset = new KeysetPaginationAdapter();
    const sdl = keyset.generateConnectionType("User");
    expect(sdl).toContain("type UserKeysetPage");
    expect(sdl).not.toContain("type UserConnection");
  });
});

// ==========================================================================
// Adapter interface contract
// ==========================================================================

describe("All adapters implement GraphQLPaginationAdapter", () => {
  const adapters: GraphQLPaginationAdapter[] = [
    new OffsetPaginationAdapter(),
    new RelayCursorPaginationAdapter(),
    new KeysetPaginationAdapter(),
  ];

  for (const adapter of adapters) {
    describe(adapter.name, () => {
      it("has string name", () => {
        expect(typeof adapter.name).toBe("string");
        expect(adapter.name.length).toBeGreaterThan(0);
      });

      it("generateSharedTypes returns string", () => {
        expect(typeof adapter.generateSharedTypes()).toBe("string");
      });

      it("generateConnectionType returns string", () => {
        expect(typeof adapter.generateConnectionType("Test")).toBe("string");
      });

      it("generateQueryArgs returns string", () => {
        expect(typeof adapter.generateQueryArgs()).toBe("string");
      });

      it("mapResolverArgs returns object", () => {
        // Keyset requires sortColumn; offset/relay work with empty args
        if (adapter.name === "keyset") {
          const result = adapter.mapResolverArgs({ sortColumn: "id" });
          expect(typeof result).toBe("object");
        } else {
          const result = adapter.mapResolverArgs({});
          expect(typeof result).toBe("object");
        }
      });

      it("mapResult accepts and returns value", () => {
        const result = adapter.mapResult({});
        expect(result).toBeDefined();
      });
    });
  }
});

// ==========================================================================
// Mixed entity pagination in schema
// ==========================================================================

describe("Mixed pagination adapters — adversarial", () => {
  it("entity A (offset) and entity B (relay) generate different query args", () => {
    const offset = new OffsetPaginationAdapter();
    const relay = new RelayCursorPaginationAdapter();

    const offsetArgs = offset.generateQueryArgs();
    const relayArgs = relay.generateQueryArgs();

    expect(offsetArgs).toContain("page:");
    expect(relayArgs).toContain("first:");
    expect(offsetArgs).not.toContain("first:");
    expect(relayArgs).not.toContain("page:");
  });

  it("entity A (offset) and entity C (keyset) generate different result types", () => {
    const offset = new OffsetPaginationAdapter();
    const keyset = new KeysetPaginationAdapter();

    const offsetConn = offset.generateConnectionType("Order");
    const keysetPage = keyset.generateConnectionType("Product");

    expect(offsetConn).toContain("OrderOffsetConnection");
    expect(keysetPage).toContain("ProductKeysetPage");
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe("Pagination adapter — edge cases", () => {
  it("type name with special chars — passed through to SDL", () => {
    const adapter = new OffsetPaginationAdapter();
    const sdl = adapter.generateConnectionType("My_Entity");
    expect(sdl).toContain("type My_EntityOffsetConnection");
  });

  it("keyset mapResolverArgs with sortDirection null — fallback to ASC via ??", () => {
    const adapter = new KeysetPaginationAdapter();
    const result = adapter.mapResolverArgs({ sortColumn: "x", sortDirection: null });
    // null ?? "ASC" => "ASC"
    expect(result.sortDirection).toBe("ASC");
  });

  it("offset mapResolverArgs with string page — throws validation error", () => {
    const adapter = new OffsetPaginationAdapter();
    expect(() => adapter.mapResolverArgs({ page: "not-a-number" as any, size: 10 })).toThrow("Invalid page");
  });
});
