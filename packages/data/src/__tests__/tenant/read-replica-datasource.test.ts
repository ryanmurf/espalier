/**
 * Adversarial unit tests for ReadReplicaDataSource (Y3 Q2).
 *
 * Uses mock DataSources to test read/write routing, load balancers,
 * fallback behavior, context propagation, and edge cases.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ReadWriteContext,
  ReadReplicaDataSource,
  RoundRobinBalancer,
  RandomBalancer,
} from "../../index.js";
import type { DataSource, Connection } from "espalier-jdbc";
import type { LoadBalancer } from "../../index.js";

// ══════════════════════════════════════════════════
// Mock DataSource factory
// ══════════════════════════════════════════════════

function mockDataSource(label: string): DataSource & { label: string } {
  return {
    label,
    getConnection: vi.fn(async () => ({ label } as unknown as Connection)),
    close: vi.fn(async () => {}),
  };
}

function failingDataSource(label: string): DataSource & { label: string } {
  return {
    label,
    getConnection: vi.fn(async () => {
      throw new Error(`${label} connection failed`);
    }),
    close: vi.fn(async () => {}),
  };
}

// ══════════════════════════════════════════════════
// Section 1: ReadWriteContext
// ══════════════════════════════════════════════════

describe("ReadWriteContext", () => {
  it("isReadOnly() is false by default", () => {
    expect(ReadWriteContext.isReadOnly()).toBe(false);
  });

  it("runReadOnly sets isReadOnly to true", async () => {
    await ReadWriteContext.runReadOnly(async () => {
      expect(ReadWriteContext.isReadOnly()).toBe(true);
    });
  });

  it("isReadOnly() is false after runReadOnly completes", async () => {
    await ReadWriteContext.runReadOnly(async () => {});
    expect(ReadWriteContext.isReadOnly()).toBe(false);
  });

  it("nested runReadWrite inside runReadOnly overrides to read-write", async () => {
    await ReadWriteContext.runReadOnly(async () => {
      expect(ReadWriteContext.isReadOnly()).toBe(true);
      await ReadWriteContext.runReadWrite(async () => {
        expect(ReadWriteContext.isReadOnly()).toBe(false);
      });
      expect(ReadWriteContext.isReadOnly()).toBe(true);
    });
  });

  it("nested runReadOnly inside runReadWrite stays read-only", async () => {
    await ReadWriteContext.runReadWrite(async () => {
      expect(ReadWriteContext.isReadOnly()).toBe(false);
      await ReadWriteContext.runReadOnly(async () => {
        expect(ReadWriteContext.isReadOnly()).toBe(true);
      });
      expect(ReadWriteContext.isReadOnly()).toBe(false);
    });
  });

  it("runReadOnly callback throws — context properly cleaned up", async () => {
    try {
      await ReadWriteContext.runReadOnly(async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    expect(ReadWriteContext.isReadOnly()).toBe(false);
  });

  it("propagates through Promise.all", async () => {
    await ReadWriteContext.runReadOnly(async () => {
      const results = await Promise.all([
        Promise.resolve().then(() => ReadWriteContext.isReadOnly()),
        Promise.resolve().then(() => ReadWriteContext.isReadOnly()),
      ]);
      expect(results).toEqual([true, true]);
    });
  });

  it("propagates through setTimeout", async () => {
    await ReadWriteContext.runReadOnly(async () => {
      const result = await new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(ReadWriteContext.isReadOnly()), 5);
      });
      expect(result).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════
// Section 2: ReadReplicaDataSource — basic routing
// ══════════════════════════════════════════════════

describe("ReadReplicaDataSource — routing", () => {
  it("read-only context routes to replica", async () => {
    const primary = mockDataSource("primary");
    const replica = mockDataSource("replica");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [replica],
    });

    await ReadWriteContext.runReadOnly(async () => {
      const conn = await ds.getConnection();
      expect((conn as any).label).toBe("replica");
    });
    expect(replica.getConnection).toHaveBeenCalledTimes(1);
    expect(primary.getConnection).not.toHaveBeenCalled();
  });

  it("read-write context routes to primary", async () => {
    const primary = mockDataSource("primary");
    const replica = mockDataSource("replica");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [replica],
    });

    await ReadWriteContext.runReadWrite(async () => {
      const conn = await ds.getConnection();
      expect((conn as any).label).toBe("primary");
    });
    expect(primary.getConnection).toHaveBeenCalledTimes(1);
    expect(replica.getConnection).not.toHaveBeenCalled();
  });

  it("no context (default) routes to primary", async () => {
    const primary = mockDataSource("primary");
    const replica = mockDataSource("replica");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [replica],
    });

    const conn = await ds.getConnection();
    expect((conn as any).label).toBe("primary");
    expect(primary.getConnection).toHaveBeenCalledTimes(1);
  });

  it("no replicas configured — all queries go to primary", async () => {
    const primary = mockDataSource("primary");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [],
    });

    await ReadWriteContext.runReadOnly(async () => {
      const conn = await ds.getConnection();
      expect((conn as any).label).toBe("primary");
    });
    expect(primary.getConnection).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════
// Section 3: Load balancers
// ══════════════════════════════════════════════════

describe("RoundRobinBalancer", () => {
  it("cycles through replicas in order", () => {
    const replicas = [
      mockDataSource("R0"),
      mockDataSource("R1"),
      mockDataSource("R2"),
    ];
    const balancer = new RoundRobinBalancer();

    expect((balancer.pick(replicas) as any).label).toBe("R0");
    expect((balancer.pick(replicas) as any).label).toBe("R1");
    expect((balancer.pick(replicas) as any).label).toBe("R2");
    expect((balancer.pick(replicas) as any).label).toBe("R0");
  });

  it("100 picks across 3 replicas — even distribution", () => {
    const replicas = [
      mockDataSource("R0"),
      mockDataSource("R1"),
      mockDataSource("R2"),
    ];
    const balancer = new RoundRobinBalancer();
    const counts = new Map<string, number>();

    for (let i = 0; i < 99; i++) {
      const picked = (balancer.pick(replicas) as any).label;
      counts.set(picked, (counts.get(picked) ?? 0) + 1);
    }
    // 99 / 3 = exactly 33 each
    expect(counts.get("R0")).toBe(33);
    expect(counts.get("R1")).toBe(33);
    expect(counts.get("R2")).toBe(33);
  });
});

describe("RandomBalancer", () => {
  it("picks from replicas (statistical test — at least 2 distinct in 50 picks)", () => {
    const replicas = [
      mockDataSource("R0"),
      mockDataSource("R1"),
      mockDataSource("R2"),
    ];
    const balancer = new RandomBalancer();
    const seen = new Set<string>();

    for (let i = 0; i < 50; i++) {
      seen.add((balancer.pick(replicas) as any).label);
    }
    // With 50 picks and 3 options, extremely unlikely to only hit one
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

describe("Custom LoadBalancer", () => {
  it("always returns same replica — degenerate but valid", async () => {
    const replicas = [mockDataSource("R0"), mockDataSource("R1")];
    const stickyBalancer: LoadBalancer = {
      pick: () => replicas[0],
    };
    const ds = new ReadReplicaDataSource({
      primary: mockDataSource("primary"),
      replicas,
      loadBalancer: stickyBalancer,
    });

    await ReadWriteContext.runReadOnly(async () => {
      for (let i = 0; i < 5; i++) {
        const conn = await ds.getConnection();
        expect((conn as any).label).toBe("R0");
      }
    });
    expect(replicas[0].getConnection).toHaveBeenCalledTimes(5);
    expect(replicas[1].getConnection).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════
// Section 4: Fallback behavior
// ══════════════════════════════════════════════════

describe("ReadReplicaDataSource — fallback", () => {
  it("replica fails, fallbackToPrimary=true — falls back to primary", async () => {
    const primary = mockDataSource("primary");
    const replica = failingDataSource("replica");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [replica],
      fallbackToPrimary: true,
    });

    await ReadWriteContext.runReadOnly(async () => {
      const conn = await ds.getConnection();
      expect((conn as any).label).toBe("primary");
    });
  });

  it("replica fails, fallbackToPrimary=false — throws", async () => {
    const primary = mockDataSource("primary");
    const replica = failingDataSource("replica");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [replica],
      fallbackToPrimary: false,
    });

    await ReadWriteContext.runReadOnly(async () => {
      await expect(ds.getConnection()).rejects.toThrow(/replica connection failed/);
    });
    expect(primary.getConnection).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════
// Section 5: close() behavior
// ══════════════════════════════════════════════════

describe("ReadReplicaDataSource — close()", () => {
  it("close() closes primary and all replicas", async () => {
    const primary = mockDataSource("primary");
    const r1 = mockDataSource("R1");
    const r2 = mockDataSource("R2");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [r1, r2],
    });

    await ds.close();
    expect(primary.close).toHaveBeenCalledTimes(1);
    expect(r1.close).toHaveBeenCalledTimes(1);
    expect(r2.close).toHaveBeenCalledTimes(1);
  });

  it("close() when replica throws still closes others", async () => {
    const primary = mockDataSource("primary");
    const r1 = mockDataSource("R1");
    r1.close = vi.fn(async () => {
      throw new Error("R1 close failed");
    });
    const r2 = mockDataSource("R2");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [r1, r2],
    });

    await expect(ds.close()).rejects.toThrow(/Failed to close/);
    expect(primary.close).toHaveBeenCalledTimes(1);
    expect(r2.close).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════
// Section 6: Concurrent routing isolation
// ══════════════════════════════════════════════════

describe("ReadReplicaDataSource — concurrent isolation", () => {
  it("concurrent read-only and read-write operations route correctly", async () => {
    const primary = mockDataSource("primary");
    const replica = mockDataSource("replica");
    const ds = new ReadReplicaDataSource({
      primary,
      replicas: [replica],
    });

    const ops = Array.from({ length: 20 }, (_, i) => {
      if (i % 2 === 0) {
        return ReadWriteContext.runReadOnly(async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          const conn = await ds.getConnection();
          return (conn as any).label;
        });
      }
      return ReadWriteContext.runReadWrite(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        const conn = await ds.getConnection();
        return (conn as any).label;
      });
    });

    const results = await Promise.all(ops);
    for (let i = 0; i < results.length; i++) {
      if (i % 2 === 0) {
        expect(results[i]).toBe("replica");
      } else {
        expect(results[i]).toBe("primary");
      }
    }
  });
});
