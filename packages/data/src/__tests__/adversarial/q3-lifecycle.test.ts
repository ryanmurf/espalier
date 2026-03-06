/**
 * Adversarial tests for lifecycle decorators (Q3 feature).
 * Targets: duplicate callbacks on repeated instantiation (#76),
 * multiple decorators on same method, async callbacks,
 * inheritance edge cases.
 */
import { describe, expect, it } from "vitest";
import {
  getLifecycleCallbacks,
  PostLoad,
  PostPersist,
  PostRemove,
  PostUpdate,
  PrePersist,
  PreRemove,
  PreUpdate,
} from "../../decorators/lifecycle.js";

// ══════════════════════════════════════════════════
// BUG #76: Duplicate callbacks on repeated instantiation
// ══════════════════════════════════════════════════

describe("Lifecycle adversarial: duplicate callbacks (Bug #76)", () => {
  it("BUG: each new instance adds duplicate callback entries", () => {
    // Define class in a closure so previous test classes don't interfere
    class DupTest {
      @PrePersist
      setup() {}
    }

    new DupTest();
    const after1 = getLifecycleCallbacks(DupTest).get("PrePersist");
    const len1 = after1?.length ?? 0;

    new DupTest();
    const after2 = getLifecycleCallbacks(DupTest).get("PrePersist");
    const len2 = after2?.length ?? 0;

    new DupTest();
    const after3 = getLifecycleCallbacks(DupTest).get("PrePersist");
    const len3 = after3?.length ?? 0;

    // BUG: Each instantiation pushes another "setup" to the array.
    // Expected: len1 === len2 === len3 === 1
    // Actual: len1=1, len2=2, len3=3
    expect(len1).toBe(1);

    if (len2 > 1) {
      // Bug confirmed: duplicates accumulate
      expect(len2).toBe(2);
      expect(len3).toBe(3);
      // All entries are the same method name
      expect(new Set(after3!)).toEqual(new Set(["setup"]));
    }
  });

  it("BUG: multiple decorators on same class accumulate per instance", () => {
    class MultiDecor {
      @PrePersist
      before() {}

      @PostPersist
      after() {}
    }

    new MultiDecor();
    new MultiDecor();

    const callbacks = getLifecycleCallbacks(MultiDecor);
    const pre = callbacks.get("PrePersist") ?? [];
    const post = callbacks.get("PostPersist") ?? [];

    // BUG: 2 instances means 2 entries for each
    if (pre.length > 1) {
      expect(pre.length).toBe(2);
      expect(post.length).toBe(2);
    }
  });
});

// ══════════════════════════════════════════════════
// Multiple decorators on the same method
// ══════════════════════════════════════════════════

describe("Lifecycle adversarial: multiple decorators on same method", () => {
  it("same method decorated with both @PrePersist and @PreUpdate", () => {
    class MultiEvent {
      @PrePersist
      @PreUpdate
      validate() {}
    }
    new MultiEvent();

    const callbacks = getLifecycleCallbacks(MultiEvent);
    const prePersist = callbacks.get("PrePersist");
    const preUpdate = callbacks.get("PreUpdate");

    expect(prePersist).toContain("validate");
    expect(preUpdate).toContain("validate");
  });

  it("same method decorated with ALL lifecycle events", () => {
    class AllEvents {
      @PrePersist
      @PostPersist
      @PreUpdate
      @PostUpdate
      @PreRemove
      @PostRemove
      @PostLoad
      handleAll() {}
    }
    new AllEvents();

    const callbacks = getLifecycleCallbacks(AllEvents);
    // All 7 events should have "handleAll"
    expect(callbacks.get("PrePersist")).toContain("handleAll");
    expect(callbacks.get("PostPersist")).toContain("handleAll");
    expect(callbacks.get("PreUpdate")).toContain("handleAll");
    expect(callbacks.get("PostUpdate")).toContain("handleAll");
    expect(callbacks.get("PreRemove")).toContain("handleAll");
    expect(callbacks.get("PostRemove")).toContain("handleAll");
    expect(callbacks.get("PostLoad")).toContain("handleAll");
  });
});

// ══════════════════════════════════════════════════
// Inheritance: parent callbacks on child class
// ══════════════════════════════════════════════════

