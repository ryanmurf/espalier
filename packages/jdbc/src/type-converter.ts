export interface TypeConverter<TApp = unknown, TDb = unknown> {
  /** Name identifying this converter (e.g., "json", "enum:status") */
  readonly name: string;
  /** Convert application value to database value for binding */
  toDatabaseValue(value: TApp): TDb;
  /** Convert database value to application value after reading */
  fromDatabaseValue(value: TDb): TApp;
  /** The SQL/database type this converter handles (e.g., "jsonb", "varchar") */
  readonly dbType: string;
}

export interface TypeConverterRegistry {
  register(converter: TypeConverter): void;
  get(name: string): TypeConverter | undefined;
  getForDbType(dbType: string): TypeConverter | undefined;
  getAll(): TypeConverter[];
}
