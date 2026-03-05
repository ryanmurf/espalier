export interface DomainEvent {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly payload: Record<string, unknown>;
  readonly version: number;
  readonly timestamp: Date;
  readonly metadata?: Record<string, unknown>;
}

export interface StoredEvent extends DomainEvent {
  readonly eventId: string;
  readonly sequence: number; // Global ordering
}

export interface Command {
  readonly commandType: string;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface CommandResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: Error;
  events: DomainEvent[];
}

export interface OutboxEntry {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
  publishedAt: Date | null;
}

export interface EventStoreOptions {
  tableName?: string; // Default: 'event_store'
  schemaName?: string;
}

export interface OutboxOptions {
  tableName?: string; // Default: 'outbox'
  schemaName?: string;
  pollIntervalMs?: number; // Default: 1000
  batchSize?: number; // Default: 100
}
