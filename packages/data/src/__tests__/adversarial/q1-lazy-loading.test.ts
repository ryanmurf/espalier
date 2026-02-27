/**
 * Adversarial tests for proxy-based lazy loading (Y3 Q1).
 * Covers: proxy creation, initialization, thenable behavior, concurrent access,
 * isLazyProxy/isInitialized/initializeProxy utilities, edge cases.
 * Repository E2E tests are in packages/jdbc-pg/src/__tests__/e2e/pg-lazy-loading.e2e.test.ts
 */
import { describe, it, expect, vi } from "vitest";
import {
  isLazyProxy,
  isInitialized,
  initializeProxy,
} from "../../index.js";
import {
  createLazySingleProxy,
  createLazyCollectionProxy,
} from "../../repository/lazy-proxy.js";

// ══════════════════════════════════════════════════
// Section 1: createLazySingleProxy
// ══════════════════════════════════════════════════

describe("Lazy proxy adversarial: single-valued proxy", () => {
  it("isLazyProxy returns true for lazy single proxy", () => {
    const proxy = createLazySingleProxy(async () => ({ id: 1, name: "test" }));
    expect(isLazyProxy(proxy)).toBe(true);
  });

  it("isInitialized returns false before access, true after await", async () => {
    const proxy = createLazySingleProxy(async () => ({ id: 1, name: "test" }));
    expect(isInitialized(proxy)).toBe(false);

    const loaded = await proxy;
    expect(isInitialized(proxy)).toBe(true);
    expect(loaded).toEqual({ id: 1, name: "test" });
  });

  it("synchronous property access before init returns undefined", () => {
    const proxy = createLazySingleProxy(async () => ({ id: 1, name: "test" }));
    // Synchronous access does NOT trigger load
    expect((proxy as any).name).toBeUndefined();
    expect(isInitialized(proxy)).toBe(false);
  });

  it("await triggers load and subsequent property access works", async () => {
    const proxy = createLazySingleProxy(async () => ({ id: 1, name: "test" }));
    await proxy;
    expect((proxy as any).name).toBe("test");
    expect((proxy as any).id).toBe(1);
  });

  it("second await returns cached value — no second query", async () => {
    const initializer = vi.fn().mockResolvedValue({ id: 1, name: "test" });
    const proxy = createLazySingleProxy(initializer);

    await proxy;
    await proxy;
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  it("initializeProxy loads the value and the proxy reflects initialization", async () => {
    const initializer = vi.fn().mockResolvedValue({ id: 1, name: "loaded" });
    const proxy = createLazySingleProxy(initializer);
    expect(isInitialized(proxy)).toBe(false);

    const value = await initializeProxy(proxy);
    expect(value).toEqual({ id: 1, name: "loaded" });
    // initializeProxy calls the raw initializer — check whether proxy state is updated
    // (implementation may or may not update proxy state depending on whether
    // the same initializer function triggers the ensureInitialized path)
    // After awaiting, check the actual behavior:
    expect(isInitialized(proxy)).toBe(true);
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  it("proxy resolves to null when initializer returns null", async () => {
    const proxy = createLazySingleProxy(async () => null);
    const loaded = await proxy;
    expect(loaded).toBeNull();
    expect(isInitialized(proxy)).toBe(true);
  });

  it("property access after loading null returns undefined", async () => {
    const proxy = createLazySingleProxy(async () => null);
    await proxy;
    expect((proxy as any).name).toBeUndefined();
  });

  it("typeof on lazy proxy is 'object'", () => {
    const proxy = createLazySingleProxy(async () => ({ id: 1 }));
    expect(typeof proxy).toBe("object");
  });

  it("concurrent awaits share a single initializer call", async () => {
    let callCount = 0;
    const proxy = createLazySingleProxy(async () => {
      callCount++;
      // Small delay to simulate async DB query
      await new Promise(r => setTimeout(r, 10));
      return { id: 42 };
    });

    // Start two concurrent awaits
    const [r1, r2] = await Promise.all([
      (async () => await proxy)(),
      (async () => await proxy)(),
    ]);
    expect(r1).toEqual({ id: 42 });
    expect(r2).toEqual({ id: 42 });
    expect(callCount).toBe(1);
  });

  it("initializer error propagates to await", async () => {
    const proxy = createLazySingleProxy(async () => {
      throw new Error("DB connection failed");
    });
    await expect((async () => await proxy)()).rejects.toThrow("DB connection failed");
  });

  it("set on proxy before initialization is a no-op", () => {
    const proxy = createLazySingleProxy(async () => ({ id: 1, name: "test" }));
    // Setting before init — should not throw
    (proxy as any).name = "changed";
    // Still uninitialized, no effect
    expect(isInitialized(proxy)).toBe(false);
  });

  it("set on proxy after initialization delegates to loaded object", async () => {
    const target = { id: 1, name: "test" };
    const proxy = createLazySingleProxy(async () => target);
    await proxy;
    (proxy as any).name = "changed";
    expect((proxy as any).name).toBe("changed");
    expect(target.name).toBe("changed");
  });

  it("has trap works after initialization", async () => {
    const proxy = createLazySingleProxy(async () => ({ id: 1, name: "test" }));
    expect("name" in proxy).toBe(false); // before init
    await proxy;
    expect("name" in proxy).toBe(true); // after init
    expect("missing" in proxy).toBe(false);
  });

  it("ownKeys returns empty before init, actual keys after", async () => {
    const proxy = createLazySingleProxy(async () => ({ id: 1, name: "test" }));
    expect(Object.keys(proxy)).toEqual([]);
    await proxy;
    expect(Object.keys(proxy).sort()).toEqual(["id", "name"]);
  });
});

// ══════════════════════════════════════════════════
// Section 2: createLazyCollectionProxy
// ══════════════════════════════════════════════════

describe("Lazy proxy adversarial: collection proxy", () => {
  it("isLazyProxy returns true for lazy collection proxy", () => {
    const proxy = createLazyCollectionProxy(async () => [1, 2, 3]);
    expect(isLazyProxy(proxy)).toBe(true);
  });

  it("isInitialized false before access, true after await", async () => {
    const proxy = createLazyCollectionProxy(async () => [1, 2, 3]);
    expect(isInitialized(proxy)).toBe(false);
    const loaded = await proxy;
    expect(isInitialized(proxy)).toBe(true);
    expect(loaded).toEqual([1, 2, 3]);
  });

  it("synchronous .length returns 0 before initialization", () => {
    const proxy = createLazyCollectionProxy(async () => [1, 2, 3]);
    expect(proxy.length).toBe(0);
    expect(isInitialized(proxy)).toBe(false);
  });

  it("after await, .length returns actual count", async () => {
    const proxy = createLazyCollectionProxy(async () => [1, 2, 3]);
    await proxy;
    expect(proxy.length).toBe(3);
  });

  it("array methods work after initialization", async () => {
    const proxy = createLazyCollectionProxy(async () => [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    await proxy;
    expect(proxy.map(x => x.name)).toEqual(["a", "b"]);
    expect(proxy.filter(x => x.id > 1)).toEqual([{ id: 2, name: "b" }]);
    expect(proxy.find(x => x.name === "a")).toEqual({ id: 1, name: "a" });
  });

  it("empty collection resolves to empty array", async () => {
    const proxy = createLazyCollectionProxy(async () => []);
    const loaded = await proxy;
    expect(loaded).toEqual([]);
    expect(proxy.length).toBe(0);
  });

  it("second await returns cached — initializer called once", async () => {
    const initializer = vi.fn().mockResolvedValue([1, 2, 3]);
    const proxy = createLazyCollectionProxy(initializer);
    await proxy;
    await proxy;
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  it("concurrent awaits share single initializer call", async () => {
    let callCount = 0;
    const proxy = createLazyCollectionProxy(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 10));
      return [10, 20, 30];
    });

    const [r1, r2] = await Promise.all([
      (async () => await proxy)(),
      (async () => await proxy)(),
    ]);
    expect(r1).toEqual([10, 20, 30]);
    expect(r2).toEqual([10, 20, 30]);
    expect(callCount).toBe(1);
  });

  it("initializeProxy force-loads collection proxy", async () => {
    const proxy = createLazyCollectionProxy(async () => [42]);
    const value = await initializeProxy(proxy);
    expect(value).toEqual([42]);
    expect(isInitialized(proxy)).toBe(true);
  });

  it("initializer error propagates to await", async () => {
    const proxy = createLazyCollectionProxy(async () => {
      throw new Error("Load failed");
    });
    await expect((async () => await proxy)()).rejects.toThrow("Load failed");
  });

  it("for...of works after initialization", async () => {
    const proxy = createLazyCollectionProxy(async () => [1, 2, 3]);
    await proxy;
    const collected: number[] = [];
    for (const item of proxy) {
      collected.push(item);
    }
    expect(collected).toEqual([1, 2, 3]);
  });

  it("spread works after initialization", async () => {
    const proxy = createLazyCollectionProxy(async () => [1, 2, 3]);
    await proxy;
    const spread = [...proxy];
    expect(spread).toEqual([1, 2, 3]);
  });
});

// ══════════════════════════════════════════════════
// Section 3: isLazyProxy / isInitialized / initializeProxy edge cases
// ══════════════════════════════════════════════════

describe("Lazy proxy adversarial: utility functions", () => {
  it("isLazyProxy returns false for null", () => {
    expect(isLazyProxy(null)).toBe(false);
  });

  it("isLazyProxy returns false for undefined", () => {
    expect(isLazyProxy(undefined)).toBe(false);
  });

  it("isLazyProxy returns false for plain objects", () => {
    expect(isLazyProxy({ id: 1 })).toBe(false);
    expect(isLazyProxy([])).toBe(false);
    expect(isLazyProxy("string")).toBe(false);
    expect(isLazyProxy(42)).toBe(false);
  });

  it("isInitialized returns true for non-proxy values", () => {
    expect(isInitialized(null)).toBe(true);
    expect(isInitialized(undefined)).toBe(true);
    expect(isInitialized({ id: 1 })).toBe(true);
    expect(isInitialized([1, 2])).toBe(true);
  });

  it("initializeProxy returns non-proxy values as-is", async () => {
    const obj = { id: 1, name: "test" };
    const result = await initializeProxy(obj);
    expect(result).toBe(obj); // same reference
  });

  it("initializeProxy on null returns null", async () => {
    const result = await initializeProxy(null);
    expect(result).toBeNull();
  });
});

// ══════════════════════════════════════════════════
// Section 4: Decorator metadata for lazy: true
// ══════════════════════════════════════════════════

import {
  Table,
  Column,
  Id,
  ManyToOne,
  OneToMany,
  OneToOne,
  ManyToMany,
  getManyToOneRelations,
  getOneToManyRelations,
  getOneToOneRelations,
  getManyToManyRelations,
} from "../../index.js";

describe("Lazy proxy adversarial: decorator metadata", () => {
  it("@ManyToOne with lazy: true stores lazy flag in metadata", () => {
    @Table("lz_m2o_target")
    class LzTarget { @Id @Column() id: number = 0; }

    @Table("lz_m2o")
    class LzEntity {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => LzTarget, lazy: true })
      ref!: LzTarget;
    }
    new LzTarget(); new LzEntity();

    const rels = getManyToOneRelations(LzEntity);
    expect(rels[0].lazy).toBe(true);
  });

  it("@ManyToOne without lazy defaults to false", () => {
    @Table("lz_m2o_d_target")
    class LzDTarget { @Id @Column() id: number = 0; }

    @Table("lz_m2o_d")
    class LzDEntity {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => LzDTarget })
      ref!: LzDTarget;
    }
    new LzDTarget(); new LzDEntity();

    const rels = getManyToOneRelations(LzDEntity);
    expect(rels[0].lazy).toBe(false);
  });

  it("@OneToOne with lazy: true stores lazy flag", () => {
    @Table("lz_o2o_target")
    class LzO2OTarget { @Id @Column() id: number = 0; }

    @Table("lz_o2o")
    class LzO2OEntity {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => LzO2OTarget, lazy: true })
      ref!: LzO2OTarget;
    }
    new LzO2OTarget(); new LzO2OEntity();

    const rels = getOneToOneRelations(LzO2OEntity);
    expect(rels[0].lazy).toBe(true);
  });

  it("@OneToMany with lazy: true stores lazy flag", () => {
    @Table("lz_o2m_child")
    class LzChild {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => LzParent }) parent!: LzParent;
    }

    @Table("lz_o2m_parent")
    class LzParent {
      @Id @Column() id: number = 0;
      @OneToMany({ target: () => LzChild, mappedBy: "parent", lazy: true })
      children!: LzChild[];
    }
    new LzChild(); new LzParent();

    const rels = getOneToManyRelations(LzParent);
    expect(rels[0].lazy).toBe(true);
  });

  it("@ManyToMany with lazy: true stores lazy flag", () => {
    @Table("lz_m2m_tag")
    class LzTag { @Id @Column() id: number = 0; }

    @Table("lz_m2m_post")
    class LzPost {
      @Id @Column() id: number = 0;
      @ManyToMany({
        target: () => LzTag,
        joinTable: { name: "lz_m2m_post_tag", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
        lazy: true,
      })
      tags!: LzTag[];
    }
    new LzTag(); new LzPost();

    const rels = getManyToManyRelations(LzPost);
    expect(rels[0].lazy).toBe(true);
  });

  it("mixed lazy and eager on same entity", () => {
    @Table("lz_mix_dept")
    class LzMDept { @Id @Column() id: number = 0; }

    @Table("lz_mix_tag")
    class LzMTag { @Id @Column() id: number = 0; }

    @Table("lz_mix_child")
    class LzMChild {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => LzMParent }) parent!: LzMParent;
    }

    @Table("lz_mix_parent")
    class LzMParent {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => LzMDept, fetch: "JOIN" })
      dept!: LzMDept; // eager JOIN
      @OneToMany({ target: () => LzMChild, mappedBy: "parent", lazy: true })
      children!: LzMChild[]; // lazy
      @ManyToMany({
        target: () => LzMTag,
        joinTable: { name: "lz_mix_pt", joinColumn: "p_id", inverseJoinColumn: "t_id" },
        lazy: true,
      })
      tags!: LzMTag[]; // lazy
    }
    new LzMDept(); new LzMTag(); new LzMChild(); new LzMParent();

    const m2o = getManyToOneRelations(LzMParent);
    expect(m2o[0].lazy).toBe(false);
    expect(m2o[0].fetchStrategy).toBe("JOIN");

    const o2m = getOneToManyRelations(LzMParent);
    expect(o2m[0].lazy).toBe(true);

    const m2m = getManyToManyRelations(LzMParent);
    expect(m2m[0].lazy).toBe(true);
  });
});
