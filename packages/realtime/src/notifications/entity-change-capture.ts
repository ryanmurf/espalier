import { getTableName } from "espalier-data";
import { quoteIdentifier, validateIdentifier } from "espalier-jdbc";

/**
 * Generates PostgreSQL trigger functions and triggers that emit NOTIFY events
 * on INSERT, UPDATE, and DELETE for a given entity class.
 */
export class EntityChangeCapture {
  /**
   * Generate DDL (CREATE FUNCTION + CREATE TRIGGER) for an entity class
   * that sends NOTIFY on every INSERT, UPDATE, or DELETE.
   *
   * The notification payload is a JSON object with:
   * - `operation`: "INSERT" | "UPDATE" | "DELETE"
   * - `table`: the table name
   * - `row`: the NEW row (for INSERT/UPDATE) or OLD row (for DELETE), cast to JSON
   *
   * @param entityClass The decorated entity class (must have @Table)
   * @param channel The NOTIFY channel name
   * @returns DDL string to execute
   */
  generateTriggerDdl(entityClass: new (...args: unknown[]) => unknown, channel: string): string {
    const tableName = getTableName(entityClass);
    if (!tableName) {
      throw new Error(
        `Entity class "${entityClass.name}" does not have a @Table decorator. ` +
          "Cannot generate change capture trigger.",
      );
    }

    validateIdentifier(tableName, "table name");
    validateIdentifier(channel, "channel name");

    const functionName = `espalier_notify_${tableName}_${channel}`;
    validateIdentifier(functionName, "trigger function name");

    const triggerName = `espalier_trigger_${tableName}_${channel}`;
    validateIdentifier(triggerName, "trigger name");

    const quotedTable = quoteIdentifier(tableName);
    const quotedFunction = quoteIdentifier(functionName);
    const quotedTrigger = quoteIdentifier(triggerName);

    return `-- Change capture function for ${tableName} -> ${channel}
CREATE OR REPLACE FUNCTION ${quotedFunction}() RETURNS trigger AS $$
DECLARE
  payload JSON;
  row_data JSON;
  operation TEXT;
BEGIN
  operation := TG_OP;

  IF (TG_OP = 'DELETE') THEN
    row_data := row_to_json(OLD);
  ELSE
    row_data := row_to_json(NEW);
  END IF;

  payload := json_build_object(
    'operation', operation,
    'table', TG_TABLE_NAME,
    'row', row_data
  );

  PERFORM pg_notify('${channel.replace(/'/g, "''")}', payload::TEXT);

  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER ${quotedTrigger}
  AFTER INSERT OR UPDATE OR DELETE ON ${quotedTable}
  FOR EACH ROW EXECUTE FUNCTION ${quotedFunction}();`;
  }
}
