import type { Command, CommandResult } from "../types.js";

export type CommandHandlerFn<C extends Command = Command, R = unknown> =
  (command: C) => Promise<CommandResult<R>>;

export type CommandMiddlewareFn = (
  command: Command,
  next: () => Promise<CommandResult>,
) => Promise<CommandResult>;

export class CommandBus {
  private readonly handlers = new Map<string, CommandHandlerFn>();
  private readonly middlewares: CommandMiddlewareFn[] = [];

  /**
   * Register a handler for a specific command type.
   * Only one handler per command type is allowed.
   */
  register<C extends Command>(
    commandType: string,
    handler: CommandHandlerFn<C>,
  ): void {
    if (this.handlers.has(commandType)) {
      throw new Error(`Handler already registered for command type: ${commandType}`);
    }
    this.handlers.set(commandType, handler as CommandHandlerFn);
  }

  /**
   * Unregister a handler for a command type.
   */
  unregister(commandType: string): void {
    this.handlers.delete(commandType);
  }

  /**
   * Add middleware to the command pipeline.
   * Middleware runs in registration order (like Express).
   */
  use(middleware: CommandMiddlewareFn): void {
    this.middlewares.push(middleware);
  }

  /**
   * Dispatch a command through the middleware pipeline to its handler.
   */
  async dispatch<R = unknown>(command: Command): Promise<CommandResult<R>> {
    const handler = this.handlers.get(command.commandType);
    if (!handler) {
      return {
        success: false,
        error: new Error(`No handler registered for command type: ${command.commandType}`),
        events: [],
      };
    }

    // Compose middleware chain
    const execute = async (): Promise<CommandResult> => handler(command);

    let chain = execute;
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i];
      const next = chain;
      chain = () => mw(command, next);
    }

    return chain() as Promise<CommandResult<R>>;
  }

  /**
   * Check if a handler is registered for a command type.
   */
  hasHandler(commandType: string): boolean {
    return this.handlers.has(commandType);
  }

  /**
   * Get all registered command types.
   */
  getRegisteredTypes(): string[] {
    return [...this.handlers.keys()];
  }
}

let globalCommandBus: CommandBus | undefined;

export function getGlobalCommandBus(): CommandBus {
  if (!globalCommandBus) {
    globalCommandBus = new CommandBus();
  }
  return globalCommandBus;
}

// For testing
export function resetGlobalCommandBus(): void {
  globalCommandBus = undefined;
}
