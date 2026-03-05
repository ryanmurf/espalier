export interface SchemaColumn {
  fieldName: string;
  columnName: string;
  type?: string;
  nullable?: boolean;
  unique?: boolean;
  defaultValue?: string;
  length?: number;
  isPrimaryKey: boolean;
  isVersion: boolean;
  isCreatedDate: boolean;
  isLastModifiedDate: boolean;
  isTenantId: boolean;
}

export type RelationType = "ManyToOne" | "OneToMany" | "ManyToMany" | "OneToOne";

export interface SchemaRelation {
  type: RelationType;
  fieldName: string;
  sourceTable: string;
  targetTable: string;
  joinColumn?: string;
  mappedBy?: string;
  nullable?: boolean;
  isOwning: boolean;
  joinTable?: {
    name: string;
    joinColumn: string;
    inverseJoinColumn: string;
  };
}

export interface SchemaTable {
  className: string;
  tableName: string;
  columns: SchemaColumn[];
  relations: SchemaRelation[];
  isSoftDelete?: boolean;
  isAudited?: boolean;
  softDeleteColumn?: string;
}

export interface SchemaModel {
  tables: SchemaTable[];
  relations: SchemaRelation[];
}
