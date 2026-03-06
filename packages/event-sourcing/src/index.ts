// Core types

// Adapter
export type { ExternalEventBusAdapter } from "./adapter/index.js";
export { InMemoryEventBusAdapter } from "./adapter/index.js";
export type { AggregateRootMetadata, AggregateRootOptions } from "./aggregate/index.js";
// Aggregate root
export {
  AggregateBase,
  AggregateRoot,
  EventHandler,
  getAggregateRootMetadata,
  getEventHandlers,
  isAggregateRoot,
} from "./aggregate/index.js";
export type {
  CommandHandlerFn,
  CommandHandlerOptions,
  CommandMiddlewareFn,
} from "./command/index.js";

// Command bus
export {
  CommandBus,
  CommandHandler,
  getCommandHandlerMetadata,
  getGlobalCommandBus,
  isCommandHandler,
  loggingMiddleware,
  resetGlobalCommandBus,
  retryMiddleware,
  validationMiddleware,
} from "./command/index.js";
export type { OutboxDecoratorOptions, OutboxPublishFn } from "./outbox/index.js";
// Outbox
export { getOutboxMetadata, isOutboxEntity, Outbox, OutboxPublisher, OutboxStore } from "./outbox/index.js";
// Plugin
export type { EventSourcingPluginConfig } from "./plugin/index.js";
export { EventSourcingPlugin } from "./plugin/index.js";
export type { ProjectionHandler, ProjectionOptions } from "./projection/index.js";
// Projection
export { getProjectionMetadata, Projection, ProjectionRunner } from "./projection/index.js";
export type { ReplayOptions } from "./replay/index.js";
// Replay
export { EventReplayer } from "./replay/index.js";
export type { AggregateSnapshot } from "./snapshot/index.js";

// Snapshot
export { SnapshotStore } from "./snapshot/index.js";
// Event store
export { ConcurrencyError, EventStore } from "./store/index.js";
export type {
  Command,
  CommandResult,
  DomainEvent,
  EventStoreOptions,
  OutboxEntry,
  OutboxOptions,
  StoredEvent,
} from "./types.js";
