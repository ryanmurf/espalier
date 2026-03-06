/**
 * Base class for aggregate roots using event sourcing.
 * Tracks uncommitted events and provides apply() for state transitions.
 * Event dispatch is automatic when methods are decorated with @EventHandler.
 */

import type { DomainEvent } from "../types.js";
import { getAggregateRootMetadata } from "./aggregate-root.js";
import { getEventHandlers } from "./event-handler.js";

export abstract class AggregateBase {
  private _id: string = "";
  private _version: number = 0;
  private readonly _uncommittedEvents: DomainEvent[] = [];

  get id(): string {
    return this._id;
  }

  protected set id(value: string) {
    this._id = value;
  }

  get version(): number {
    return this._version;
  }

  get uncommittedEvents(): readonly DomainEvent[] {
    return this._uncommittedEvents;
  }

  /**
   * Apply a domain event to this aggregate.
   * Calls the appropriate event handler method and records the event as uncommitted.
   */
  protected apply(eventType: string, payload: Record<string, unknown>): void {
    const event: DomainEvent = {
      eventType,
      aggregateId: this._id,
      aggregateType: this.getAggregateType(),
      payload,
      version: this._version + this._uncommittedEvents.length + 1,
      timestamp: new Date(),
    };

    this.applyEvent(event);
    this._uncommittedEvents.push(event);
  }

  /**
   * Apply an event to update the aggregate's state.
   * Dispatches to @EventHandler-decorated methods when available.
   * Silently ignores events with no registered handler (forward compatibility).
   * Override this method for custom dispatch logic.
   */
  protected applyEvent(event: DomainEvent): void {
    const handlers = getEventHandlers(this.constructor);
    const methodName = handlers.get(event.eventType);
    if (methodName != null) {
      const handler = (this as any)[methodName];
      if (typeof handler === "function") {
        handler.call(this, event);
      }
    }
    // Silently ignore events with no handler for forward compatibility.
  }

  /**
   * Load the aggregate from a history of events (rehydration).
   * Events must be ordered by version in ascending order. An error is thrown
   * if an event's version is less than or equal to the current version.
   */
  loadFromHistory(events: DomainEvent[]): void {
    for (const event of events) {
      if (event.version <= this._version) {
        throw new Error(
          `Out-of-order event: event version ${event.version} is <= current aggregate version ${this._version}. ` +
            `Events must be ordered by ascending version.`,
        );
      }
      this.applyEvent(event);
      this._version = event.version;
    }
  }

  /**
   * Mark all uncommitted events as committed (after successful persistence).
   */
  markEventsAsCommitted(): void {
    this._uncommittedEvents.length = 0;
  }

  /**
   * Get the aggregate type from the @AggregateRoot decorator or class name.
   */
  protected getAggregateType(): string {
    const metadata = getAggregateRootMetadata(this.constructor);
    return metadata?.type ?? this.constructor.name;
  }
}
