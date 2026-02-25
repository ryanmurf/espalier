export interface TableInfo {
  tableName: string;
  schema: string;
}

export interface ColumnInfo {
  columnName: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  unique: boolean;
  maxLength: number | null;
}

export interface SchemaIntrospector {
  getTables(schema?: string): Promise<TableInfo[]>;
  getColumns(tableName: string, schema?: string): Promise<ColumnInfo[]>;
  getPrimaryKeys(tableName: string, schema?: string): Promise<string[]>;
  tableExists(tableName: string, schema?: string): Promise<boolean>;
}
