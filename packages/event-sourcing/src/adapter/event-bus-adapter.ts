import type { DomainEvent } from "../types.js";

/**
 * Interface for external event bus adapters (Redis Streams, Kafka, NATS, etc.)
 */
export interface ExternalEventBusAdapter {
  /**
   * Publish events to the external system.
   * Called by the outbox publisher after events are committed.
   */
  publish(events: DomainEvent[]): Promise<void>;

  /**
   * Subscribe to events from the external system.
   * Returns an unsubscribe function.
   */
  subscribe(eventTypes: string[] | "*", handler: (event: DomainEvent) => Promise<void>): () => void;

  /**
   * Connect to the external system.
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the external system.
   */
  disconnect(): Promise<void>;
}

interface Subscription {
  eventTypes: string[] | "*";
  handler: (event: DomainEvent) => Promise<void>;
}

/**
 * In-memory adapter that bridges to the espalier-data EventBus.
 * Used for testing or single-process applications.
 */
export class InMemoryEventBusAdapter implements ExternalEventBusAdapter {
  private readonly subscriptions = new Map<number, Subscription>();
  private nextId = 0;
  private connected = false;

  async publish(events: DomainEvent[]): Promise<void> {
    if (!this.connected) throw new Error("Not connected");
    for (const event of events) {
      for (const sub of this.subscriptions.values()) {
        if (sub.eventTypes === "*" || sub.eventTypes.includes(event.eventType)) {
          await sub.handler(event);
        }
      }
    }
  }

  subscribe(eventTypes: string[] | "*", handler: (event: DomainEvent) => Promise<void>): () => void {
    if (!this.connected) throw new Error("Not connected");
    const id = this.nextId++;
    this.subscriptions.set(id, { eventTypes, handler });
    return () => {
      this.subscriptions.delete(id);
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.subscriptions.clear();
  }

  /**
   * Check whether the adapter is currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Returns the current number of active subscriptions.
   */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }
}
