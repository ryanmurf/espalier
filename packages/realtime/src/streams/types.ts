/**
 * The type of database operation that triggered a change event.
 */
export type OperationType = "INSERT" | "UPDATE" | "DELETE";

/**
 * A change event emitted by a ChangeStream, representing a single
 * INSERT, UPDATE, or DELETE on a watched entity.
 */
export interface ChangeEvent<T> {
  /** The operation that caused the change. */
  operation: OperationType;
  /** The entity after the change (the new row for INSERT/UPDATE, the deleted row for DELETE). */
  entity: T;
  /** The entity before the change (available for UPDATE and DELETE). */
  previousEntity?: T;
  /** The names of fields that changed (available for UPDATE). */
  changedFields?: string[];
  /** When the change event was created. */
  timestamp: Date;
}

/**
 * Options for filtering which change events are emitted by a ChangeStream.
 */
export interface WatchOptions {
  /** Only emit events for these operation types. Defaults to all. */
  operations?: OperationType[];
  /** Only emit events that involve changes to these field names. Only applies to UPDATE events. */
  fields?: string[];
}
