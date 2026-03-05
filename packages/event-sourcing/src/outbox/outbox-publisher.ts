import type { DataSource } from "espalier-jdbc";
import type { OutboxOptions, OutboxEntry } from "../types.js";
import { OutboxStore } from "./outbox-store.js";

// Ambient timer globals (available in Node, Bun, Deno, browsers)
declare function setInterval(callback: (...args: unknown[]) => void, ms: number): unknown;
declare function clearInterval(handle: unknown): void;

export type OutboxPublishFn = (entries: OutboxEntry[]) => Promise<void>;

/**
 * Polls the outbox table and publishes events to external systems.
 * Implements at-least-once delivery semantics.
 */
export class OutboxPublisher {
  private readonly store: OutboxStore;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private timer: unknown = null;
  private running = false;
  private publishFn: OutboxPublishFn | null = null;

  constructor(
    private readonly dataSource: DataSource,
    options?: OutboxOptions,
  ) {
    this.store = new OutboxStore(options);
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.batchSize = options?.batchSize ?? 100;
  }

  /**
   * Set the publish function that delivers events to the external system.
   * E.g., publish to Kafka, Redis Streams, NATS, or a custom EventBus.
   */
  onPublish(fn: OutboxPublishFn): void {
    this.publishFn = fn;
  }

  /**
   * Start the polling publisher.
   */
  start(): void {
    if (this.running) return;
    if (!this.publishFn) {
      throw new Error(
        "No publish function registered. Call onPublish() before start().",
      );
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    // Do an immediate first poll
    void this.poll();
  }

  /**
   * Stop the polling publisher.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Check if the publisher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Perform a single poll cycle (for testing or manual triggering).
   */
  async poll(): Promise<number> {
    if (!this.publishFn) return 0;

    const connection = await this.dataSource.getConnection();
    try {
      const entries = await this.store.fetchUnpublished(
        connection,
        this.batchSize,
      );
      if (entries.length === 0) return 0;

      // Publish to external system
      await this.publishFn(entries);

      // Mark as published
      await this.store.markPublished(
        connection,
        entries.map((e) => e.id),
      );

      return entries.length;
    } finally {
      await connection.close();
    }
  }

  /**
   * Clean up old published entries.
   */
  async cleanup(olderThan: Date): Promise<number> {
    const connection = await this.dataSource.getConnection();
    try {
      return await this.store.deletePublished(connection, olderThan);
    } finally {
      await connection.close();
    }
  }
}
