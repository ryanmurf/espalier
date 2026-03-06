/**
 * @EventHandler -- TC39 standard method decorator.
 * Marks a method as the handler for a specific domain event type.
 * Used by AggregateBase.applyEvent to dispatch events automatically.
 *
 * Handlers are registered per-class, not per-instance. A WeakMap guard
 * ensures that subsequent instance constructions do not re-register
 * already-known (class, eventType) pairs.
 */

import type { DomainEvent } from "../types.js";

const eventHandlerMetadata = new WeakMap<object, Map<string, string | symbol>>();

/**
 * Track which (class, eventType) pairs have already been registered so that
 * subsequent instance constructions do not overwrite mappings.
 */
const registeredPairs = new WeakMap<object, Set<string>>();

export function EventHandler(eventType: string) {
  return <This>(_target: (this: This, event: DomainEvent) => void, context: DecoratorContext) => {
    context.addInitializer(function (this: any) {
      const ctor = this.constructor;

      // Skip if this (class, eventType) pair was already registered
      let pairs = registeredPairs.get(ctor);
      if (pairs?.has(eventType)) return;
      if (!pairs) {
        pairs = new Set();
        registeredPairs.set(ctor, pairs);
      }
      pairs.add(eventType);

      let handlers = eventHandlerMetadata.get(ctor);
      if (!handlers) {
        handlers = new Map();
        eventHandlerMetadata.set(ctor, handlers);
      }
      handlers.set(eventType, context.name as string | symbol);
    });
  };
}

export function getEventHandlers(target: object): Map<string, string | symbol> {
  return new Map(eventHandlerMetadata.get(target) ?? []);
}
