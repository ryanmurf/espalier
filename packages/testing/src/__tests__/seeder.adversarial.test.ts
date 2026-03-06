import type { Connection, DataSource, PreparedStatement, ResultSet, Statement, Transaction } from "espalier-jdbc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedContext, SeedDefinition } from "../seeding/seeder.js";
import { clearSeedRegistry, defineSeed, getRegisteredSeeds, runSeeds, SeedRunner } from "../seeding/seeder.js";

// ==========================================================================
// Mock helpers
// ==========================================================================

function createMockResultSet(rows: Record<string, unknown>[] = []): ResultSet {
  let cursor = -1;
  return {
    next: vi.fn().mockImplementation(async () => {
      cursor++;
      return cursor < rows.length;
    }),
    getString: vi
      .fn()
      .mockImplementation((col: string) => (cursor < rows.length ? (rows[cursor][col] as string | null) : null)),
    getNumber: vi.fn().mockReturnValue(null),
    getBoolean: vi.fn().mockReturnValue(null),
    getDate: vi.fn().mockReturnValue(null),
    getRow: vi.fn().mockImplementation(() => (cursor < rows.length ? rows[cursor] : {})),
    getMetadata: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: async function* () {
      for (const row of rows) {
        yield row;
      }
    },
  };
}

function createMockPreparedStatement(): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn().mockResolvedValue(createMockResultSet()),
    executeUpdate: vi.fn().mockResolvedValue(1),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDataSource(executedSeeds: string[] = []): {
  ds: DataSource;
  connection: Connection;
} {
  const transaction: Transaction = {
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    setSavepoint: vi.fn().mockResolvedValue(undefined),
    rollbackTo: vi.fn().mockResolvedValue(undefined),
  };

  const seedRows = executedSeeds.map((name) => ({ name }));
  const mockStmt: Statement = {
    executeQuery: vi.fn().mockResolvedValue(createMockResultSet(seedRows)),
    executeUpdate: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const connection: Connection = {
    createStatement: vi.fn().mockReturnValue(mockStmt),
    prepareStatement: vi.fn().mockReturnValue(createMockPreparedStatement()),
    beginTransaction: vi.fn().mockResolvedValue(transaction),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
  };

  const ds: DataSource = {
    getConnection: vi.fn().mockResolvedValue(connection),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { ds, connection };
}

// ==========================================================================
// Registry
// ==========================================================================

describe("Seed registry", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("defineSeed registers a seed", () => {
    defineSeed("users", {
      run: async () => {},
    });
    const seeds = getRegisteredSeeds();
    expect(seeds.has("users")).toBe(true);
  });

  it("clearSeedRegistry removes all seeds", () => {
    defineSeed("users", { run: async () => {} });
    defineSeed("orders", { run: async () => {} });
    clearSeedRegistry();
    expect(getRegisteredSeeds().size).toBe(0);
  });

  it("getRegisteredSeeds returns a copy", () => {
    defineSeed("users", { run: async () => {} });
    const seeds = getRegisteredSeeds();
    seeds.delete("users");
    expect(getRegisteredSeeds().has("users")).toBe(true);
  });

  it("defineSeed with environments filter", () => {
    const seed = defineSeed("test-data", {
      environments: ["test", "staging"],
      run: async () => {},
    });
    expect(seed.environments).toEqual(["test", "staging"]);
  });

  it("defineSeed with dependencies", () => {
    const seed = defineSeed("orders", {
      dependsOn: ["users", "products"],
      run: async () => {},
    });
    expect(seed.dependsOn).toEqual(["users", "products"]);
  });
});

// ==========================================================================
// Topological sort and dependency errors
// ==========================================================================

describe("SeedRunner — dependency handling", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("seeds run in dependency order", async () => {
    const order: string[] = [];
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("users", {
      name: "users",
      run: async () => {
        order.push("users");
      },
    });
    seeds.set("orders", {
      name: "orders",
      dependsOn: ["users"],
      run: async () => {
        order.push("orders");
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await runner.run(seeds);
    expect(order).toEqual(["users", "orders"]);
  });

  it("circular dependency throws clear error", async () => {
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("A", {
      name: "A",
      dependsOn: ["B"],
      run: async () => {},
    });
    seeds.set("B", {
      name: "B",
      dependsOn: ["A"],
      run: async () => {},
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await expect(runner.run(seeds)).rejects.toThrow(/circular/i);
  });

  it("missing dependency throws clear error", async () => {
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("orders", {
      name: "orders",
      dependsOn: ["nonexistent"],
      run: async () => {},
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await expect(runner.run(seeds)).rejects.toThrow(/nonexistent/i);
  });

  it("diamond dependencies work correctly", async () => {
    const order: string[] = [];
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("base", {
      name: "base",
      run: async () => {
        order.push("base");
      },
    });
    seeds.set("left", {
      name: "left",
      dependsOn: ["base"],
      run: async () => {
        order.push("left");
      },
    });
    seeds.set("right", {
      name: "right",
      dependsOn: ["base"],
      run: async () => {
        order.push("right");
      },
    });
    seeds.set("top", {
      name: "top",
      dependsOn: ["left", "right"],
      run: async () => {
        order.push("top");
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await runner.run(seeds);

    // base must be first, top must be last
    expect(order[0]).toBe("base");
    expect(order[order.length - 1]).toBe("top");
    expect(order.indexOf("left")).toBeLessThan(order.indexOf("top"));
    expect(order.indexOf("right")).toBeLessThan(order.indexOf("top"));
  });
});

// ==========================================================================
// Environment filtering
// ==========================================================================

describe("SeedRunner — environment filtering", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("seed with matching environment runs", async () => {
    const seeds = new Map<string, SeedDefinition>();
    const ran: string[] = [];
    seeds.set("test-data", {
      name: "test-data",
      environments: ["test"],
      run: async () => {
        ran.push("test-data");
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds, "test");
    const result = await runner.run(seeds);
    expect(result.executed).toContain("test-data");
    expect(ran).toContain("test-data");
  });

  it("seed with non-matching environment is skipped", async () => {
    const seeds = new Map<string, SeedDefinition>();
    const ran: string[] = [];
    seeds.set("test-only", {
      name: "test-only",
      environments: ["test"],
      run: async () => {
        ran.push("test-only");
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds, "production");
    const result = await runner.run(seeds);
    expect(result.skipped).toContain("test-only");
    expect(ran).toEqual([]);
  });

  it("seed with no environments runs in all environments", async () => {
    const seeds = new Map<string, SeedDefinition>();
    const ran: string[] = [];
    seeds.set("always", {
      name: "always",
      run: async () => {
        ran.push("always");
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds, "anything");
    await runner.run(seeds);
    expect(ran).toContain("always");
  });

  it("seed with empty environments array runs in all environments", async () => {
    const seeds = new Map<string, SeedDefinition>();
    const ran: string[] = [];
    seeds.set("empty-envs", {
      name: "empty-envs",
      environments: [],
      run: async () => {
        ran.push("empty-envs");
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds, "dev");
    await runner.run(seeds);
    expect(ran).toContain("empty-envs");
  });
});

// ==========================================================================
// Idempotency
// ==========================================================================

describe("SeedRunner — idempotency", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("already-run seeds are not re-executed", async () => {
    const seeds = new Map<string, SeedDefinition>();
    const ran: string[] = [];
    seeds.set("users", {
      name: "users",
      run: async () => {
        ran.push("users");
      },
    });

    const { ds } = createMockDataSource(["users"]); // Already executed
    const runner = new SeedRunner(ds);
    const result = await runner.run(seeds);
    expect(result.alreadyRun).toContain("users");
    expect(ran).toEqual([]);
  });
});

// ==========================================================================
// Seed that throws
// ==========================================================================

describe("SeedRunner — error handling", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("seed that throws propagates the error", async () => {
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("broken", {
      name: "broken",
      run: async () => {
        throw new Error("Seed failed");
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await expect(runner.run(seeds)).rejects.toThrow("Seed failed");
  });
});

// ==========================================================================
// SeedRunResult
// ==========================================================================

describe("SeedRunner — result reporting", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("result contains executed, skipped, and alreadyRun", async () => {
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("new-seed", {
      name: "new-seed",
      run: async () => {},
    });
    seeds.set("old-seed", {
      name: "old-seed",
      run: async () => {},
    });
    seeds.set("wrong-env", {
      name: "wrong-env",
      environments: ["production"],
      run: async () => {},
    });

    const { ds } = createMockDataSource(["old-seed"]);
    const runner = new SeedRunner(ds, "development");
    const result = await runner.run(seeds);

    expect(result.executed).toContain("new-seed");
    expect(result.alreadyRun).toContain("old-seed");
    expect(result.skipped).toContain("wrong-env");
  });
});

// ==========================================================================
// SeedContext
// ==========================================================================

describe("SeedRunner — SeedContext", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("provides dataSource and connection to seed run", async () => {
    let receivedCtx: SeedContext | undefined;
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("check-ctx", {
      name: "check-ctx",
      run: async (ctx) => {
        receivedCtx = ctx;
      },
    });

    const { ds, connection } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await runner.run(seeds);

    expect(receivedCtx).toBeDefined();
    expect(receivedCtx!.dataSource).toBe(ds);
    expect(receivedCtx!.connection).toBe(connection);
  });

  it("provides env to seed context", async () => {
    let receivedEnv = "";
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("env-check", {
      name: "env-check",
      run: async (ctx) => {
        receivedEnv = ctx.env;
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds, "staging");
    await runner.run(seeds);

    expect(receivedEnv).toBe("staging");
  });

  it("provides factory function in context", async () => {
    let hasFactory = false;
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("factory-check", {
      name: "factory-check",
      run: async (ctx) => {
        hasFactory = typeof ctx.factory === "function";
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await runner.run(seeds);

    expect(hasFactory).toBe(true);
  });
});

// ==========================================================================
// Reset
// ==========================================================================

describe("SeedRunner — reset", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("reset() drops the seed tracking table", async () => {
    const { ds, connection } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await runner.reset();

    const stmt = connection.createStatement();
    expect(stmt.executeUpdate).toHaveBeenCalledWith(expect.stringContaining("DROP TABLE"));
  });

  it("reset() closes the connection", async () => {
    const { ds, connection } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await runner.reset();
    expect(connection.close).toHaveBeenCalled();
  });
});

// ==========================================================================
// Status
// ==========================================================================

describe("SeedRunner — status", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("status shows correct states", async () => {
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("done", {
      name: "done",
      run: async () => {},
    });
    seeds.set("pending", {
      name: "pending",
      run: async () => {},
    });
    seeds.set("env-filtered", {
      name: "env-filtered",
      environments: ["production"],
      run: async () => {},
    });

    const { ds } = createMockDataSource(["done"]);
    const runner = new SeedRunner(ds, "development");
    const statuses = await runner.status(seeds);

    const byName = new Map(statuses.map((s) => [s.name, s.status]));
    expect(byName.get("done")).toBe("executed");
    expect(byName.get("pending")).toBe("pending");
    expect(byName.get("env-filtered")).toBe("skipped");
  });
});

// ==========================================================================
// runSeeds convenience
// ==========================================================================

describe("runSeeds — convenience function", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("returns a SeedRunResult", async () => {
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("quick", {
      name: "quick",
      run: async () => {},
    });

    const { ds } = createMockDataSource();
    const result = await runSeeds(ds, "test", seeds);
    expect(result.executed).toContain("quick");
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe("SeedRunner — edge cases", () => {
  beforeEach(() => {
    clearSeedRegistry();
  });

  it("empty seeds map runs cleanly", async () => {
    const seeds = new Map<string, SeedDefinition>();
    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    const result = await runner.run(seeds);
    expect(result.executed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.alreadyRun).toEqual([]);
  });

  it("default environment is development", async () => {
    const seeds = new Map<string, SeedDefinition>();
    let receivedEnv = "";
    seeds.set("env-test", {
      name: "env-test",
      run: async (ctx) => {
        receivedEnv = ctx.env;
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await runner.run(seeds);
    expect(receivedEnv).toBe("development");
  });

  it("seed name with special characters is handled", async () => {
    const seeds = new Map<string, SeedDefinition>();
    const ran: string[] = [];
    seeds.set("seed/with-special.chars_v2", {
      name: "seed/with-special.chars_v2",
      run: async () => {
        ran.push("special");
      },
    });

    const { ds } = createMockDataSource();
    const runner = new SeedRunner(ds);
    await runner.run(seeds);
    expect(ran).toContain("special");
  });

  it("connection is always closed, even on error", async () => {
    const seeds = new Map<string, SeedDefinition>();
    seeds.set("error", {
      name: "error",
      run: async () => {
        throw new Error("boom");
      },
    });

    const { ds, connection } = createMockDataSource();
    const runner = new SeedRunner(ds);
    try {
      await runner.run(seeds);
    } catch {
      // Expected
    }
    expect(connection.close).toHaveBeenCalled();
  });
});
