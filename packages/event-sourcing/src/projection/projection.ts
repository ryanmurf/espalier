import type { Connection } from "espalier-jdbc";
import type { StoredEvent } from "../types.js";
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
  return function <T extends new (...args: any[]) => any>(
    target: T,
    _context: ClassDecoratorContext,
  ): T {
    projectionMetadata.set(target, { ...options });
    return target;
  };
}

export function getProjectionMetadata(
  target: object,
): ProjectionOptions | undefined {
  const meta = projectionMetadata.get(target);
  if (!meta) return undefined;
  return { ...meta, eventTypes: [...meta.eventTypes] };
}

export class ProjectionRunner {
  constructor(
    private eventStore: EventStore,
    private connection: Connection,
  ) {}

  async rebuild(
    projectionInstance: { handlers?: ProjectionHandler[] },
  ): Promise<number> {
    const handlers = projectionInstance.handlers;
    if (!handlers || handlers.length === 0) return 0;

    const handlerMap = new Map<string, ProjectionHandler>();
    for (const h of handlers) {
      handlerMap.set(h.eventType, h);
    }

    const events = await this.eventStore.loadAllEvents(
      this.connection,
      { eventTypes: [...handlerMap.keys()] },
    );

    let processed = 0;
    for (const event of events) {
      const handler = handlerMap.get(event.eventType);
      if (handler) {
        await handler.handle(event, this.connection);
        processed++;
      }
    }

    return processed;
  }

  async processNewEvents(
    projectionInstance: { handlers?: ProjectionHandler[] },
    sinceSequence?: number,
  ): Promise<number> {
    const handlers = projectionInstance.handlers;
    if (!handlers || handlers.length === 0) return 0;

    const handlerMap = new Map<string, ProjectionHandler>();
    for (const h of handlers) {
      handlerMap.set(h.eventType, h);
    }

    const events = await this.eventStore.loadAllEvents(
      this.connection,
      {
        eventTypes: [...handlerMap.keys()],
        fromSequence: sinceSequence,
      },
    );

    let processed = 0;
    for (const event of events) {
      const handler = handlerMap.get(event.eventType);
      if (handler) {
        await handler.handle(event, this.connection);
        processed++;
      }
    }

    return processed;
  }
}
