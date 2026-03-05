import { getTableName } from "espalier-data";
import { EntityChangeCapture } from "./notifications/entity-change-capture.js";

/**
 * Generate all LISTEN/NOTIFY trigger DDL for a set of entity classes.
 *
 * Each entity gets a trigger that notifies on the channel `<tableName>_changes`.
 *
 * @param entityClasses Array of entity classes decorated with @Table
 * @returns Combined DDL string for all triggers
 */
export function generateRealtimeDdl(
  entityClasses: Array<new (...args: unknown[]) => unknown>,
): string {
  const capture = new EntityChangeCapture();
  const statements: string[] = [];

  for (const entityClass of entityClasses) {
    const tableName = getTableName(entityClass);
    if (!tableName) {
      throw new Error(
        `Entity class "${entityClass.name}" does not have a @Table decorator. ` +
          "Cannot generate realtime DDL.",
      );
    }
    const channel = `${tableName}_changes`;
    statements.push(capture.generateTriggerDdl(entityClass, channel));
  }

  return statements.join("\n\n");
}
