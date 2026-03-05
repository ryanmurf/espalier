import type { ChangeNotification } from "../notifications/types.js";
import type { ChangeEvent, OperationType, WatchOptions } from "./types.js";

/**
 * A high-level change stream that transforms raw ChangeNotifications into
 * typed ChangeEvent objects with filtering support.
 *
 * Usage:
 * ```ts
 * const stream = new ChangeStream<User>(notificationSource, parseUser);
 * for await (const event of stream.watch({ operations: ['INSERT', 'UPDATE'] })) {
 *   console.log(event.operation, event.entity);
 * }
 * ```
 */
export class ChangeStream<T> {
  private readonly source: AsyncIterable<ChangeNotification>;
  private readonly parse: (payload: string) => ParsedPayload<T>;
  private abortController: AbortController | null = null;

  /**
   * @param source An async iterable of raw change notifications (e.g., from ChangeNotificationListener or PollingChangeDetector)
   * @param parse A function that parses a notification payload string into a ParsedPayload
   */
  constructor(
    source: AsyncIterable<ChangeNotification>,
    parse?: (payload: string) => ParsedPayload<T>,
  ) {
    this.source = source;
    this.parse = parse ?? defaultParse;
  }

  /**
   * Watch for change events, optionally filtering by operation type and field names.
   */
  async *watch(options?: WatchOptions): AsyncIterable<ChangeEvent<T>> {
    const allowedOps = options?.operations
      ? new Set(options.operations)
      : null;
    const watchedFields = options?.fields
      ? new Set(options.fields)
      : null;

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    try {
      for await (const notification of this.source) {
        if (signal.aborted) break;

        let parsed: ParsedPayload<T>;
        try {
          parsed = this.parse(notification.payload);
        } catch {
          // Skip unparseable notifications
          continue;
        }

        // Filter by operation type
        if (allowedOps && !allowedOps.has(parsed.operation)) {
          continue;
        }

        const event: ChangeEvent<T> = {
          operation: parsed.operation,
          entity: parsed.entity,
          previousEntity: parsed.previousEntity,
          changedFields: parsed.changedFields,
          timestamp: notification.timestamp,
        };

        // Filter by fields (only for UPDATE events)
        if (watchedFields && event.operation === "UPDATE" && event.changedFields) {
          const hasWatchedField = event.changedFields.some((f) => watchedFields.has(f));
          if (!hasWatchedField) {
            continue;
          }
        }

        yield event;
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Stop the change stream.
   */
  close(): void {
    this.abortController?.abort();
  }
}

/**
 * Parsed representation of a change notification payload.
 */
export interface ParsedPayload<T> {
  operation: OperationType;
  entity: T;
  previousEntity?: T;
  changedFields?: string[];
}

/**
 * Default payload parser that expects a JSON object with `operation`, `row`,
 * and optionally `old_row` and `changed_fields`.
 */
function defaultParse<T>(payload: string): ParsedPayload<T> {
  const data = JSON.parse(payload) as {
    operation: string;
    row?: unknown;
    old_row?: unknown;
    changed_fields?: string[];
  };

  if (!["INSERT", "UPDATE", "DELETE"].includes(data.operation)) {
    throw new Error(`Unknown operation: ${data.operation}`);
  }
  const operation = data.operation as OperationType;

  return {
    operation,
    entity: (data.row ?? data) as T,
    previousEntity: data.old_row as T | undefined,
    changedFields: data.changed_fields,
  };
}
