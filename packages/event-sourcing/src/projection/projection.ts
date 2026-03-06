import type { Connection } from "espalier-jdbc";
import type { EventStore } from "../store/event-store.js";

export interface ProjectionHandler<TEvent = unknown> {
  eventType: string;
  handle(event: TEvent, connection: Connection): Promise<void>;
}

export interface ProjectionOptions {
  name: string;
  eventTypes: string[];
}

const projectionMetadata = new WeakMap<object, ProjectionOptions>();

export function Projection(options: ProjectionOptions) {
  return <T extends new (...args: any[]) => any>(target: T, _context: ClassDecoratorContext): T => {
    projectionMetadata.set(target, { ...options });
    return target;
  };
}

export function getProjectionMetadata(target: object): ProjectionOptions | undefined {
  const meta = projectionMetadata.get(target);
  if (!meta) return undefined;
  return { ...meta, eventTypes: [...meta.eventTypes] };
}

export class ProjectionRunner {
  constructor(
    private eventStore: EventStore,
    private connection: Connection,
  ) {}

  private static readonly DEFAULT_BATCH_SIZE = 100;

  async rebuild(
    projectionInstance: { handlers?: ProjectionHandler[] },
    batchSize: number = ProjectionRunner.DEFAULT_BATCH_SIZE,
  ): Promise<number> {
    return this.processEvents(projectionInstance, undefined, batchSize);
  }

  async processNewEvents(
    projectionInstance: { handlers?: ProjectionHandler[] },
    sinceSequence?: number,
    batchSize: number = ProjectionRunner.DEFAULT_BATCH_SIZE,
  ): Promise<number> {
    return this.processEvents(projectionInstance, sinceSequence, batchSize);
  }

  private async processEvents(
    projectionInstance: { handlers?: ProjectionHandler[] },
    fromSequence: number | undefined,
    batchSize: number,
  ): Promise<number> {
    const handlers = projectionInstance.handlers;
    if (!handlers || handlers.length === 0) return 0;

    const handlerMap = new Map<string, ProjectionHandler>();
    for (const h of handlers) {
      handlerMap.set(h.eventType, h);
    }

    let processed = 0;
    let lastSequence = fromSequence;

    // Process in batches to avoid loading all events into memory
    while (true) {
      const events = await this.eventStore.loadAllEvents(this.connection, {
        eventTypes: [...handlerMap.keys()],
        fromSequence: lastSequence,
        limit: batchSize,
      });

      if (events.length === 0) break;

      const prevSequence = lastSequence;
      for (const event of events) {
        const handler = handlerMap.get(event.eventType);
        if (handler) {
          await handler.handle(event, this.connection);
          processed++;
        }
        if (typeof event.sequence === "number") {
          lastSequence = event.sequence;
        }
      }

      // Safety: break if sequence didn't advance (prevents infinite loop)
      if (lastSequence === prevSequence && events.length === batchSize) break;
      if (events.length < batchSize) break;
    }

    return processed;
  }
}
