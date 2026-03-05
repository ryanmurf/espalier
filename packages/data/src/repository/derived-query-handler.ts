import type { DataSource, SqlValue } from "espalier-jdbc";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import type { RowMapper } from "../mapping/row-mapper.js";
import type { DerivedQueryDescriptor } from "../query/derived-query-parser.js";
import { parseDerivedQueryMethod } from "../query/derived-query-parser.js";
import { buildDerivedQuery } from "../query/derived-query-executor.js";
import type { ProjectionMapper } from "../mapping/projection-mapper.js";
import { createProjectionMapper } from "../mapping/projection-mapper.js";
import { getProjectionMetadata } from "../decorators/projection.js";
import type { EntityCache } from "../cache/entity-cache.js";
import type { QueryCache } from "../cache/query-cache.js";
import type { EntityChangeTracker } from "../mapping/change-tracker.js";
import type { LifecycleEvent } from "../decorators/lifecycle.js";
import type { EventBus } from "../events/event-bus.js";
import type { EntityLoadedEvent } from "../events/entity-events.js";
import { ENTITY_EVENTS } from "../events/entity-events.js";
import type { Criteria } from "../query/criteria.js";

function isProjectionClass(arg: unknown): arg is new (...args: any[]) => any {
  return typeof arg === "function" && getProjectionMetadata(arg) !== undefined;
}

export interface DerivedQueryHandlerDeps<T> {
  entityClass: new (...args: any[]) => T;
  metadata: EntityMetadata;
  dataSource: DataSource;
  rowMapper: RowMapper<T>;
  entityCache: EntityCache;
  queryCache: QueryCache;
  changeTracker: EntityChangeTracker<T>;
  eventBus: EventBus | undefined;
  getEntityId: (entity: T) => unknown;
  tenantCacheKey: (id: unknown) => unknown;
  getTenantCriteria: () => Criteria | undefined;
  invokeLifecycleCallbacks: (entity: T, event: LifecycleEvent) => Promise<void>;
  emitEntityEvent: (genericEvent: string, specificEvent: string, payload: unknown) => Promise<void>;
}

export class DerivedQueryHandler<T> {
  private readonly entityClass: new (...args: any[]) => T;
  private readonly metadata: EntityMetadata;
  private readonly dataSource: DataSource;
  private readonly rowMapper: RowMapper<T>;
  private readonly entityCache: EntityCache;
  private readonly queryCache: QueryCache;
  private readonly changeTracker: EntityChangeTracker<T>;
  private readonly getEntityId: (entity: T) => unknown;
  private readonly tenantCacheKey: (id: unknown) => unknown;
  private readonly getTenantCriteria: () => Criteria | undefined;
  private readonly invokeLifecycleCallbacks: (entity: T, event: LifecycleEvent) => Promise<void>;
  private readonly emitEntityEvent: (genericEvent: string, specificEvent: string, payload: unknown) => Promise<void>;
  private readonly entityName: string;
  private readonly descriptorCache = new Map<string, DerivedQueryDescriptor>();
  private readonly projectionMapperCache = new Map<new (...args: any[]) => any, ProjectionMapper<any>>();

  constructor(deps: DerivedQueryHandlerDeps<T>) {
    this.entityClass = deps.entityClass;
    this.metadata = deps.metadata;
    this.dataSource = deps.dataSource;
    this.rowMapper = deps.rowMapper;
    this.entityCache = deps.entityCache;
    this.queryCache = deps.queryCache;
    this.changeTracker = deps.changeTracker;
    this.getEntityId = deps.getEntityId;
    this.tenantCacheKey = deps.tenantCacheKey;
    this.getTenantCriteria = deps.getTenantCriteria;
    this.invokeLifecycleCallbacks = deps.invokeLifecycleCallbacks;
    this.emitEntityEvent = deps.emitEntityEvent;
    this.entityName = deps.entityClass.name;
  }

  getCachedDescriptor(methodName: string): DerivedQueryDescriptor {
    let descriptor = this.descriptorCache.get(methodName);
    if (!descriptor) {
      descriptor = parseDerivedQueryMethod(methodName);
      this.descriptorCache.set(methodName, descriptor);
    }
    return descriptor;
  }

