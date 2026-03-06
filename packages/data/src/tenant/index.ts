/**
 * Multi-tenancy module for espalier-data.
 *
 * Three strategies can be used independently or composed:
 *
 * **Schema-per-tenant** — Each tenant has its own PostgreSQL schema.
 * ```ts
 * const ds = new TenantAwareDataSource({
 *   dataSource: pooledDs,
 *   schemaResolver: (t) => `tenant_${t}`,
 * });
 * await TenantContext.run("acme", async () => {
 *   // All queries scoped to schema "tenant_acme"
 *   await repo.findAll();
 * });
 * ```
 *
 * **Discriminator column** — All tenants share tables, rows filtered by @TenantId.
 * ```ts
 * class Order {
 *   @Id @Column() id!: number;
 *   @TenantId @Column() tenantId!: string;
 *   @Column() total!: number;
 * }
 * // Repository auto-filters by tenantId from TenantContext
 * ```
 *
 * **Database routing** — Each tenant has its own database/DataSource.
 * ```ts
 * const ds = new TenantRoutingDataSource({
 *   dataSources: new Map([["acme", acmeDs], ["corp", corpDs]]),
 * });
 * ```
 *
 * **Composition example** — routing + read replicas:
 * ```ts
 * const acmeDs = new ReadReplicaDataSource({
 *   primary: acmePrimary,
 *   replicas: [acmeReplica1],
 * });
 * const ds = new TenantRoutingDataSource({
 *   dataSources: new Map([["acme", acmeDs]]),
 * });
 * ```
 *
 * @module
 */

export type { LoadBalancer, ReadReplicaDataSourceOptions } from "./read-replica-datasource.js";
export {
  RandomBalancer,
  ReadReplicaDataSource,
  ReadWriteContext,
  RoundRobinBalancer,
} from "./read-replica-datasource.js";
export type { RoutingDataSourceOptions } from "./routing-datasource.js";
export { RoutingDataSource, RoutingError, TenantRoutingDataSource } from "./routing-datasource.js";
export type { TenantAwareDataSourceOptions } from "./tenant-aware-datasource.js";
export { SchemaSetupError, TenantAwareDataSource } from "./tenant-aware-datasource.js";
export type { TenantIdentifier } from "./tenant-context.js";
export { NoTenantException, TenantContext } from "./tenant-context.js";
export { tenantFilter } from "./tenant-filter.js";

export type { TenantSchemaManagerOptions } from "./tenant-schema-manager.js";
export { TenantLimitExceededError, TenantSchemaManager } from "./tenant-schema-manager.js";
