import type { EntityMetadata, FieldMapping } from "./entity-metadata.js";
import { getGlobalLogger, LogLevel } from "espalier-jdbc";
import { getFieldValue } from "./field-access.js";
import { getIdField } from "../decorators/id.js";
import type { Snapshot } from "../snapshot/entity-snapshot.js";
import type { DiffResult } from "../snapshot/entity-diff.js";
import { snapshot as createSnapshot } from "../snapshot/entity-snapshot.js";
import { diff as diffSnapshots } from "../snapshot/entity-diff.js";

export interface FieldChange {
  field: string | symbol;
  columnName: string;
  oldValue: unknown;
  newValue: unknown;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Handle NaN === NaN (which is false with ===)
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || !deepEqual(val, b.get(key))) return false;
    }
    return true;
  }

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const val of a) {
      if (!b.has(val)) return false;
    }
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const keysA = Reflect.ownKeys(a as object);
    const keysB = Reflect.ownKeys(b as object);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!deepEqual((a as Record<string | symbol, unknown>)[key], (b as Record<string | symbol, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function cloneDeep(value: unknown, seen: Map<object, object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  const obj = value as object;
  if (seen.has(obj)) return seen.get(obj)!;

  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(obj, clone);
    for (const [k, v] of value) {
      clone.set(cloneDeep(k, seen), cloneDeep(v, seen));
    }
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(obj, clone);
    for (const v of value) {
      clone.add(cloneDeep(v, seen));
    }
    return clone;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(obj, clone);
    for (const item of value) {
      clone.push(cloneDeep(item, seen));
    }
    return clone;
  }

  const clone: Record<string | symbol, unknown> = {};
  seen.set(obj, clone);
  for (const key of Reflect.ownKeys(value as Record<string | symbol, unknown>)) {
    clone[key] = cloneDeep((value as Record<string | symbol, unknown>)[key], seen);
  }
  return clone;
}

function cloneValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  return cloneDeep(value, new Map());
}

export class EntityChangeTracker<T> {
  private readonly snapshots = new WeakMap<object, Record<string | symbol, unknown>>();
  private readonly _entitySnapshots = new WeakMap<object, Snapshot>();
  private readonly metadata: EntityMetadata;

  constructor(metadata: EntityMetadata) {
    this.metadata = metadata;
  }

  /** Extract FK value (related entity's ID) for an owning @OneToOne relation. */
  private getRelationFkValue(entity: T, relation: { fieldName: string | symbol; target: () => new (...args: any[]) => any; joinColumn?: string; isOwning: boolean }): unknown {
    if (!relation.isOwning || !relation.joinColumn) return undefined;
    const related = (entity as Record<string | symbol, unknown>)[relation.fieldName];
    if (related == null) return null;
    const targetClass = relation.target();
    const targetIdField = getIdField(targetClass);
    if (!targetIdField) return undefined;
    return (related as Record<string | symbol, unknown>)[targetIdField];
  }

  /** Synthetic snapshot key for a relation FK. */
  private relationFkKey(relation: { joinColumn?: string }): string {
    return `__fk__${relation.joinColumn}`;
  }

  snapshot(entity: T): void {
    const snap: Record<string | symbol, unknown> = {};
    for (const field of this.metadata.fields) {
      snap[field.fieldName] = cloneValue(
        getFieldValue(entity as Record<string | symbol, unknown>, field.fieldName),
      );
    }
    // Snapshot FK values for owning @OneToOne relations
    for (const relation of this.metadata.oneToOneRelations) {
      if (!relation.isOwning || !relation.joinColumn) continue;
      const fkKey = this.relationFkKey(relation);
      snap[fkKey] = this.getRelationFkValue(entity, relation);
    }
    // Snapshot FK values for @ManyToOne relations
    for (const relation of this.metadata.manyToOneRelations) {
      const fkKey = `__fk__${relation.joinColumn}`;
      const related = (entity as Record<string | symbol, unknown>)[relation.fieldName];
      if (related == null) {
        snap[fkKey] = null;
      } else {
        const targetClass = relation.target();
        const targetIdField = getIdField(targetClass);
        if (targetIdField) {
          snap[fkKey] = (related as Record<string | symbol, unknown>)[targetIdField];
        }
      }
    }
    this.snapshots.set(entity as object, snap);
  }

