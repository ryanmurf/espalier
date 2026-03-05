// Core types
export type {
  DomainEvent,
  StoredEvent,
  Command,
  CommandResult,
  OutboxEntry,
  EventStoreOptions,
  OutboxOptions,
} from "./types.js";

// Event store
export { EventStore } from "./store/index.js";
export { ConcurrencyError } from "./store/index.js";

// Aggregate root
export { AggregateRoot, getAggregateRootMetadata, isAggregateRoot } from "./aggregate/index.js";
export type { AggregateRootOptions, AggregateRootMetadata } from "./aggregate/index.js";
export { AggregateBase } from "./aggregate/index.js";
export { EventHandler, getEventHandlers } from "./aggregate/index.js";

// Command bus
export {
  CommandBus,
  getGlobalCommandBus,
  resetGlobalCommandBus,
  CommandHandler,
  getCommandHandlerMetadata,
  isCommandHandler,
  loggingMiddleware,
  validationMiddleware,
  retryMiddleware,
} from "./command/index.js";
export type {
  CommandHandlerFn,
  CommandMiddlewareFn,
  CommandHandlerOptions,
} from "./command/index.js";

// Outbox
export { OutboxStore } from "./outbox/index.js";
export { OutboxPublisher } from "./outbox/index.js";
export type { OutboxPublishFn } from "./outbox/index.js";
export { Outbox, getOutboxMetadata, isOutboxEntity } from "./outbox/index.js";
export type { OutboxDecoratorOptions } from "./outbox/index.js";

// Adapter
export type { ExternalEventBusAdapter } from "./adapter/index.js";
export { InMemoryEventBusAdapter } from "./adapter/index.js";

// Plugin
export type { EventSourcingPluginConfig } from "./plugin/index.js";
export { EventSourcingPlugin } from "./plugin/index.js";