  getCachedProjectionMapper<P>(projectionClass: new (...args: any[]) => P): ProjectionMapper<P> {
    let mapper = this.projectionMapperCache.get(projectionClass);
    if (!mapper) {
      mapper = createProjectionMapper(projectionClass, this.metadata);
      this.projectionMapperCache.set(projectionClass, mapper);
    }
    return mapper as ProjectionMapper<P>;
  }

  createStreamingHandler(baseName: string): (...args: unknown[]) => AsyncIterable<any> {
    return (...args: unknown[]) => {
      const descriptor = this.getCachedDescriptor(baseName);
      const builtQuery = buildDerivedQuery(descriptor, this.metadata, args, this.getTenantCriteria());

      return {
        [Symbol.asyncIterator](): AsyncIterator<any> {
          let conn: Awaited<ReturnType<DataSource["getConnection"]>> | null = null;
          let stmt: import("espalier-jdbc").PreparedStatement | null = null;
          let rs: Awaited<ReturnType<import("espalier-jdbc").PreparedStatement["executeQuery"]>> | null = null;
          let done = false;
          const self = this;
          const dataSource = (self as any).__dataSource;

          async function init() {
            conn = await dataSource.getConnection();
            stmt = conn!.prepareStatement(builtQuery.sql);
            for (let i = 0; i < builtQuery.params.length; i++) {
              stmt!.setParameter(i + 1, builtQuery.params[i]);
            }
            rs = await stmt!.executeQuery();
          }

          async function cleanup() {
            done = true;
            if (rs) { await rs.close().catch(() => {}); rs = null; }
            if (stmt) { await stmt.close().catch(() => {}); stmt = null; }
            if (conn) { await conn.close().catch(() => {}); conn = null; }
          }

          return {
            async next(): Promise<IteratorResult<any>> {
              if (done) return { value: undefined as any, done: true };
              if (!rs) await init();
              if (await rs!.next()) {
                return { value: undefined as any, done: false }; // placeholder
              }
              await cleanup();
              return { value: undefined as any, done: true };
            },
            async return(): Promise<IteratorResult<any>> {
              await cleanup();
              return { value: undefined as any, done: true };
            },
            async throw(err?: unknown): Promise<IteratorResult<any>> {
              await cleanup();
              throw err;
            },
          };
        },
      };
    };
  }

