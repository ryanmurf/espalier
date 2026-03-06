import type { MigrationRunner, MigrationRunnerConfig } from "espalier-data";
import type { DataSource, SchemaIntrospector } from "espalier-jdbc";
import type { EspalierConfig } from "./config.js";

export interface AdapterResources {
  dataSource: DataSource;
  runner: MigrationRunner;
  introspector?: SchemaIntrospector;
}

export async function createAdapter(config: EspalierConfig): Promise<AdapterResources> {
  const runnerConfig: MigrationRunnerConfig = {
    tableName: config.migrations?.tableName,
    schema: config.migrations?.schema,
  };

  switch (config.adapter) {
    case "pg":
      return createPgAdapter(config, runnerConfig);
    case "mysql":
      return createMysqlAdapter(config, runnerConfig);
    case "sqlite":
      return createSqliteAdapter(config, runnerConfig);
    default:
      throw new Error(`Unsupported adapter: "${config.adapter as string}"`);
  }
}

async function createPgAdapter(config: EspalierConfig, runnerConfig: MigrationRunnerConfig): Promise<AdapterResources> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("espalier-jdbc-pg")) as Record<string, unknown>;
  } catch {
    throw new Error(`Cannot load PostgreSQL adapter. Install "espalier-jdbc-pg" to use adapter "pg".`);
  }

  const PgDataSource = mod.PgDataSource as new (config: { pg: Record<string, unknown> }) => DataSource;
  const PgMigrationRunner = mod.PgMigrationRunner as new (
    ds: DataSource,
    config?: MigrationRunnerConfig,
  ) => MigrationRunner;
  const PgSchemaIntrospector = mod.PgSchemaIntrospector as (new (ds: DataSource) => SchemaIntrospector) | undefined;

  const dataSource = new PgDataSource({ pg: config.connection });
  const runner = new PgMigrationRunner(dataSource, runnerConfig);
  const introspector = PgSchemaIntrospector ? new PgSchemaIntrospector(dataSource) : undefined;
  return { dataSource, runner, introspector };
}

async function createMysqlAdapter(
  config: EspalierConfig,
  runnerConfig: MigrationRunnerConfig,
): Promise<AdapterResources> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("espalier-jdbc-mysql")) as Record<string, unknown>;
  } catch {
    throw new Error(`Cannot load MySQL adapter. Install "espalier-jdbc-mysql" to use adapter "mysql".`);
  }

  const MysqlDataSource = mod.MysqlDataSource as new (config: { mysql: Record<string, unknown> }) => DataSource;
  const MysqlMigrationRunner = mod.MysqlMigrationRunner as new (
    ds: DataSource,
    config?: MigrationRunnerConfig,
  ) => MigrationRunner;

  const dataSource = new MysqlDataSource({ mysql: config.connection });
  const runner = new MysqlMigrationRunner(dataSource, runnerConfig);
  return { dataSource, runner };
}

async function createSqliteAdapter(
  config: EspalierConfig,
  runnerConfig: MigrationRunnerConfig,
): Promise<AdapterResources> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("espalier-jdbc-sqlite")) as Record<string, unknown>;
  } catch {
    throw new Error(`Cannot load SQLite adapter. Install "espalier-jdbc-sqlite" to use adapter "sqlite".`);
  }

  const SqliteDataSource = mod.SqliteDataSource as new (config: { filename: string }) => DataSource;
  const SqliteMigrationRunner = mod.SqliteMigrationRunner as new (
    ds: DataSource,
    config?: MigrationRunnerConfig,
  ) => MigrationRunner;

  const dataSource = new SqliteDataSource(config.connection as { filename: string });
  const runner = new SqliteMigrationRunner(dataSource, runnerConfig);
  return { dataSource, runner };
}
