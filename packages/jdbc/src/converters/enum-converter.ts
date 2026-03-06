import type { TypeConverter } from "../type-converter.js";

export class EnumConverter<T extends string> implements TypeConverter<T | null, string | null> {
  readonly name: string;
  readonly dbType = "varchar";
  private readonly allowedValues: Set<string>;

  constructor(name: string, allowedValues: T[]) {
    this.name = name;
    this.allowedValues = new Set(allowedValues);
  }

  toDatabaseValue(value: T | null): string | null {
    if (value == null) return null;
    if (!this.allowedValues.has(value)) {
      throw new Error(
        `Invalid enum value "${value}" for converter "${this.name}". ` +
          `Allowed values: ${[...this.allowedValues].join(", ")}`,
      );
    }
    return value;
  }

  fromDatabaseValue(value: string | null): T | null {
    if (value == null) return null;
    if (!this.allowedValues.has(value)) {
      throw new Error(
        `Invalid enum value "${value}" from database for converter "${this.name}". ` +
          `Allowed values: ${[...this.allowedValues].join(", ")}`,
      );
    }
    return value as T;
  }
}
