/**
 * @EventHandler — TC39 standard method decorator.
 * Marks a method as the handler for a specific domain event type.
 * Used by AggregateBase.applyEvent to dispatch events automatically.
 */

import type { DomainEvent } from "../types.js";

const eventHandlerMetadata = new WeakMap<object, Map<string, string | symbol>>();

export function EventHandler(eventType: string) {
  return function <This>(
    _target: (this: This, event: DomainEvent) => void,
    context: DecoratorContext,
  ) {
    context.addInitializer(function (this: any) {
      const constructor = this.constructor;
      let handlers = eventHandlerMetadata.get(constructor);
      if (!handlers) {
        handlers = new Map();
        eventHandlerMetadata.set(constructor, handlers);
      }
      handlers.set(eventType, context.name as string | symbol);
    });
  };
}

export function getEventHandlers(
  target: object,
): Map<string, string | symbol> {
  return new Map(eventHandlerMetadata.get(target) ?? []);
}
