/**
 * @Audited class decorator — marks an entity for automatic change logging.
 *
 * When applied, all INSERT/UPDATE/DELETE operations on the entity will
 * generate audit log entries recording the changes made.
 *
 * Options:
 * - `fields`: If specified, only audit changes to these fields.
 *   If omitted, all fields are audited.
 */
export interface AuditedOptions {
  /** If specified, only audit changes to these fields. Otherwise audit all. */
  fields?: string[];
}

interface AuditedMetadataEntry {
  fields: string[] | undefined;
}

const auditedMetadata = new WeakMap<object, AuditedMetadataEntry>();

/**
 * @Audited class decorator — marks an entity for automatic change logging.
 *
 * When applied, INSERT, UPDATE, and DELETE operations on the entity
 * will produce audit entries stored in the `espalier_audit_log` table.
 *
 * @param options Optional configuration for audit scope.
 */
export function Audited(options?: AuditedOptions) {
  return <TClass extends new (...args: any[]) => any>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): TClass => {
    // Normalize: empty array → undefined (audit all), dedupe field names
    const rawFields = options?.fields;
    const fields = rawFields && rawFields.length > 0 ? [...new Set(rawFields)] : undefined;
    auditedMetadata.set(target, { fields });
    return target;
  };
}

/**
 * Returns audit metadata for an entity class, or undefined if not audited.
 */
export function getAuditedMetadata(target: object): AuditedMetadataEntry | undefined {
  const entry = auditedMetadata.get(target);
  return entry ? { fields: entry.fields ? [...entry.fields] : undefined } : undefined;
}

/**
 * Returns true if the entity class is decorated with @Audited.
 */
export function isAuditedEntity(target: object): boolean {
  return auditedMetadata.has(target);
}
