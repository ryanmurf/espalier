// TC39 standard class decorator
// Marks a class as a command handler
// Auto-registers with the global command bus

import type { Command, CommandResult } from "../types.js";
import { getGlobalCommandBus } from "./command-bus.js";

export interface CommandHandlerOptions {
  commandType: string;
}

const commandHandlerMetadata = new WeakMap<object, CommandHandlerOptions>();

/**
 * @CommandHandler decorator — marks a class as handling a specific command type.
 * The class must have an `execute(command)` method.
 */
export function CommandHandler(options: CommandHandlerOptions) {
  return function<T extends new (...args: any[]) => any>(
    target: T,
    context: ClassDecoratorContext,
  ): T {
    commandHandlerMetadata.set(target, options);

    context.addInitializer(function(this: any) {
      // Auto-register with global command bus
      const instance = new target();
      if (typeof (instance as any).execute !== "function") {
        throw new Error(
          `@CommandHandler class ${target.name} must implement execute(command: Command): Promise<CommandResult>`
        );
      }
      getGlobalCommandBus().register(
        options.commandType,
        (cmd: Command) => (instance as any).execute(cmd),
      );
    });

    return target;
  };
}

export function getCommandHandlerMetadata(target: object): CommandHandlerOptions | undefined {
  return commandHandlerMetadata.get(target);
}

export function isCommandHandler(target: object): boolean {
  return commandHandlerMetadata.has(target);
}
