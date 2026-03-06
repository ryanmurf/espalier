import type { Plugin, PluginContext } from "espalier-data/plugins";
import type { DataSource } from "espalier-jdbc";
import type { AggregateBase } from "../aggregate/aggregate-base.js";
import { getAggregateRootMetadata } from "../aggregate/aggregate-root.js";
import { isOutboxEntity } from "../outbox/outbox-decorator.js";
import { OutboxStore } from "../outbox/outbox-store.js";
import { EventStore } from "../store/event-store.js";
import type { DomainEvent, EventStoreOptions, OutboxOptions } from "../types.js";

// Access Web Crypto API available in Node 19+, Bun, Deno, and browsers
const _crypto = (globalThis as Record<string, unknown>)["crypto"] as {
  randomUUID(): string;
};

export interface EventSourcingPluginConfig {
  dataSource: DataSource;
  eventStore?: EventStoreOptions;
  outbox?: OutboxOptions;
  /**
   * If true, automatically write entity events to the outbox table.
   * Entities marked with @Outbox will have their persist/update/remove
   * events written to the outbox in the same transaction.
   */
  autoOutbox?: boolean;
}

/**
 * Plugin that integrates event sourcing with the espalier-data framework.
 *
 * When {@link EventSourcingPluginConfig.autoOutbox} is enabled, entity
 * lifecycle events (persist, update, remove) are automatically written to
 * the outbox table for entities decorated with `@Outbox`.
 *
 * The `afterSave` hook checks whether a saved entity is an `@AggregateRoot`
 * and, if so, persists any uncommitted domain events to the event store.
 *
 * **Transactional limitation:** The auto-outbox mode and the `afterSave` hook
 * both open separate connections via `dataSource.getConnection()`, which means
 * writes happen OUTSIDE the entity's transaction. This is a "best-effort"
 * convenience -- NOT a fully transactional outbox. For true transactional
 * guarantees, callers must use {@link OutboxStore.writeEvents} and
 * {@link EventStore.append} within their own transaction, passing the active
 * connection explicitly.
 */
export class EventSourcingPlugin implements Plugin {
  readonly name = "event-sourcing";
  readonly version = "1.0.0";

  private readonly eventStore: EventStore;
  private readonly outboxStore: OutboxStore;
  private readonly config: EventSourcingPluginConfig;

  constructor(config: EventSourcingPluginConfig) {
    this.config = config;
    this.eventStore = new EventStore(config.eventStore);
    this.outboxStore = new OutboxStore(config.outbox);
  }

  async init(context: PluginContext): Promise<void> {
    if (this.config.autoOutbox) {
      context.eventBus.on("entity:persisted", (payload: unknown) => {
        this.writeOutboxEvent("persisted", payload).catch((err) => {
          this.logError("Failed to write outbox event for entity:persisted", err);
        });
      });
      context.eventBus.on("entity:updated", (payload: unknown) => {
        this.writeOutboxEvent("updated", payload).catch((err) => {
          this.logError("Failed to write outbox event for entity:updated", err);
        });
      });
      context.eventBus.on("entity:removed", (payload: unknown) => {
        this.writeOutboxEvent("removed", payload).catch((err) => {
          this.logError("Failed to write outbox event for entity:removed", err);
        });
      });
    }

    context.addHook({
      type: "afterSave",
      handler: async (hookContext) => {
        if (!hookContext.entities || hookContext.entities.length === 0) {
          return;
        }
        for (const entity of hookContext.entities) {
          if (entity == null || typeof entity !== "object") continue;
          const ctor = (entity as object).constructor;
          const aggMeta = getAggregateRootMetadata(ctor);
          if (!aggMeta) continue;

          const aggregate = entity as AggregateBase;
          if (
            typeof aggregate.uncommittedEvents !== "undefined" &&
            Array.isArray(aggregate.uncommittedEvents) &&
            aggregate.uncommittedEvents.length > 0
          ) {
            // NOTE: This opens a separate connection outside the entity's transaction.
            // For true transactional event persistence, use EventStore.append(connection, ...)
            // within your own transaction.
            const connection = await this.config.dataSource.getConnection();
            try {
              await this.eventStore.append(
                connection,
                aggregate.id,
                aggMeta.type ?? ctor.name,
                [...aggregate.uncommittedEvents],
                aggregate.version,
              );
              aggregate.markEventsAsCommitted();
            } finally {
              await connection.close();
            }
          }
        }
      },
    });
  }

  getEventStore(): EventStore {
    return this.eventStore;
  }

  getOutboxStore(): OutboxStore {
    return this.outboxStore;
  }

  private async writeOutboxEvent(action: string, payload: unknown): Promise<void> {
    if (payload == null || typeof payload !== "object") return;

    const entityPayload = payload as {
      entityClass?: new (...args: unknown[]) => unknown;
      entity?: Record<string, unknown>;
    };

    if (!entityPayload.entityClass || !entityPayload.entity) return;

    // Only write outbox events for entities decorated with @Outbox
    if (!isOutboxEntity(entityPayload.entityClass)) return;

    const entity = entityPayload.entity;
    const aggregateType = entityPayload.entityClass.name;
    const aggregateId = String(entity["id"] ?? entity["_id"] ?? _crypto.randomUUID());

    const event: DomainEvent = {
      eventType: `entity.${action}`,
      aggregateId,
      aggregateType,
      payload: { entity },
      version: 1,
      timestamp: new Date(),
    };

    // NOTE: This opens a separate connection outside the entity's transaction.
    // For true transactional outbox, use OutboxStore.writeEvents(connection, events)
    // within your own transaction.
    const connection = await this.config.dataSource.getConnection();
    try {
      await this.outboxStore.writeEvents(connection, [event]);
    } finally {
      await connection.close();
    }
  }

  private logError(message: string, err: unknown): void {
    const errorMessage = err instanceof Error ? err.message : String(err);
    (globalThis as any).console?.error?.(`[EventSourcingPlugin] ${message}: ${errorMessage}`);
  }
}
