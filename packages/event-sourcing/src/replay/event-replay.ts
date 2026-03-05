import type { Connection } from "espalier-jdbc";
import type { StoredEvent } from "../types.js";
import type { EventStore } from "../store/event-store.js";

export interface ReplayOptions {
  aggregateTypes?: string[];
  fromTimestamp?: Date;
  toTimestamp?: Date;
  fromVersion?: number;
  batchSize?: number;
}

export class EventReplayer {
  constructor(private eventStore: EventStore) {}

  async replay(
    connection: Connection,
    handler: (event: StoredEvent) => Promise<void>,
    options?: ReplayOptions,
  ): Promise<number> {
    const batchSize = options?.batchSize ?? 100;
    let processed = 0;
    let lastSequence = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const events = await this.eventStore.loadAllEvents(connection, {
        aggregateTypes: options?.aggregateTypes,
        fromTimestamp: options?.fromTimestamp,
        toTimestamp: options?.toTimestamp,
        fromVersion: options?.fromVersion,
        fromSequence: lastSequence > 0 ? lastSequence : undefined,
        limit: batchSize,
      });

      if (events.length === 0) break;

      for (const event of events) {
        await handler(event);
        processed++;
        lastSequence = event.sequence;
      }

      if (events.length < batchSize) break;
    }

    return processed;
  }
}
