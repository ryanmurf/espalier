import type { Command, CommandResult } from "../types.js";
import type { CommandMiddlewareFn } from "./command-bus.js";

declare function setTimeout(callback: (...args: unknown[]) => void, ms: number): unknown;
declare const console: Logger;

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
}

/**
 * Logging middleware — logs command dispatch and results.
 */
export function loggingMiddleware(
  logger?: Logger,
): CommandMiddlewareFn {
  return async (command: Command, next: () => Promise<CommandResult>) => {
    const log = logger ?? console as Logger;
    const start = Date.now();
    log.info(`Dispatching command: ${command.commandType}`, command.payload);
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
export function validationMiddleware(
  validators: Map<string, (cmd: Command) => string | null>,
): CommandMiddlewareFn {
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
 */
export function retryMiddleware(maxRetries: number = 3, baseDelayMs: number = 100): CommandMiddlewareFn {
  return async (command: Command, next: () => Promise<CommandResult>) => {
    let lastResult: CommandResult = { success: false, events: [], error: new Error("No attempts made") };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      lastResult = await next();
      if (lastResult.success) return lastResult;
      if (attempt < maxRetries) {
        await new Promise<void>(resolve => setTimeout(() => resolve(), baseDelayMs * Math.pow(2, attempt)));
      }
    }
    return lastResult;
  };
}
