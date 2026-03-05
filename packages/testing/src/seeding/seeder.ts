import type { Connection, DataSource } from "espalier-jdbc";
import type { EntityFactory } from "../factory/entity-factory.js";
import { createFactory } from "../factory/entity-factory.js";

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

/**
 * Context passed to seed run functions.
 */
export interface SeedContext {
  dataSource: DataSource;
  connection: Connection;
  factory<T>(entityClass: new (...args: unknown[]) => T): EntityFactory<T>;
  env: string;
}

/**
 * Options for defining a seed.
 */
export interface SeedDefinition {
  name: string;
  environments?: string[];
  dependsOn?: string[];
  run: (ctx: SeedContext) => Promise<void>;
}

/**
 * Seed execution record stored in the tracking table.
 */
export interface SeedRecord {
  name: string;
  executedAt: Date;
  checksum: string;
}

/**
 * Result of a seed run.
 */
export interface SeedRunResult {
  executed: string[];
  skipped: string[];
  alreadyRun: string[];
}

const SEED_TABLE = "_espalier_seeds";

/**
 * Compute a simple checksum for a seed (based on its name + run function source).
 */
function computeChecksum(seed: SeedDefinition): string {
  const source = seed.run.toString();
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const chr = source.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Registry of seed definitions. Use defineSeed() to register seeds.
 */
const seedRegistry = new Map<string, SeedDefinition>();

/**
 * Define a seed. Seeds are registered globally and run by SeedRunner.
 */
export function defineSeed(
  name: string,
  options: Omit<SeedDefinition, "name"> & { environments?: string[]; dependsOn?: string[] },
): SeedDefinition {
  const seed: SeedDefinition = {
    name,
    environments: options.environments,
    dependsOn: options.dependsOn,
    run: options.run,
  };
  seedRegistry.set(name, seed);
  return seed;
}

/**
 * Get all registered seeds.
 */
export function getRegisteredSeeds(): Map<string, SeedDefinition> {
  return new Map(seedRegistry);
}

/**
 * Clear the seed registry (for testing).
 */
export function clearSeedRegistry(): void {
  seedRegistry.clear();
}

/**
 * SeedRunner discovers and executes seeds in dependency order.
 */
export class SeedRunner {
  private readonly _dataSource: DataSource;
  private readonly _env: string;

  constructor(dataSource: DataSource, env = "development") {
    this._dataSource = dataSource;
    this._env = env;
  }

  /**
   * Ensure the seed tracking table exists.
   */
  async ensureTable(conn: Connection): Promise<void> {
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(
        `CREATE TABLE IF NOT EXISTS ${SEED_TABLE} (` +
        `name VARCHAR(255) PRIMARY KEY, ` +
        `executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ` +
        `checksum VARCHAR(64) NOT NULL` +
        `)`,
      );
    } finally {
      await stmt.close();
    }
  }

  /**
   * Get already-executed seed names.
   */
  async getExecutedSeeds(conn: Connection): Promise<Set<string>> {
    const stmt = conn.createStatement();
    try {
      const rs = await stmt.executeQuery(`SELECT name FROM ${SEED_TABLE}`);
      const names = new Set<string>();
      while (await rs.next()) {
        const name = rs.getString("name");
        if (name !== null) names.add(name);
      }
      return names;
    } finally {
      await stmt.close();
    }
  }

  /**
   * Record a seed as executed.
   */
  async recordSeed(conn: Connection, name: string, checksum: string): Promise<void> {
    const stmt = conn.prepareStatement(
      `INSERT INTO ${SEED_TABLE} (name, checksum) VALUES ($1, $2)`,
    );
    try {
      stmt.setParameter(1, name);
      stmt.setParameter(2, checksum);
      await stmt.executeUpdate();
    } finally {
      await stmt.close();
    }
  }

  /**
   * Run all pending seeds in dependency order.
   */
  async run(seeds?: Map<string, SeedDefinition>): Promise<SeedRunResult> {
    const allSeeds = seeds ?? getRegisteredSeeds();
    const result: SeedRunResult = { executed: [], skipped: [], alreadyRun: [] };

    // Topological sort by dependencies
    const sorted = this._topologicalSort(allSeeds);

    const conn = await this._dataSource.getConnection();
    try {
      await this.ensureTable(conn);
      const executed = await this.getExecutedSeeds(conn);

      for (const seed of sorted) {
        // Check environment filter
        if (seed.environments && seed.environments.length > 0) {
          if (!seed.environments.includes(this._env)) {
            result.skipped.push(seed.name);
            continue;
          }
        }

        // Check if already run
        if (executed.has(seed.name)) {
          result.alreadyRun.push(seed.name);
          continue;
        }

        // Run the seed
        const ctx: SeedContext = {
          dataSource: this._dataSource,
          connection: conn,
          factory<T>(entityClass: new (...args: unknown[]) => T): EntityFactory<T> {
            return createFactory(entityClass);
          },
          env: this._env,
        };

        await seed.run(ctx);

        const checksum = computeChecksum(seed);
        await this.recordSeed(conn, seed.name, checksum);
        result.executed.push(seed.name);
      }
    } finally {
      await conn.close();
    }

    return result;
  }

  /**
   * Reset all seed tracking (drop table).
   */
  async reset(): Promise<void> {
    const conn = await this._dataSource.getConnection();
    try {
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${SEED_TABLE}`);
      } finally {
        await stmt.close();
      }
    } finally {
      await conn.close();
    }
  }

  /**
   * Get status of all seeds.
   */
  async status(seeds?: Map<string, SeedDefinition>): Promise<Array<{ name: string; status: "executed" | "pending" | "skipped" }>> {
    const allSeeds = seeds ?? getRegisteredSeeds();
    const conn = await this._dataSource.getConnection();
    try {
      await this.ensureTable(conn);
      const executed = await this.getExecutedSeeds(conn);
      const result: Array<{ name: string; status: "executed" | "pending" | "skipped" }> = [];

      for (const [name, seed] of allSeeds) {
        if (seed.environments && seed.environments.length > 0 && !seed.environments.includes(this._env)) {
          result.push({ name, status: "skipped" });
        } else if (executed.has(name)) {
          result.push({ name, status: "executed" });
        } else {
          result.push({ name, status: "pending" });
        }
      }
      return result;
    } finally {
      await conn.close();
    }
  }

  /**
   * Topological sort of seeds by dependencies.
   */
  private _topologicalSort(seeds: Map<string, SeedDefinition>): SeedDefinition[] {
    const sorted: SeedDefinition[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular seed dependency detected: ${name}`);
      }

      visiting.add(name);
      const seed = seeds.get(name);
      if (!seed) {
        throw new Error(`Unknown seed dependency: "${name}"`);
      }

      if (seed.dependsOn) {
        for (const dep of seed.dependsOn) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(seed);
    };

    for (const name of seeds.keys()) {
      visit(name);
    }

    return sorted;
  }
}

/**
 * Convenience: create and run a SeedRunner.
 */
export async function runSeeds(
  dataSource: DataSource,
  env?: string,
  seeds?: Map<string, SeedDefinition>,
): Promise<SeedRunResult> {
  const runner = new SeedRunner(dataSource, env);
  return runner.run(seeds);
}
