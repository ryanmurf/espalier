type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

interface HandlerEntry {
  handler: EventHandler<any>;
  once: boolean;
}

export class EventBus {
  private readonly listeners = new Map<string, HandlerEntry[]>();

  on<T>(event: string, handler: EventHandler<T>): void {
    this.addHandler(event, handler, false);
  }

  once<T>(event: string, handler: EventHandler<T>): void {
    this.addHandler(event, handler, true);
  }

  off(event: string, handler: EventHandler): void {
    const entries = this.listeners.get(event);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.handler === handler);
    if (idx !== -1) {
      entries.splice(idx, 1);
      if (entries.length === 0) {
        this.listeners.delete(event);
      }
    }
  }

  async emit<T>(event: string, payload: T): Promise<void> {
    const entries = this.listeners.get(event);
    if (!entries || entries.length === 0) return;

    const errors: unknown[] = [];
    const toRemove: number[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      try {
        const result = entry.handler(payload);
        if (result instanceof Promise) {
          await result;
        }
      } catch (err) {
        errors.push(err);
      }
      if (entry.once) {
        toRemove.push(i);
      }
    }

    // Remove once-handlers in reverse order to preserve indices
    for (let i = toRemove.length - 1; i >= 0; i--) {
      entries.splice(toRemove[i], 1);
    }
    if (entries.length === 0) {
      this.listeners.delete(event);
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} handler(s) threw for event "${event}"`);
    }
  }

  removeAllListeners(event?: string): void {
    if (event !== undefined) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  private addHandler(event: string, handler: EventHandler<any>, once: boolean): void {
    let entries = this.listeners.get(event);
    if (!entries) {
      entries = [];
      this.listeners.set(event, entries);
    }
    entries.push({ handler, once });
  }
}

const globalEventBus = new EventBus();

export function getGlobalEventBus(): EventBus {
  return globalEventBus;
}
