import type { TypeConverter } from "../type-converter.js";

export class JsonConverter implements TypeConverter<object | null, string | null> {
  readonly name: string = "json";
  readonly dbType: string = "json";

  toDatabaseValue(value: object | null): string | null {
    if (value == null) return null;
    return JSON.stringify(value);
  }

  fromDatabaseValue(value: string | null): object | null {
    if (value == null) return null;
    if (typeof value === "object") return value;
    return JSON.parse(value) as object;
  }
}

export class JsonbConverter extends JsonConverter {
  override readonly name = "jsonb";
  override readonly dbType = "jsonb";
}
