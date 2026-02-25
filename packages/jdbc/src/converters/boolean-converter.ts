import type { TypeConverter } from "../type-converter.js";

export class BooleanConverter implements TypeConverter<boolean | null, number | null> {
  readonly name = "boolean";
  readonly dbType = "integer";

  toDatabaseValue(value: boolean | null): number | null {
    if (value == null) return null;
    return value ? 1 : 0;
  }

  fromDatabaseValue(value: number | null): boolean | null {
    if (value == null) return null;
    return value !== 0;
  }
}
