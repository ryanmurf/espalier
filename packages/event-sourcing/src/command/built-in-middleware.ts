import type { Command, CommandResult } from "../types.js";
import type { CommandMiddlewareFn } from "./command-bus.js";

declare function setTimeout(callback: (...args: unknown[]) => void, ms: number): unknown;
declare const console: Logger;

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
}

export interface LoggingMiddlewareOptions {
  logger?: Logger;
  /** When true, omit the command payload from log output (default: true). */
  redact?: boolean;
}

/**
 * Logging middleware — logs command dispatch and results.
 * By default the command payload is redacted to avoid info leakage.
 */
export function loggingMiddleware(loggerOrOptions?: Logger | LoggingMiddlewareOptions): CommandMiddlewareFn {
  const opts: LoggingMiddlewareOptions =
    loggerOrOptions && "info" in loggerOrOptions ? { logger: loggerOrOptions } : (loggerOrOptions ?? {});
  const redact = opts.redact ?? true;

  return async (command: Command, next: () => Promise<CommandResult>) => {
    const log = opts.logger ?? (console as Logger);
    const start = Date.now();
    if (redact) {
      log.info(`Dispatching command: ${command.commandType}`);
    } else {
      log.info(`Dispatching command: ${command.commandType}`, command.payload);
    }
    const result = await next();
    const duration = Date.now() - start;
    if (result.success) {
      log.info(`Command ${command.commandType} succeeded in ${duration}ms, ${result.events.length} events`);
    } else {
      log.info(`Command ${command.commandType} failed in ${duration}ms: ${result.error?.message}`);
    }
    return result;
  };
}

/**
 * Validation middleware — validates commands before dispatch.
 */
export function validationMiddleware(validators: Map<string, (cmd: Command) => string | null>): CommandMiddlewareFn {
  return async (command: Command, next: () => Promise<CommandResult>) => {
    const validator = validators.get(command.commandType);
    if (validator) {
      const error = validator(command);
      if (error) {
        return {
          success: false,
          error: new Error(`Validation failed for ${command.commandType}: ${error}`),
          events: [],
        };
      }
    }
    return next();
  };
}

/**
 * Retry middleware — retries failed commands with exponential backoff.
 *
 * **Important:** Register this middleware LAST (closest to the handler) in the
 * middleware chain. Because retry calls `next()` multiple times, any middleware
 * registered *after* retryMiddleware (i.e., earlier in the chain / farther from
 * the handler) will also be replayed on each retry attempt. Placing retry last
 * ensures only the handler itself is re-executed.
 */
export function retryMiddleware(maxRetries: number = 3, baseDelayMs: number = 100): CommandMiddlewareFn {
  return async (command: Command, next: () => Promise<CommandResult>) => {
    let lastResult: CommandResult = { success: false, events: [], error: new Error("No attempts made") };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      lastResult = await next();
      if (lastResult.success) return lastResult;
      if (attempt < maxRetries) {
        await new Promise<void>((resolve) => setTimeout(() => resolve(), baseDelayMs * 2 ** attempt));
      }
    }
    return lastResult;
  };
}
