type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

interface HandlerEntry {
  handler: EventHandler<any>;
  once: boolean;
  consumed: boolean;
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

    // Snapshot to avoid concurrent modification issues:
    // - Handlers added during emit won't fire in this cycle
    // - off() during emit won't cause handler skips
    const snapshot = entries.slice();
    const errors: unknown[] = [];
    const onceEntries: HandlerEntry[] = [];

    for (const entry of snapshot) {
      // Skip once-handlers that were already consumed by a concurrent emit
      if (entry.once && entry.consumed) continue;
      if (entry.once) {
        entry.consumed = true;
      }
      try {
        const result = entry.handler(payload);
        if (result instanceof Promise) {
          await result;
        }
      } catch (err) {
        errors.push(err);
      }
      if (entry.once) {
        onceEntries.push(entry);
      }
    }

    // Remove once-handlers from the live array by reference
    for (const entry of onceEntries) {
      const idx = entries.indexOf(entry);
      if (idx !== -1) {
        entries.splice(idx, 1);
      }
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
    entries.push({ handler, once, consumed: false });
  }
}

const globalEventBus = new EventBus();

export function getGlobalEventBus(): EventBus {
  return globalEventBus;
}
