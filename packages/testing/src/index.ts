/**
 * espalier-testing — Testing utilities for espalier
 *
 * Entity factories, database seeding, transaction-based test isolation,
 * and query assertions.
 */

// Entity factory
export { EntityFactory, createFactory } from "./factory/entity-factory.js";
export type { FactoryOptions, PersistFn } from "./factory/entity-factory.js";

// Seeding framework (placeholder)
export { Seeder } from "./seeding/seeder.js";

// Test isolation (placeholder)
export { TestTransaction } from "./isolation/test-transaction.js";

// Query assertions (placeholder)
export { QueryAssertions } from "./assertions/query-assertions.js";
