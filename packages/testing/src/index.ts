/**
 * espalier-testing — Testing utilities for espalier
 *
 * Entity factories, database seeding, transaction-based test isolation,
 * and query assertions.
 */

export type { AssertionResult, CapturedQuery } from "./assertions/query-assertions.js";
// Query log capture and assertions
export {
  assertMaxQueries,
  assertNoQueriesMatching,
  assertQueriesMatching,
  assertQueryCount,
  createInstrumentedDataSource,
  QueryLog,
  withQueryLog,
} from "./assertions/query-assertions.js";
export type { FactoryOptions, PersistFn } from "./factory/entity-factory.js";
// Entity factory
export { createFactory, EntityFactory } from "./factory/entity-factory.js";
export type { TestTransactionContext, TestTransactionOptions } from "./isolation/test-transaction.js";
// Test isolation
export { BoundEntityFactory, withNestedTransaction, withTestTransaction } from "./isolation/test-transaction.js";
export type { MigrationTestContext, SchemaAssertion } from "./migration/migration-tester.js";
// Migration testing
export { createSchemaAssertion, testMigration } from "./migration/migration-tester.js";
export type { SeedContext, SeedDefinition, SeedRecord, SeedRunResult } from "./seeding/seeder.js";
// Seeding framework
export {
  clearSeedRegistry,
  defineSeed,
  getRegisteredSeeds,
  runSeeds,
  SeedRunner,
} from "./seeding/seeder.js";