  createDerivedStreamMethod(prop: string): (...args: unknown[]) => AsyncIterable<any> {
    const baseName = prop.slice(0, -"Stream".length);
    const handler = this;
    return (...args: unknown[]) => {
      const descriptor = handler.getCachedDescriptor(baseName);
      const builtQuery = buildDerivedQuery(descriptor, handler.metadata, args, handler.getTenantCriteria());

      return {
        [Symbol.asyncIterator](): AsyncIterator<any> {
          let conn: Awaited<ReturnType<DataSource["getConnection"]>> | null = null;
          let stmt: import("espalier-jdbc").PreparedStatement | null = null;
          let rs: Awaited<ReturnType<import("espalier-jdbc").PreparedStatement["executeQuery"]>> | null = null;
          let done = false;

          async function init() {
            conn = await handler.dataSource.getConnection();
            stmt = conn!.prepareStatement(builtQuery.sql);
            for (let i = 0; i < builtQuery.params.length; i++) {
              stmt!.setParameter(i + 1, builtQuery.params[i]);
            }
            rs = await stmt!.executeQuery();
          }

          async function cleanup() {
            done = true;
            if (rs) { await rs.close().catch(() => {}); rs = null; }
            if (stmt) { await stmt.close().catch(() => {}); stmt = null; }
            if (conn) { await conn.close().catch(() => {}); conn = null; }
          }

          return {
            async next(): Promise<IteratorResult<any>> {
              if (done) return { value: undefined as any, done: true };
              if (!rs) await init();
              if (await rs!.next()) {
                const entity = handler.rowMapper.mapRow(rs!);
                await handler.invokeLifecycleCallbacks(entity, "PostLoad");
                handler.changeTracker.snapshot(entity);
                await handler.emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${handler.entityName}`, {
                  type: "loaded",
                  entityClass: handler.entityClass,
                  entityName: handler.entityName,
                  entity,
                  id: handler.getEntityId(entity),
                  timestamp: new Date(),
                } satisfies EntityLoadedEvent<T>);
                return { value: entity, done: false };
              }
              await cleanup();
              return { value: undefined as any, done: true };
            },
            async return(): Promise<IteratorResult<any>> {
              await cleanup();
              return { value: undefined as any, done: true };
            },
            async throw(err?: unknown): Promise<IteratorResult<any>> {
              await cleanup();
              throw err;
            },
          };
        },
      };
    };
  }

  createDerivedMethod(prop: string): (...args: unknown[]) => Promise<any> {
    const handler = this;
    return async (...args: unknown[]) => {
      const descriptor = handler.getCachedDescriptor(prop);

      let projMapper: ProjectionMapper<any> | undefined;
      let queryArgs = args;

      if (args.length > 0 && isProjectionClass(args[args.length - 1])) {
        projMapper = handler.getCachedProjectionMapper(args[args.length - 1] as new (...a: any[]) => any);
        queryArgs = args.slice(0, -1);
      }

      const query = buildDerivedQuery(descriptor, handler.metadata, queryArgs, handler.getTenantCriteria());

      if (descriptor.action === "delete") {
        const conn = await handler.dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          try {
            for (let i = 0; i < query.params.length; i++) {
              stmt.setParameter(i + 1, query.params[i]);
            }
            await stmt.executeUpdate();
            handler.entityCache.evictAll(handler.entityClass);
            handler.queryCache.invalidate(handler.entityClass);
            return;
          } finally {
            await stmt.close().catch(() => {});
          }
        } finally {
          await conn.close();
        }
      }

      const cacheKey = { sql: query.sql, params: query.params as unknown[] };
      const cachedResult = handler.queryCache.get(cacheKey);
      if (cachedResult !== undefined) {
        if (descriptor.action === "count") return cachedResult[0];
        if (descriptor.action === "exists") return cachedResult[0];
        for (const entity of cachedResult as T[]) {
          handler.entityCache.put(handler.entityClass, handler.tenantCacheKey(handler.getEntityId(entity)), entity);
        }
        if (descriptor.limit === 1) return (cachedResult as any[])[0] ?? null;
        return cachedResult;
      }

      const conn = await handler.dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }

          if (descriptor.action === "count") {
            const rs = await stmt.executeQuery();
            if (await rs.next()) {
              const row = rs.getRow();
              const val = Object.values(row)[0];
              const result = typeof val === "number" ? val : Number(val);
              handler.queryCache.put(cacheKey, [result], handler.entityClass);
              return result;
            }
            handler.queryCache.put(cacheKey, [0], handler.entityClass);
            return 0;
          }

          if (descriptor.action === "exists") {
            const rs = await stmt.executeQuery();
            const result = await rs.next();
            handler.queryCache.put(cacheKey, [result], handler.entityClass);
            return result;
          }

          const rs = await stmt.executeQuery();
          const results: any[] = [];
          while (await rs.next()) {
            if (projMapper) {
              results.push(projMapper.mapRow(rs.getRow()));
            } else {
              const mapped = handler.rowMapper.mapRow(rs);
              await handler.invokeLifecycleCallbacks(mapped, "PostLoad");
              handler.changeTracker.snapshot(mapped);
              await handler.emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${handler.entityName}`, {
                type: "loaded",
                entityClass: handler.entityClass,
                entityName: handler.entityName,
                entity: mapped,
                id: handler.getEntityId(mapped),
                timestamp: new Date(),
              } satisfies EntityLoadedEvent<T>);
              results.push(mapped);
            }
          }

          handler.queryCache.put(cacheKey, results, handler.entityClass);

          if (descriptor.limit === 1) return results[0] ?? null;
          return results;
        } finally {
          await stmt.close().catch(() => {});
        }
      } finally {
        await conn.close();
      }
    };
  }
}