  isDirty(entity: T): boolean {
    const snap = this.snapshots.get(entity as object);
    if (!snap) return true; // No snapshot means we don't know — treat as dirty
    for (const field of this.metadata.fields) {
      const current = getFieldValue(entity as Record<string | symbol, unknown>, field.fieldName);
      if (!deepEqual(current, snap[field.fieldName])) {
        return true;
      }
    }
    // Check owning @OneToOne FK changes
    for (const relation of this.metadata.oneToOneRelations) {
      if (!relation.isOwning || !relation.joinColumn) continue;
      const fkKey = this.relationFkKey(relation);
      const currentFk = this.getRelationFkValue(entity, relation);
      if (!deepEqual(currentFk, snap[fkKey])) {
        return true;
      }
    }
    // Check @ManyToOne FK changes
    for (const relation of this.metadata.manyToOneRelations) {
      const fkKey = `__fk__${relation.joinColumn}`;
      const related = (entity as Record<string | symbol, unknown>)[relation.fieldName];
      let currentFk: unknown = null;
      if (related != null) {
        const targetClass = relation.target();
        const targetIdField = getIdField(targetClass);
        if (targetIdField) {
          currentFk = (related as Record<string | symbol, unknown>)[targetIdField];
        }
      }
      if (!deepEqual(currentFk, snap[fkKey])) {
        return true;
      }
    }
    return false;
  }

  getDirtyFields(entity: T): FieldChange[] {
    const snap = this.snapshots.get(entity as object);
    if (!snap) return []; // No snapshot — can't determine dirty fields
    const changes: FieldChange[] = [];
    for (const field of this.metadata.fields) {
      const current = getFieldValue(entity as Record<string | symbol, unknown>, field.fieldName);
      const old = snap[field.fieldName];
      if (!deepEqual(current, old)) {
        changes.push({
          field: field.fieldName,
          columnName: field.columnName,
          oldValue: old,
          newValue: current,
        });
      }
    }
    // Check owning @OneToOne FK changes
    for (const relation of this.metadata.oneToOneRelations) {
      if (!relation.isOwning || !relation.joinColumn) continue;
      const fkKey = this.relationFkKey(relation);
      const currentFk = this.getRelationFkValue(entity, relation);
      const oldFk = snap[fkKey];
      if (!deepEqual(currentFk, oldFk)) {
        changes.push({
          field: relation.fieldName,
          columnName: relation.joinColumn,
          oldValue: oldFk,
          newValue: currentFk,
        });
      }
    }
    // Check @ManyToOne FK changes
    for (const relation of this.metadata.manyToOneRelations) {
      const fkKey = `__fk__${relation.joinColumn}`;
      const related = (entity as Record<string | symbol, unknown>)[relation.fieldName];
      let currentFk: unknown = null;
      if (related != null) {
        const targetClass = relation.target();
        const targetIdField = getIdField(targetClass);
        if (targetIdField) {
          currentFk = (related as Record<string | symbol, unknown>)[targetIdField];
        }
      }
      const oldFk = snap[fkKey];
      if (!deepEqual(currentFk, oldFk)) {
        changes.push({
          field: relation.fieldName,
          columnName: relation.joinColumn,
          oldValue: oldFk,
          newValue: currentFk,
        });
      }
    }
    const logger = getGlobalLogger().child("change-tracker");
    if (changes.length > 0 && logger.isEnabled(LogLevel.TRACE)) {
      logger.trace("dirty fields detected", {
        entityType: this.metadata.tableName,
        dirtyFieldCount: changes.length,
        fields: changes.map((c) => String(c.field)),
      });
    }
    return changes;
  }

  getSnapshot(entity: T): Record<string | symbol, unknown> | undefined {
    return this.snapshots.get(entity as object);
  }

  /**
   * Returns an immutable Snapshot of the entity's current @Column fields.
   * Returns undefined if the entity class lacks @Table or @Id decorators.
   */
  getEntitySnapshot(entity: T): Snapshot<T> | undefined {
    try {
      return createSnapshot(entity as object) as Snapshot<T>;
    } catch {
      return undefined;
    }
  }

  /**
   * Diffs the entity's current state against the last entity snapshot taken
   * via `getEntitySnapshot`. Returns undefined if no previous snapshot exists.
   */
  diffFromSnapshot(entity: T): DiffResult | undefined {
    const previous = this._entitySnapshots.get(entity as object) as Snapshot<T> | undefined;
    if (!previous) return undefined;
    try {
      const current = createSnapshot(entity as object) as Snapshot<T>;
      return diffSnapshots(previous, current);
    } catch {
      return undefined;
    }
  }

  /**
   * Takes and stores an entity snapshot for later diffing via `diffFromSnapshot`.
   */
  takeEntitySnapshot(entity: T): Snapshot<T> | undefined {
    try {
      const snap = createSnapshot(entity as object) as Snapshot<T>;
      this._entitySnapshots.set(entity as object, snap);
      return snap;
    } catch {
      return undefined;
    }
  }

  clearSnapshot(entity: T): void {
    this.snapshots.delete(entity as object);
  }

  clearAll(): void {
    // WeakMap doesn't have a clear() method, but since it uses weak references
    // entries will be GC'd when entities are no longer referenced.
    // For explicit clearing, we replace the internal reference.
    // However, WeakMap has no iteration. Just document that clearAll is a no-op
    // since WeakMap auto-clears on GC. For test purposes, we keep this method.
  }
}
