import type { Snapshot } from "./entity-snapshot.js";
import { snapshot } from "./entity-snapshot.js";

/**
 * Describes a single field that changed between two snapshots.
 */
export interface FieldDiff {
  readonly field: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

/**
 * The result of comparing two snapshots of the same entity.
 */
export interface DiffResult {
  readonly entityType: string;
  readonly entityId: unknown;
  readonly changes: readonly FieldDiff[];
  readonly snapshotA: Date;
  readonly snapshotB: Date;
}

function deepEqual(a: unknown, b: unknown, seen = new Set<object>()): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  // Date comparison
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();

  // Circular reference guard
  const objA = a as object;
  const objB = b as object;
  if (seen.has(objA)) return true; // treat circular as equal to prevent infinite loop
  seen.add(objA);

  // Array comparison
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], seen)) return false;
    }
    return true;
  }

  // Object comparison — handles undefined values correctly (unlike JSON.stringify)
  const keysA = Object.keys(objA as Record<string, unknown>);
  const keysB = Object.keys(objB as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!deepEqual((objA as any)[key], (objB as any)[key], seen)) return false;
  }
  return true;
}

/**
 * Computes the structured diff between two snapshots.
 * Both snapshots must be for the same entity type and ID.
 *
 * @param snapshot1 - The "before" snapshot
 * @param snapshot2 - The "after" snapshot
 * @returns A DiffResult containing only the fields that changed
 * @throws If the snapshots are for different entity types or IDs
 */
export function diff(snapshot1: Snapshot, snapshot2: Snapshot): DiffResult {
  if (snapshot1.entityType !== snapshot2.entityType) {
    throw new Error(
      `Cannot diff snapshots of different entity types: "${snapshot1.entityType}" vs "${snapshot2.entityType}".`,
    );
  }

  if (!deepEqual(snapshot1.entityId, snapshot2.entityId)) {
    throw new Error(
      `Cannot diff snapshots of different entity IDs: ${JSON.stringify(snapshot1.entityId)} vs ${JSON.stringify(snapshot2.entityId)}.`,
    );
  }

  const changes: FieldDiff[] = [];

  // Collect all field names from both snapshots
  const allFields = new Set<string>([
    ...Object.keys(snapshot1.fields),
    ...Object.keys(snapshot2.fields),
  ]);

  for (const field of allFields) {
    const oldValue = snapshot1.fields[field];
    const newValue = snapshot2.fields[field];
    if (!deepEqual(oldValue, newValue)) {
      changes.push({ field, oldValue, newValue });
    }
  }

  return Object.freeze({
    entityType: snapshot1.entityType,
    entityId: snapshot1.entityId,
    changes: Object.freeze(changes),
    snapshotA: snapshot1.timestamp,
    snapshotB: snapshot2.timestamp,
  });
}

/**
 * Diffs the current state of a live entity against a previous snapshot.
 * Internally takes a new snapshot of the entity, then diffs the two.
 *
 * @param entity - The current live entity
 * @param previousSnapshot - A snapshot taken at an earlier point in time
 * @returns A DiffResult containing only the fields that changed
 */
export function diffEntity<T extends object>(entity: T, previousSnapshot: Snapshot<T>): DiffResult {
  const currentSnapshot = snapshot(entity);
  return diff(previousSnapshot, currentSnapshot);
}
