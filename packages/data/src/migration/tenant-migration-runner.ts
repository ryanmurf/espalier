import type { Migration, MigrationRunner } from "./migration.js";

export interface TenantMigrationProgress {
  tenantId: string;
  schema: string;
  status: "pending" | "running" | "completed" | "failed";
  error?: Error;
  migrationsApplied: number;
}

export interface TenantMigrationOptions {
  /** Max concurrent tenant migrations. Default: 1 (sequential). */
  concurrency?: number;
  /** Continue on tenant failure? Default: false. */
  continueOnError?: boolean;
  /** Progress callback. */
  onProgress?: (progress: TenantMigrationProgress) => void;
}

/**
 * Runs migrations across multiple tenant schemas, supporting concurrent
 * execution and per-tenant error handling.
 */
export class TenantAwareMigrationRunner {
  constructor(
    private runnerFactory: (schema: string) => MigrationRunner,
    private tenantSchemas: string[],
  ) {
    if (tenantSchemas.length === 0) {
      throw new Error("tenantSchemas must not be empty");
    }
  }

  /**
   * Run migrations across all tenant schemas.
   */
  async runAll(
    migrations: Migration[],
    options?: TenantMigrationOptions,
  ): Promise<TenantMigrationProgress[]> {
    return this.executeAcrossTenants(
      async (runner) => {
        await runner.initialize();
        const before = await runner.getAppliedMigrations();
        await runner.run(migrations);
        const after = await runner.getAppliedMigrations();
        return after.length - before.length;
      },
      options,
    );
  }

  /**
   * Rollback migrations across all tenant schemas.
   */
  async rollbackAll(
    migrations: Migration[],
    steps?: number,
    options?: TenantMigrationOptions,
  ): Promise<TenantMigrationProgress[]> {
    return this.executeAcrossTenants(
      async (runner) => {
        await runner.initialize();
        const before = await runner.getAppliedMigrations();
        await runner.rollback(migrations, steps);
        const after = await runner.getAppliedMigrations();
        return before.length - after.length;
      },
      options,
    );
  }

  /**
   * Get pending migrations per tenant.
   */
  async pendingAll(
    migrations: Migration[],
  ): Promise<Map<string, Migration[]>> {
    const result = new Map<string, Migration[]>();
    for (const schema of this.tenantSchemas) {
      const runner = this.runnerFactory(schema);
      await runner.initialize();
      const pending = await runner.pending(migrations);
      result.set(schema, pending);
    }
    return result;
  }

  private async executeAcrossTenants(
    action: (runner: MigrationRunner) => Promise<number>,
    options?: TenantMigrationOptions,
  ): Promise<TenantMigrationProgress[]> {
    const concurrency = options?.concurrency ?? 1;
    if (concurrency < 1) {
      throw new Error("concurrency must be at least 1");
    }
    const continueOnError = options?.continueOnError ?? false;

    const results: TenantMigrationProgress[] = [];
    const schemas = [...this.tenantSchemas];

    // Process in chunks of `concurrency`
    for (let i = 0; i < schemas.length; i += concurrency) {
      const chunk = schemas.slice(i, i + concurrency);
      const promises = chunk.map(async (schema) => {
        const progress: TenantMigrationProgress = {
          tenantId: schema,
          schema,
          status: "running",
          migrationsApplied: 0,
        };
        options?.onProgress?.({ ...progress });

        try {
          const runner = this.runnerFactory(schema);
          progress.migrationsApplied = await action(runner);
          progress.status = "completed";
        } catch (err) {
          progress.status = "failed";
          progress.error = err instanceof Error ? err : new Error(String(err));
          if (!continueOnError) {
            options?.onProgress?.({ ...progress });
            results.push(progress);
            throw progress.error;
          }
        }

        options?.onProgress?.({ ...progress });
        return progress;
      });

      const settled = await Promise.allSettled(promises);
      for (const result of settled) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        }
      }

      // If not continueOnError and we had a failure, it would have thrown above
    }

    return results;
  }
}
