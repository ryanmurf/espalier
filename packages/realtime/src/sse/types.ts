/**
 * Minimal request interface for generic HTTP handler compatibility.
 */
export interface SseRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Minimal response interface for generic HTTP handler compatibility.
 */
export interface SseResponse {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  write(data: string): boolean;
  end(): void;
  on(event: string, listener: () => void): void;
}

/**
 * Options for configuring SSE endpoint behavior.
 */
export interface SseOptions {
  /** Heartbeat interval in milliseconds. Defaults to 30000 (30 seconds). */
  heartbeatIntervalMs?: number;
  /** Custom event type name. Defaults to "change". */
  eventType?: string;
}
