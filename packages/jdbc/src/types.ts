export type SqlValue = string | number | boolean | Date | Uint8Array | null;

export interface SqlParameter {
  index: number;
  value: SqlValue;
}

export interface ColumnMetadata {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
}
