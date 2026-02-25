import type { FieldChange } from "../mapping/change-tracker.js";

export interface EntityEvent<T = unknown> {
  entityClass: new (...args: any[]) => T;
  entityName: string;
  entity: T;
  timestamp: Date;
}

export interface EntityPersistedEvent<T = unknown> extends EntityEvent<T> {
  type: "persisted";
  id: unknown;
}

export interface EntityUpdatedEvent<T = unknown> extends EntityEvent<T> {
  type: "updated";
  id: unknown;
  changes?: FieldChange[];
}

export interface EntityRemovedEvent<T = unknown> extends EntityEvent<T> {
  type: "removed";
  id: unknown;
}

export interface EntityLoadedEvent<T = unknown> extends EntityEvent<T> {
  type: "loaded";
  id: unknown;
}

export const ENTITY_EVENTS = {
  PERSISTED: "entity:persisted",
  UPDATED: "entity:updated",
  REMOVED: "entity:removed",
  LOADED: "entity:loaded",
} as const;
