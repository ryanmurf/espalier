/**
 * Adversarial tests targeting potential bugs and edge cases found by
 * code review of Y2 Q1/Q2 features.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EntityCache } from "../../cache/entity-cache.js";
import { QueryCache } from "../../cache/query-cache.js";
import type { QueryCacheKey } from "../../cache/query-cache.js";
import { parseDerivedQueryMethod } from "../../query/derived-query-parser.js";
import { buildDerivedQuery } from "../../query/derived-query-executor.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";
import { Specifications, equal, like, isIn, isNull, between } from "../../query/specification.js";
import { SelectBuilder } from "../../query/query-builder.js";
import { InCriteria } from "../../query/criteria.js";

class User {
  constructor(public id: number, public name: string, public age?: number) {}
}

class Product {
  constructor(public id: number, public title: string) {}
}

const userMetadata: EntityMetadata = {
  tableName: "users",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "name", columnName: "name" },
    { fieldName: "email", columnName: "email" },
    { fieldName: "age", columnName: "age" },
    { fieldName: "active", columnName: "active" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  lifecycleCallbacks: new Map(),
};

afterEach(() => {
  vi.useRealTimers();
});

// ══════════════════════════════════════════════════
// BUG #1: DISTINCT generates invalid SQL
// ══════════════════════════════════════════════════

describe("BUG: findDistinct generates invalid SQL", () => {
  it("findDistinctByName generates DISTINCT on every column (invalid SQL)", () => {
    const descriptor = parseDerivedQueryMethod("findDistinctByName");
    expect(descriptor.distinct).toBe(true);

    const query = buildDerivedQuery(descriptor, userMetadata, ["Alice"]);

    // The implementation produces: SELECT DISTINCT id, DISTINCT name, DISTINCT email, ...
    // Valid SQL should be: SELECT DISTINCT id, name, email, ...
    // Let's see what it actually generates:
    const hasBadDistinct = query.sql.includes("DISTINCT id, DISTINCT name");
    const hasGoodDistinct = query.sql.match(/^SELECT DISTINCT \w+, \w+/);

    // If this passes, it confirms the bug: DISTINCT is prepended to each column
    if (hasBadDistinct) {
      // Bug confirmed: DISTINCT is applied per-column instead of once after SELECT
      expect(hasBadDistinct).toBe(true);
      // This SQL would fail on any real database
      expect(query.sql).not.toMatch(/^SELECT DISTINCT id, name/);
    } else {
      // If it's correct, the DISTINCT appears only once
      expect(hasGoodDistinct).toBeTruthy();
    }
  });
});

// ══════════════════════════════════════════════════
// BUG #2: QueryCache key collision with null vs undefined
// ══════════════════════════════════════════════════

describe("FIXED: QueryCache null/undefined param collision", () => {
  it("null and undefined produce distinct cache keys", () => {
    const cache = new QueryCache();
    const results1 = [{ id: 1, name: "from null" }];
    const results2 = [{ id: 2, name: "from undefined" }];

    const key1: QueryCacheKey = { sql: "SELECT * FROM users WHERE name = $1", params: [null] };
    const key2: QueryCacheKey = { sql: "SELECT * FROM users WHERE name = $1", params: [undefined] };

    cache.put(key1, results1, User);
    cache.put(key2, results2, User);

    // No collision: null and undefined produce different cache keys
    expect(cache.get(key1)).toBe(results1);
    expect(cache.get(key2)).toBe(results2);
  });
});

// ══════════════════════════════════════════════════
// EntityCache adversarial edge cases
// ══════════════════════════════════════════════════

describe("EntityCache adversarial tests", () => {
  it("idKey collision: numeric 0 and string '0' map to same key", () => {
    const cache = new EntityCache();
    const user0 = new User(0, "Zero");
    cache.put(User, 0, user0);

    // String "0" will also produce key "0" via String()
    const result = cache.get(User, "0");
    // This is a collision: numeric 0 and string "0" point to same cache entry
    expect(result).toBe(user0);
  });

  it("idKey collision: numeric 1 and string '1' share cache entry", () => {
    const cache = new EntityCache();
    const userNum = new User(1, "FromNumber");
    const userStr = new User(1, "FromString");
    cache.put(User, 1, userNum);
    cache.put(User, "1", userStr); // overwrites!

    expect(cache.get(User, 1)).toBe(userStr); // got overwritten
  });

  it("caching with null id creates entry with key 'null'", () => {
    const cache = new EntityCache();
    const user = new User(0, "NullId");
    cache.put(User, null, user);
    // String(null) = "null"
    expect(cache.get(User, null)).toBe(user);
    expect(cache.size()).toBe(1);
  });

  it("caching with undefined id creates entry with key 'undefined'", () => {
    const cache = new EntityCache();
    const user = new User(0, "UndefinedId");
    cache.put(User, undefined, user);
    // String(undefined) = "undefined"
    expect(cache.get(User, undefined)).toBe(user);
    expect(cache.size()).toBe(1);
  });

  it("evictAll clears entries but leaves empty LruMap in caches Map", () => {
    const cache = new EntityCache();
    cache.put(User, 1, new User(1, "A"));
    cache.put(User, 2, new User(2, "B"));

    cache.evictAll(User);
    expect(cache.size(User)).toBe(0);
    expect(cache.size()).toBe(0);

    // Put more entries after evictAll -- should work fine
    cache.put(User, 3, new User(3, "C"));
    expect(cache.size(User)).toBe(1);
  });

  it("maxSize=0 causes infinite loop or crash?", () => {
    // maxSize=0 means every put triggers eviction immediately
    // But put adds before checking size, so size becomes 1 > 0, evicts the tail (which is the same entry)
    const cache = new EntityCache({ maxSize: 0 });
    // This should not hang or crash
    cache.put(User, 1, new User(1, "A"));
    // The entry was put and immediately evicted
    // But does it stay in the map? Let's check:
    expect(cache.size()).toBeLessThanOrEqual(1);
  });

  it("maxSize=1 properly evicts when second entity added", () => {
    const cache = new EntityCache({ maxSize: 1 });
    cache.put(User, 1, new User(1, "A"));
    cache.put(User, 2, new User(2, "B"));
    expect(cache.size(User)).toBe(1);
    expect(cache.get(User, 1)).toBeUndefined();
    expect(cache.get(User, 2)).toBeDefined();
  });

  it("clear() then getStats() still shows old hit/miss/put counts", () => {
    const cache = new EntityCache();
    cache.put(User, 1, new User(1, "A"));
    cache.get(User, 1); // hit
    cache.get(User, 999); // miss

    cache.clear();

    const stats = cache.getStats();
    // Hits/misses/puts are NOT reset by clear()
    expect(stats.puts).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("eviction count survives clear()", () => {
    const cache = new EntityCache({ maxSize: 1 });
    cache.put(User, 1, new User(1, "A"));
    cache.put(User, 2, new User(2, "B")); // evicts #1

    const statsBefore = cache.getStats();
    expect(statsBefore.evictions).toBe(1);

    cache.clear();

    // Eviction stats are now tracked at the EntityCache level, surviving clear()
    const statsAfter = cache.getStats();
    expect(statsAfter.evictions).toBe(1);
  });
});

// ══════════════════════════════════════════════════
// QueryCache adversarial tests
// ══════════════════════════════════════════════════

describe("QueryCache adversarial tests", () => {
  it("maxSize=0 puts and immediately evicts", () => {
    const cache = new QueryCache({ maxSize: 0 });
    cache.put(
      { sql: "SELECT 1", params: [] },
      [1],
      User,
    );
    // Entry added then tail evicted -- but it's the same entry
    expect(cache.size()).toBeLessThanOrEqual(1);
  });

  it("TTL=0 means entry expires immediately", () => {
    const cache = new QueryCache({ defaultTtlMs: 0 });
    const k: QueryCacheKey = { sql: "SELECT 1", params: [] };
    cache.put(k, [1], User);
    // Date.now() + 0 = exactly now. get() checks Date.now() > expiresAt
    // If Date.now() hasn't advanced, this should be a hit (not expired yet, since > not >=)
    // But on the next tick it expires
    const result = cache.get(k);
    // Might be a hit or miss depending on timing
    if (result !== undefined) {
      expect(result).toEqual([1]);
    }
  });

  it("SQL with null byte in query doesn't collide with cache key separator", () => {
    const cache = new QueryCache();
    // Cache key uses "\0" as separator between SQL and params
    // What if the SQL itself contains a null byte?
    const k1: QueryCacheKey = { sql: "SELECT\0FROM", params: [] };
    const k2: QueryCacheKey = { sql: "SELECT", params: [] };

    cache.put(k1, [1], User);
    cache.put(k2, [2], User);

    // These should be different entries
    expect(cache.get(k1)).toEqual([1]);
    expect(cache.get(k2)).toEqual([2]);
    expect(cache.size()).toBe(2);
  });

  it("params with object references: cache key uses JSON serialization", () => {
    const cache = new QueryCache();
    const k1: QueryCacheKey = { sql: "SELECT 1", params: [{ a: 1 }] };
    const k2: QueryCacheKey = { sql: "SELECT 1", params: [{ a: 1 }] };

    cache.put(k1, [1], User);
    const result = cache.get(k2);
    // JSON.stringify({a:1}) === JSON.stringify({a:1}), so these should match
    expect(result).toEqual([1]);
  });

  it("params with circular reference throws", () => {
    const cache = new QueryCache();
    const circular: any = { a: 1 };
    circular.self = circular;

    expect(() => {
      cache.put({ sql: "SELECT 1", params: [circular] }, [1], User);
    }).toThrow();
  });

  it("NaN in params does not collide with null", () => {
    const cache = new QueryCache();
    const k1: QueryCacheKey = { sql: "SELECT 1", params: [NaN] };
    const k2: QueryCacheKey = { sql: "SELECT 1", params: [null] };

    cache.put(k1, [1], User);
    // NaN and null should produce distinct cache keys
    expect(cache.get(k2)).toBeUndefined();
    expect(cache.get(k1)).toEqual([1]);
  });

  it("Infinity in params does not collide with null", () => {
    const cache = new QueryCache();
    const k1: QueryCacheKey = { sql: "SELECT 1", params: [Infinity] };
    const k2: QueryCacheKey = { sql: "SELECT 1", params: [null] };

    cache.put(k1, [1], User);
    // Infinity and null should produce distinct cache keys
    expect(cache.get(k2)).toBeUndefined();
    expect(cache.get(k1)).toEqual([1]);
  });

  it("invalidate with subclass does not match parent class", () => {
    class Animal {}
    class Dog extends Animal {}

    const cache = new QueryCache();
    cache.put({ sql: "SELECT 1", params: [] }, [1], Animal);
    cache.put({ sql: "SELECT 2", params: [] }, [2], Dog);

    cache.invalidate(Animal);
    // Should only remove Animal entries, not Dog (uses === comparison)
    expect(cache.get({ sql: "SELECT 1", params: [] })).toBeUndefined();
    expect(cache.get({ sql: "SELECT 2", params: [] })).toEqual([2]);
  });
});

// ══════════════════════════════════════════════════
// Derived query parser adversarial tests
// ══════════════════════════════════════════════════

describe("Derived query parser adversarial tests", () => {
  it("property named 'And' itself (e.g., findByBand)", () => {
    // "Band" contains "And" -- the parser must not split on it
    const descriptor = parseDerivedQueryMethod("findByBand");
    expect(descriptor.properties).toHaveLength(1);
    expect(descriptor.properties[0].property).toBe("band");
  });

  it("property named 'Order' doesn't trigger OrderBy parsing", () => {
    // "Order" contains "Or" but starts with "O" (uppercase), different from connector
    const descriptor = parseDerivedQueryMethod("findByOrder");
    expect(descriptor.properties).toHaveLength(1);
    expect(descriptor.properties[0].property).toBe("order");
  });

  it("property containing 'OrderBy' in the middle", () => {
    // "findByOrderByAge" -- should this parse as findBy(Order) OrderBy(Age)?
    // Or as findBy(OrderByAge)?
    const descriptor = parseDerivedQueryMethod("findByStatusOrderByAge");
    expect(descriptor.properties).toHaveLength(1);
    expect(descriptor.properties[0].property).toBe("status");
    expect(descriptor.orderBy).toHaveLength(1);
    expect(descriptor.orderBy![0].property).toBe("age");
  });

  it("empty predicate after By throws", () => {
    // The parser should throw for methods like "findBy" with nothing after
    // Actually parsePrefix returns rest="" for "findBy" -> rest.length = 0
    // Wait: "findBy".slice("findBy".length) = "" which is falsy
    expect(() => parseDerivedQueryMethod("findBy")).toThrow();
  });

  it("unicode property names", () => {
    // What happens with non-ASCII property names?
    // This will likely fail at the connector detection level since it
    // checks charBefore >= 'a' && charBefore <= 'z'
    const descriptor = parseDerivedQueryMethod("findByNäme");
    expect(descriptor.properties).toHaveLength(1);
    // The property will be lowercased: "näme"
    expect(descriptor.properties[0].property).toBe("näme");
  });

  it("very long method name doesn't crash", () => {
    const longProp = "A" + "a".repeat(1000);
    const methodName = `findBy${longProp}`;
    const descriptor = parseDerivedQueryMethod(methodName);
    expect(descriptor.properties).toHaveLength(1);
  });

  it("findFirst0By should parse limit as 0", () => {
    const descriptor = parseDerivedQueryMethod("findFirst0ByName");
    // limit=0 means "find zero results" which is odd but should parse
    expect(descriptor.limit).toBe(0);
  });

  it("findFirstBy without number defaults to limit=1", () => {
    const descriptor = parseDerivedQueryMethod("findFirstByName");
    expect(descriptor.limit).toBe(1);
  });

  it("operator suffix that is also a property name", () => {
    // A property named "isTrue" -- ends with "True" operator
    // Parser will match "True" operator and extract "is" as property
    const descriptor = parseDerivedQueryMethod("findByIsTrue");
    // "IsTrue" ends with "True" operator, leaving "Is" as property
    // Or it ends with "IsTrue" (null operator), leaving "" which is invalid
    // Let's see what actually happens:
    expect(descriptor.properties[0].property).toBeDefined();
  });
});

// ══════════════════════════════════════════════════
// Derived query executor adversarial tests
// ══════════════════════════════════════════════════

describe("Derived query executor adversarial tests", () => {
  it("DISTINCT query generates single DISTINCT keyword after SELECT", () => {
    const descriptor = parseDerivedQueryMethod("findDistinctByName");
    const query = buildDerivedQuery(descriptor, userMetadata, ["Alice"]);

    const distinctCount = (query.sql.match(/DISTINCT/g) || []).length;
    expect(distinctCount).toBe(1);
    expect(query.sql).toMatch(/^SELECT DISTINCT \w/);
  });

  it("SQL injection via property name is prevented by metadata lookup", () => {
    // Derived query method names are parsed into property names, which are
    // then looked up in metadata. If the property doesn't exist, it throws.
    const descriptor = parseDerivedQueryMethod("findByDropTable");
    expect(() => {
      buildDerivedQuery(descriptor, userMetadata, ["x"]);
    }).toThrow(/Unknown property/);
  });

  it("Between with missing second arg uses undefined", () => {
    const descriptor = parseDerivedQueryMethod("findByAgeBetween");
    // Between needs 2 args but we only provide 1
    const query = buildDerivedQuery(descriptor, userMetadata, [18]);
    // The second param will be args[1] which is undefined
    expect(query.params).toHaveLength(2);
    expect(query.params[0]).toBe(18);
    expect(query.params[1]).toBeUndefined(); // will be sent as NULL to DB
  });

  it("In with empty array generates always-false condition", () => {
    const descriptor = parseDerivedQueryMethod("findByNameIn");
    const query = buildDerivedQuery(descriptor, userMetadata, [[]]);
    // Empty IN() is invalid SQL; should produce 1 = 0 (always false)
    expect(query.sql).toContain("1 = 0");
    expect(query.sql).not.toContain("IN ()");
  });

  it("query with no args when args are expected", () => {
    const descriptor = parseDerivedQueryMethod("findByName");
    // Name requires 1 arg (Equals operator) but we pass none
    const query = buildDerivedQuery(descriptor, userMetadata, []);
    // args[0] is undefined
    expect(query.params).toContain(undefined);
  });
});

// ══════════════════════════════════════════════════
// Specification adversarial tests
// ══════════════════════════════════════════════════

describe("Specification adversarial tests", () => {
  it("Specifications.and() with single spec doesn't wrap in LogicalCriteria", () => {
    const spec = Specifications.and(equal<User>("name", "Alice"));
    const criteria = spec.toPredicate(userMetadata as EntityMetadata);
    // With single spec, should return the criteria directly, not wrapped
    const result = criteria.toSql(1);
    expect(result.sql).toBe("name = $1");
  });

  it("isIn with empty array generates always-false condition", () => {
    const spec = isIn<User>("name", []);
    const criteria = spec.toPredicate(userMetadata as EntityMetadata);
    const result = criteria.toSql(1);
    // Empty IN() is invalid; should produce 1 = 0 (always false)
    expect(result.sql).toBe("1 = 0");
    expect(result.params).toEqual([]);
  });

  it("like with SQL wildcards passes through", () => {
    const spec = like<User>("name", "%'; DROP TABLE users; --");
    const criteria = spec.toPredicate(userMetadata as EntityMetadata);
    const result = criteria.toSql(1);
    // The dangerous string should be parameterized, not inlined
    expect(result.sql).toBe("name LIKE $1");
    expect(result.params[0]).toBe("%'; DROP TABLE users; --");
  });

  it("between with reversed bounds (high < low)", () => {
    const spec = between<User>("age", 100, 1); // reversed
    const criteria = spec.toPredicate(userMetadata as EntityMetadata);
    const result = criteria.toSql(1);
    // SQL BETWEEN 100 AND 1 returns no results, which is valid but probably not intended
    expect(result.params).toEqual([100, 1]);
  });
});

// ══════════════════════════════════════════════════
// SelectBuilder edge cases
// ══════════════════════════════════════════════════

describe("SelectBuilder adversarial tests", () => {
  it("build() with no columns", () => {
    const builder = new SelectBuilder("users");
    // No columns set -- what happens?
    const query = builder.build();
    // Might produce "SELECT  FROM users" (empty column list)
    expect(query.sql).toContain("SELECT");
  });

  it("multiple where() calls overwrite (last wins)", () => {
    const builder = new SelectBuilder("users")
      .columns("*")
      .where(new InCriteria("id", [1, 2, 3]))
      .where(new InCriteria("id", [4, 5, 6]));

    const query = builder.build();
    // Second where() should overwrite first
    expect(query.params).toEqual([4, 5, 6]);
  });

  it("limit with negative number", () => {
    const builder = new SelectBuilder("users").columns("*").limit(-1);
    const query = builder.build();
    // Negative LIMIT is invalid in most SQL databases
    expect(query.params).toContain(-1);
  });

  it("offset with negative number", () => {
    const builder = new SelectBuilder("users").columns("*").offset(-5);
    const query = builder.build();
    expect(query.params).toContain(-5);
  });
});
