import { ResultSet, SqlValue } from 'espalier-jdbc';

declare function Table(name?: string): <T extends abstract new (...args: any[]) => any>(target: T, _context: ClassDecoratorContext<T>) => T;
declare function getTableName(target: object): string | undefined;

interface ColumnOptions {
    name?: string;
}
declare function Column(options?: ColumnOptions | string): <T>(_target: undefined, context: ClassFieldDecoratorContext<T>) => void;
declare function getColumnMappings(target: object): Map<string | symbol, string>;

declare function Id<T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void;
declare function getIdField(target: object): string | symbol | undefined;

declare function CreatedDate<T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void;
declare function LastModifiedDate<T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void;
declare function getCreatedDateField(target: object): string | symbol | undefined;
declare function getLastModifiedDateField(target: object): string | symbol | undefined;

interface Repository<T, ID> {
    findById(id: ID): Promise<T | null>;
    existsById(id: ID): Promise<boolean>;
}

interface Sort {
    property: string;
    direction: "ASC" | "DESC";
}
interface Pageable {
    page: number;
    size: number;
    sort?: Sort[];
}
interface Page<T> {
    content: T[];
    totalElements: number;
    totalPages: number;
    page: number;
    size: number;
    hasNext: boolean;
    hasPrevious: boolean;
}
declare function createPageable(page: number, size: number, sort?: Sort[]): Pageable;
declare function createPage<T>(content: T[], pageable: Pageable, totalElements: number): Page<T>;

interface CrudRepository<T, ID> extends Repository<T, ID> {
    findAll(): Promise<T[]>;
    save(entity: T): Promise<T>;
    delete(entity: T): Promise<void>;
    deleteById(id: ID): Promise<void>;
    count(): Promise<number>;
}
interface PagingAndSortingRepository<T, ID> extends CrudRepository<T, ID> {
    findAll(): Promise<T[]>;
    findAll(pageable: Pageable): Promise<Page<T>>;
}

interface FieldMapping {
    fieldName: string | symbol;
    columnName: string;
}
interface EntityMetadata {
    tableName: string;
    idField: string | symbol;
    fields: FieldMapping[];
    createdDateField?: string | symbol;
    lastModifiedDateField?: string | symbol;
}
declare function getEntityMetadata(entityClass: new (...args: any[]) => any): EntityMetadata;

interface RowMapper<T> {
    mapRow(resultSet: ResultSet): T;
}
declare function createRowMapper<T>(entityClass: new (...args: any[]) => T, metadata: EntityMetadata): RowMapper<T>;

