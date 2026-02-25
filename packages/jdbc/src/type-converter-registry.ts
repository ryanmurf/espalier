import type { TypeConverter, TypeConverterRegistry } from "./type-converter.js";

export class DefaultTypeConverterRegistry implements TypeConverterRegistry {
  private readonly byName = new Map<string, TypeConverter>();
  private readonly byDbType = new Map<string, TypeConverter>();

  register(converter: TypeConverter): void {
    this.byName.set(converter.name, converter);
    this.byDbType.set(converter.dbType, converter);
  }

  get(name: string): TypeConverter | undefined {
    return this.byName.get(name);
  }

  getForDbType(dbType: string): TypeConverter | undefined {
    return this.byDbType.get(dbType);
  }

  getAll(): TypeConverter[] {
    return [...this.byName.values()];
  }
}
