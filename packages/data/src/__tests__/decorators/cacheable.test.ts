import { describe, expect, it } from "vitest";
import { Cacheable, getCacheableMetadata, registerCacheable } from "../../decorators/cacheable.js";
import { SelectBuilder } from "../../query/query-builder.js";

describe("@Cacheable decorator", () => {
  it("@Cacheable() with no args stores metadata with undefined TTL", () => {
    class Repo {
      @Cacheable()
      findAll() {}
    }
    const repo = new Repo();
    const meta = getCacheableMetadata(repo.constructor, "findAll");
    expect(meta).toBeDefined();
    expect(meta!.ttlMs).toBeUndefined();
  });

  it("@Cacheable(30000) stores metadata with ttlMs=30000", () => {
    class Repo {
      @Cacheable(30000)
      findExpensive() {}
    }
    const repo = new Repo();
    const meta = getCacheableMetadata(repo.constructor, "findExpensive");
    expect(meta).toBeDefined();
    expect(meta!.ttlMs).toBe(30000);
  });

  it("getCacheableMetadata returns undefined for non-decorated methods", () => {
    class Repo {
      findPlain() {}
    }
    const repo = new Repo();
    expect(getCacheableMetadata(repo.constructor, "findPlain")).toBeUndefined();
  });

  it("multiple methods on same class with different TTLs", () => {
    class Repo {
      @Cacheable(5000)
      findShort() {}

      @Cacheable(60000)
      findLong() {}

      @Cacheable()
      findDefault() {}
    }
    const repo = new Repo();
    expect(getCacheableMetadata(repo.constructor, "findShort")!.ttlMs).toBe(5000);
    expect(getCacheableMetadata(repo.constructor, "findLong")!.ttlMs).toBe(60000);
    expect(getCacheableMetadata(repo.constructor, "findDefault")!.ttlMs).toBeUndefined();
  });
});

describe("registerCacheable (programmatic)", () => {
  it("registers cacheable metadata without decorator", () => {
    class MyRepo {}
    registerCacheable(MyRepo, "findByCategory", 10000);
    const meta = getCacheableMetadata(MyRepo, "findByCategory");
    expect(meta).toBeDefined();
    expect(meta!.ttlMs).toBe(10000);
  });

  it("registers with undefined TTL when not specified", () => {
    class MyRepo {}
    registerCacheable(MyRepo, "findAll");
    const meta = getCacheableMetadata(MyRepo, "findAll");
    expect(meta).toBeDefined();
    expect(meta!.ttlMs).toBeUndefined();
  });
});

describe("SelectBuilder .cacheable()", () => {
  it("builder.cacheable() makes isCacheable() return true", () => {
    const builder = new SelectBuilder("users").columns("*").cacheable();
    expect(builder.isCacheable()).toBe(true);
  });

  it("builder.cacheable(5000) makes getCacheTtlMs() return 5000", () => {
    const builder = new SelectBuilder("users").columns("*").cacheable(5000);
    expect(builder.getCacheTtlMs()).toBe(5000);
  });

  it("without cacheable(), isCacheable() returns false", () => {
    const builder = new SelectBuilder("users").columns("*");
    expect(builder.isCacheable()).toBe(false);
    expect(builder.getCacheTtlMs()).toBeUndefined();
  });
});
