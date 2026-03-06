/**
 * Utilities for accessing nested field values using dotted paths.
 * Used by row-mapper, change-tracker, and derived-repository to support
 * @Embedded fields whose fieldNames are like "address.street".
 */

/**
 * Reads a value from an entity using a potentially dotted field path.
 * For "address.street", reads entity.address.street.
 * For simple "name", reads entity.name.
 */
export function getFieldValue(entity: Record<string | symbol, unknown>, fieldName: string | symbol): unknown {
  if (typeof fieldName === "symbol") return entity[fieldName];
  if (!fieldName.includes(".")) return entity[fieldName];
  const parts = fieldName.split(".");
  let current: unknown = entity;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Sets a value on an entity using a potentially dotted field path.
 * For "address.street", sets entity.address.street = value,
 * creating intermediate objects as needed.
 * For simple "name", sets entity.name = value.
 */
export function setFieldValue(
  entity: Record<string | symbol, unknown>,
  fieldName: string | symbol,
  value: unknown,
): void {
  if (typeof fieldName === "symbol") {
    entity[fieldName] = value;
    return;
  }
  if (!fieldName.includes(".")) {
    entity[fieldName] = value;
    return;
  }
  const parts = fieldName.split(".");
  let current: Record<string, unknown> = entity as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === null || current[parts[i]] === undefined) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
