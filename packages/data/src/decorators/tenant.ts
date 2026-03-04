const tenantIdMetadata = new WeakMap<object, string | symbol>();

/**
 * Marks a field as the tenant discriminator column for shared-table multi-tenancy.
 * The field will be automatically set from TenantContext on INSERT and used to filter
 * all queries (SELECT, UPDATE, DELETE) by the current tenant.
 */
export function TenantId<T>(
  _target: undefined,
  context: ClassFieldDecoratorContext<T>,
): void {
  context.addInitializer(function (this: T) {
    const constructor = (this as object).constructor;
    tenantIdMetadata.set(constructor, context.name);
  });
}

/**
 * Returns the field name marked with @TenantId, or undefined if none.
 */
export function getTenantIdField(target: object): string | symbol | undefined {
  return tenantIdMetadata.get(target);
}
