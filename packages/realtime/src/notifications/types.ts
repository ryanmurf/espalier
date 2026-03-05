/**
 * A change notification received from a database channel.
 */
export interface ChangeNotification {
  /** The channel the notification was received on. */
  channel: string;
  /** The payload string sent with the notification. */
  payload: string;
  /** When the notification was received. */
  timestamp: Date;
}

/**
 * Options for the polling change detector fallback.
 */
export interface PollingOptions {
  /** Polling interval in milliseconds. Clamped to [100, 60000]. */
  intervalMs: number;
  /** SQL query that returns changed rows. Must return at least an `id` column. */
  query: string;
  /** Optional parameters for the query. */
  params?: unknown[];
}