type CriteriaType = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "in" | "between" | "isNull" | "isNotNull" | "and" | "or" | "not";
interface Criteria {
    readonly type: CriteriaType;
    toSql(paramOffset: number): {
        sql: string;
        params: SqlValue[];
    };
}
declare class ComparisonCriteria implements Criteria {
    readonly type: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like";
    readonly column: string;
    readonly value: SqlValue;
    constructor(type: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like", column: string, value: SqlValue);
    toSql(paramOffset: number): {
        sql: string;
        params: SqlValue[];
    };
}
declare class InCriteria implements Criteria {
    readonly column: string;
    readonly values: SqlValue[];
    readonly type: "in";
    constructor(column: string, values: SqlValue[]);
    toSql(paramOffset: number): {
        sql: string;
        params: SqlValue[];
    };
}
declare class BetweenCriteria implements Criteria {
    readonly column: string;
    readonly low: SqlValue;
    readonly high: SqlValue;
    readonly type: "between";
    constructor(column: string, low: SqlValue, high: SqlValue);
    toSql(paramOffset: number): {
        sql: string;
        params: SqlValue[];
    };
}
declare class NullCriteria implements Criteria {
    readonly type: "isNull" | "isNotNull";
    readonly column: string;
    constructor(type: "isNull" | "isNotNull", column: string);
    toSql(_paramOffset: number): {
        sql: string;
        params: SqlValue[];
    };
}
declare class LogicalCriteria implements Criteria {
    readonly type: "and" | "or";
    readonly left: Criteria;
    readonly right: Criteria;
    constructor(type: "and" | "or", left: Criteria, right: Criteria);
    toSql(paramOffset: number): {
        sql: string;
        params: SqlValue[];
    };
}
declare class NotCriteria implements Criteria {
    readonly criteria: Criteria;
    readonly type: "not";
    constructor(criteria: Criteria);
    toSql(paramOffset: number): {
        sql: string;
        params: SqlValue[];
    };
}
declare function and(left: Criteria, right: Criteria): Criteria;
declare function or(left: Criteria, right: Criteria): Criteria;
declare function not(criteria: Criteria): Criteria;

declare class ColumnRef {
    readonly name: string;
    constructor(name: string);
    eq(value: SqlValue): Criteria;
    neq(value: SqlValue): Criteria;
    gt(value: SqlValue): Criteria;
    gte(value: SqlValue): Criteria;
    lt(value: SqlValue): Criteria;
    lte(value: SqlValue): Criteria;
    like(pattern: string): Criteria;
    in(values: SqlValue[]): Criteria;
    between(low: SqlValue, high: SqlValue): Criteria;
    isNull(): Criteria;
    isNotNull(): Criteria;
}
declare function col(name: string): ColumnRef;

type JoinType = "INNER" | "LEFT" | "RIGHT";
type SortDirection = "ASC" | "DESC";
interface BuiltQuery {
    sql: string;
    params: SqlValue[];
}
declare class SelectBuilder {
    private _columns;
    private _from;
    private _joins;
    private _where;
    private _orderBy;
    private _groupBy;
    private _having;
    private _limit;
    private _offset;
    constructor(from: string);
    columns(...columns: string[]): SelectBuilder;
    where(criteria: Criteria): SelectBuilder;
    and(criteria: Criteria): SelectBuilder;
    or(criteria: Criteria): SelectBuilder;
    join(type: JoinType, table: string, on: string): SelectBuilder;
    orderBy(column: string, direction?: SortDirection): SelectBuilder;
    groupBy(...columns: string[]): SelectBuilder;
    having(criteria: Criteria): SelectBuilder;
    limit(n: number): SelectBuilder;
    offset(n: number): SelectBuilder;
    build(): BuiltQuery;
}
declare class InsertBuilder {
    private _table;
    private _columns;
    private _values;
    private _returning;
    constructor(table: string);
    set(column: string, value: SqlValue): InsertBuilder;
    values(record: Record<string, SqlValue>): InsertBuilder;
    returning(...columns: string[]): InsertBuilder;
    build(): BuiltQuery;
}
declare class UpdateBuilder {
    private _table;
    private _sets;
    private _where;
    private _returning;
    constructor(table: string);
    set(column: string, value: SqlValue): UpdateBuilder;
    values(record: Record<string, SqlValue>): UpdateBuilder;
    where(criteria: Criteria): UpdateBuilder;
    and(criteria: Criteria): UpdateBuilder;
    returning(...columns: string[]): UpdateBuilder;
    build(): BuiltQuery;
}
declare class DeleteBuilder {
    private _table;
    private _where;
    private _returning;
    constructor(table: string);
    where(criteria: Criteria): DeleteBuilder;
    and(criteria: Criteria): DeleteBuilder;
    returning(...columns: string[]): DeleteBuilder;
    build(): BuiltQuery;
}
declare const QueryBuilder: {
    select(entityOrTable: (new (...args: any[]) => any) | string): SelectBuilder;
    insert(entityOrTable: (new (...args: any[]) => any) | string): InsertBuilder;
    update(entityOrTable: (new (...args: any[]) => any) | string): UpdateBuilder;
    delete(entityOrTable: (new (...args: any[]) => any) | string): DeleteBuilder;
};

export { BetweenCriteria, type BuiltQuery, Column, type ColumnOptions, ColumnRef, ComparisonCriteria, CreatedDate, type Criteria, type CriteriaType, type CrudRepository, DeleteBuilder, type EntityMetadata, type FieldMapping, Id, InCriteria, InsertBuilder, type JoinType, LastModifiedDate, LogicalCriteria, NotCriteria, NullCriteria, type Page, type Pageable, type PagingAndSortingRepository, QueryBuilder, type Repository, type RowMapper, SelectBuilder, type Sort, type SortDirection, Table, UpdateBuilder, and, col, createPage, createPageable, createRowMapper, getColumnMappings, getCreatedDateField, getEntityMetadata, getIdField, getLastModifiedDateField, getTableName, not, or };