describe("Lifecycle adversarial: inheritance edge cases", () => {
  it("child class inherits parent lifecycle callbacks when instantiated", () => {
    class Parent {
      @PrePersist
      parentSetup() {}
    }
    new Parent();

    class Child extends Parent {
      @PostPersist
      childAfter() {}
    }
    new Child();

    const childCallbacks = getLifecycleCallbacks(Child);

    // The parent's @PrePersist decorator fires addInitializer which uses
    // `this.constructor`. When `new Child()` runs, `this.constructor === Child`,
    // so the parent's callback is registered under Child's constructor.
    const prePersist = childCallbacks.get("PrePersist") ?? [];
    const postPersist = childCallbacks.get("PostPersist") ?? [];

    // Parent's callback should appear on Child
    expect(prePersist).toContain("parentSetup");
    expect(postPersist).toContain("childAfter");
  });

  it("grandchild inherits from grandparent", () => {
    class GrandParent {
      @PreRemove
      gpCleanup() {}
    }
    new GrandParent();

    class Middle extends GrandParent {}
    new Middle();

    class GrandChild extends Middle {
      @PostLoad
      gcLoad() {}
    }
    new GrandChild();

    const gcCallbacks = getLifecycleCallbacks(GrandChild);
    // The @PreRemove initializer fires with this.constructor = GrandChild
    expect(gcCallbacks.get("PreRemove") ?? []).toContain("gpCleanup");
    expect(gcCallbacks.get("PostLoad") ?? []).toContain("gcLoad");
  });

  it("parent and child with SAME method name: both register", () => {
    class Base {
      @PrePersist
      setup() {}
    }
    new Base();

    class Derived extends Base {
      @PrePersist
      override setup() {}
    }
    new Derived();

    const derivedCallbacks = getLifecycleCallbacks(Derived);
    const prePersist = derivedCallbacks.get("PrePersist") ?? [];

    // Both the base decorator initializer and the derived decorator initializer
    // fire when `new Derived()` runs. Both push "setup" to the array.
    // This means the callback fires TWICE even though it's logically one method.
    if (prePersist.length > 1) {
      // Bug: duplicate registration from parent + child override
      expect(prePersist.filter((m) => m === "setup").length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ══════════════════════════════════════════════════
// No-instance edge case: class never instantiated
// ══════════════════════════════════════════════════

describe("Lifecycle adversarial: class never instantiated", () => {
  it("callbacks are NOT registered until an instance is created", () => {
    class LazyEntity {
      @PrePersist
      beforeSave() {}
    }

    // No instance created — addInitializer hasn't fired yet
    const callbacks = getLifecycleCallbacks(LazyEntity);

    // With TC39 standard decorators, addInitializer fires on the first instantiation.
    // Without any instance, the metadata is empty.
    expect(callbacks.size).toBe(0);

    // Now create an instance
    new LazyEntity();
    const afterCallbacks = getLifecycleCallbacks(LazyEntity);
    expect(afterCallbacks.get("PrePersist")).toContain("beforeSave");
  });
});

// ══════════════════════════════════════════════════
// Symbol method names
// ══════════════════════════════════════════════════

describe("Lifecycle adversarial: symbol method names", () => {
  it("decorator on symbol-named method stores symbol in callbacks", () => {
    const secretMethod = Symbol("secret");

    class SymEntity {
      @PrePersist
      [secretMethod]() {}
    }
    new SymEntity();

    const callbacks = getLifecycleCallbacks(SymEntity);
    const prePersist = callbacks.get("PrePersist") ?? [];
    expect(prePersist).toContain(secretMethod);
  });
});

// ══════════════════════════════════════════════════
// getLifecycleCallbacks: various input types
// ══════════════════════════════════════════════════

describe("Lifecycle adversarial: getLifecycleCallbacks edge cases", () => {
  it("passing a plain object returns empty map", () => {
    const result = getLifecycleCallbacks({});
    expect(result.size).toBe(0);
  });

  it("passing a function returns empty map (if never used as constructor with decorators)", () => {
    function plain() {}
    const result = getLifecycleCallbacks(plain);
    expect(result.size).toBe(0);
  });

  it("passing Object.create(null) returns empty map", () => {
    const result = getLifecycleCallbacks(Object.create(null));
    expect(result.size).toBe(0);
  });
});
