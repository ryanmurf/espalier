import type { Connection, DataSource } from "espalier-jdbc";
import { validateIdentifier } from "espalier-jdbc";
import type { ChangeNotification } from "./types.js";

/**
 * Listens for PostgreSQL LISTEN/NOTIFY change notifications on named channels.
 *
 * Usage:
 * ```ts
 * const listener = new ChangeNotificationListener(dataSource);
 * for await (const notification of listener.listen("my_channel")) {
 *   console.log(notification.payload);
 * }
 * ```
 */
export class ChangeNotificationListener {
  private readonly dataSource: DataSource;
  private readonly activeChannels = new Map<string, AbortController>();
  private closed = false;

  constructor(dataSource: DataSource) {
    this.dataSource = dataSource;
  }

  /**
   * Listen on a PostgreSQL NOTIFY channel, yielding notifications as they arrive.
   * The returned async iterable completes when `unlisten` is called for the channel
   * or when the listener is closed.
   */
  async *listen(channel: string): AsyncGenerator<ChangeNotification> {
    validateIdentifier(channel, "channel name");

    if (this.closed) {
      throw new Error("ChangeNotificationListener has been closed");
    }

    if (this.activeChannels.has(channel)) {
      throw new Error(`Already listening on channel "${channel}"`);
    }

    const controller = new AbortController();
    this.activeChannels.set(channel, controller);

    const connection = await this.dataSource.getConnection();
    try {
      // Issue LISTEN command
      const stmt = connection.prepareStatement(`LISTEN ${quoteChannel(channel)}`);
      await stmt.executeUpdate();

      // Poll for notifications using the pg-specific notification mechanism.
      // We use a queue + polling approach since the JDBC abstraction
      // doesn't expose raw socket events.
      const MAX_QUEUE_SIZE = 10_000;
      const queue: ChangeNotification[] = [];
      let resolveWaiter: (() => void) | null = null;

      // Set up a polling loop that checks for notifications
      const pollInterval = setInterval(async () => {
        try {
          // Execute empty query to trigger notification delivery on the connection
          const pollStmt = connection.prepareStatement("SELECT 1");
          const rs = await pollStmt.executeQuery();
          await rs.close();
        } catch {
          // Connection may have been closed
        }
      }, 500);

      // Access the underlying pg client's notification events if available
      const rawClient =
        (connection as unknown as Record<string, unknown>)["_client"] ??
        (connection as unknown as Record<string, unknown>)["client"];

      const notificationHandler = (msg: { channel: string; payload: string }) => {
        if (msg.channel === channel && queue.length < MAX_QUEUE_SIZE) {
          queue.push({
            channel: msg.channel,
            payload: msg.payload ?? "",
            timestamp: new Date(),
          });
          resolveWaiter?.();
        }
      };

      if (rawClient && typeof (rawClient as Record<string, unknown>).on === "function") {
        (rawClient as { on: (event: string, cb: typeof notificationHandler) => void }).on(
          "notification",
          notificationHandler,
        );
      } else {
        clearInterval(pollInterval);
        await connection.close();
        this.activeChannels.delete(channel);
        throw new Error(
          "Cannot access underlying database client for LISTEN/NOTIFY. " +
            "ChangeNotificationListener requires a PostgreSQL connection from espalier-jdbc-pg.",
        );
      }

      try {
        while (!controller.signal.aborted) {
          if (queue.length > 0) {
            yield queue.shift()!;
          } else {
            // Wait for a notification or abort
            await Promise.race([
              new Promise<void>((resolve) => {
                resolveWaiter = resolve;
              }),
              new Promise<void>((resolve) => {
                controller.signal.addEventListener("abort", () => resolve(), { once: true });
              }),
            ]);
          }
        }
      } finally {
        clearInterval(pollInterval);
        // Remove notification listener to prevent memory leak
        if (rawClient && typeof (rawClient as Record<string, unknown>).off === "function") {
          (rawClient as { off: (event: string, cb: typeof notificationHandler) => void }).off(
            "notification",
            notificationHandler,
          );
        }
        // Issue UNLISTEN
        try {
          const unlistenStmt = connection.prepareStatement(`UNLISTEN ${quoteChannel(channel)}`);
          await unlistenStmt.executeUpdate();
        } catch {
          // Best effort
        }
        await connection.close();
        this.activeChannels.delete(channel);
      }
    } catch (error) {
      // Connection is cleaned up by inner finally or by the raw client check above.
      // Only clean up the channel map entry here.
      this.activeChannels.delete(channel);
      throw error;
    }
  }

  /**
   * Send a NOTIFY on a channel through a given connection.
   */
  async notify(connection: Connection, channel: string, payload: string): Promise<void> {
    validateIdentifier(channel, "channel name");

    // Use pg_notify function with parameterized query for payload safety
    const stmt = connection.prepareStatement("SELECT pg_notify($1, $2)");
    stmt.setParameter(1, channel);
    stmt.setParameter(2, payload);
    const rs = await stmt.executeQuery();
    await rs.close();
  }

  /**
   * Stop listening on a specific channel.
   */
  unlisten(channel: string): void {
    const controller = this.activeChannels.get(channel);
    if (controller) {
      controller.abort();
    }
  }

  /**
   * Stop listening on all channels and release resources.
   */
  close(): void {
    this.closed = true;
    for (const controller of this.activeChannels.values()) {
      controller.abort();
    }
    this.activeChannels.clear();
  }
}

/**
 * Quote a channel name for use in LISTEN/UNLISTEN statements.
 * Channel names are validated as identifiers first, then double-quote escaped.
 */
function quoteChannel(channel: string): string {
  return `"${channel.replace(/"/g, '""')}"`;
}
