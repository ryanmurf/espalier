import type { TypeConverter } from "../type-converter.js";

export class DateConverter implements TypeConverter<Date | null, string | null> {
  readonly name = "date";
  readonly dbType = "text";

  toDatabaseValue(value: Date | null): string | null {
    if (value == null) return null;
    return value.toISOString();
  }

  fromDatabaseValue(value: string | null): Date | null {
    if (value == null) return null;
    return new Date(value);
  }
}
