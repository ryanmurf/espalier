/**
 * espalier-testing — Testing utilities for espalier
 *
 * Entity factories, database seeding, transaction-based test isolation,
 * and query assertions.
 */

// Entity factory
export { EntityFactory, createFactory } from "./factory/entity-factory.js";
export type { FactoryOptions, PersistFn } from "./factory/entity-factory.js";

// Seeding framework
export {
  SeedRunner,
  defineSeed,
  getRegisteredSeeds,
  clearSeedRegistry,
  runSeeds,
} from "./seeding/seeder.js";
export type { SeedContext, SeedDefinition, SeedRecord, SeedRunResult } from "./seeding/seeder.js";

// Test isolation
export { withTestTransaction, withNestedTransaction, BoundEntityFactory } from "./isolation/test-transaction.js";
export type { TestTransactionContext, TestTransactionOptions } from "./isolation/test-transaction.js";

// Query log capture and assertions
export {
  QueryLog,
  createInstrumentedDataSource,
  withQueryLog,
  assertQueryCount,
  assertMaxQueries,
  assertNoQueriesMatching,
  assertQueriesMatching,
} from "./assertions/query-assertions.js";
export type { CapturedQuery, AssertionResult } from "./assertions/query-assertions.js";

// Migration testing
export { testMigration, createSchemaAssertion } from "./migration/migration-tester.js";
export type { MigrationTestContext, SchemaAssertion } from "./migration/migration-tester.js";
