const tableMetadata = new WeakMap<object, string>();

export function Table(name?: string) {
  return <T extends abstract new (...args: any[]) => any>(target: T, _context: ClassDecoratorContext<T>): T => {
    const tableName = name ?? target.name.toLowerCase();
    tableMetadata.set(target, tableName);
    return target;
  };
}

export function getTableName(target: object): string | undefined {
  return tableMetadata.get(target);
}
