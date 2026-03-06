export type FetchType = "JOIN" | "SUBSELECT" | "BATCH" | "SELECT";

export interface FetchOptions {
  strategy: FetchType;
  batchSize?: number;
}

function parseFetch(fetch?: FetchType | FetchOptions): { fetchStrategy: FetchType; batchSize: number } {
  if (!fetch) return { fetchStrategy: "SELECT", batchSize: 25 };
  if (typeof fetch === "string") return { fetchStrategy: fetch, batchSize: 25 };
  return { fetchStrategy: fetch.strategy, batchSize: fetch.batchSize ?? 25 };
}

export type CascadeType = "persist" | "merge" | "remove" | "refresh" | "all";

const ALL_CASCADE_TYPES: ReadonlySet<CascadeType> = new Set(["persist", "merge", "remove", "refresh"]);

function parseCascade(cascade?: CascadeType | CascadeType[]): Set<CascadeType> {
  if (!cascade) return new Set();
  const types = Array.isArray(cascade) ? cascade : [cascade];
  const result = new Set<CascadeType>();
  for (const t of types) {
    if (t === "all") {
      for (const ct of ALL_CASCADE_TYPES) result.add(ct);
    } else {
      result.add(t);
    }
  }
  return result;
}

export interface ManyToOneOptions {
  target: () => new (...args: any[]) => any;
  joinColumn?: string;
  nullable?: boolean;
  fetch?: FetchType | FetchOptions;
  lazy?: boolean;
  cascade?: CascadeType | CascadeType[];
}

export interface ManyToOneRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  joinColumn: string;
  nullable: boolean;
  fetchStrategy: FetchType;
  batchSize: number;
  lazy: boolean;
  cascade: Set<CascadeType>;
}

const manyToOneMetadata = new WeakMap<object, Map<string | symbol, ManyToOneRelation>>();

export function ManyToOne(options: ManyToOneOptions) {
  return <T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void => {
    const fieldName = context.name;
    const joinColumn = options.joinColumn ?? `${String(fieldName)}_id`;
    const nullable = options.nullable ?? true;
    const { fetchStrategy, batchSize } = parseFetch(options.fetch);
    const lazy = options.lazy ?? false;
    const cascade = parseCascade(options.cascade);

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!manyToOneMetadata.has(constructor)) {
        manyToOneMetadata.set(constructor, new Map());
      }
      manyToOneMetadata.get(constructor)!.set(fieldName, {
        fieldName,
        target: options.target,
        joinColumn,
        nullable,
        fetchStrategy,
        batchSize,
        lazy,
        cascade,
      });
    });
  };
}

export function getManyToOneRelations(target: object): ManyToOneRelation[] {
  const map = manyToOneMetadata.get(target);
  if (!map) return [];
  return Array.from(map.values());
}

export interface OneToManyOptions {
  target: () => new (...args: any[]) => any;
  mappedBy: string;
  fetch?: FetchType | FetchOptions;
  lazy?: boolean;
  cascade?: CascadeType | CascadeType[];
}

export interface OneToManyRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  mappedBy: string;
  fetchStrategy: FetchType;
  batchSize: number;
  lazy: boolean;
  cascade: Set<CascadeType>;
}

const oneToManyMetadata = new WeakMap<object, Map<string | symbol, OneToManyRelation>>();

export function OneToMany(options: OneToManyOptions) {
  return <T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void => {
    const fieldName = context.name;
    const { fetchStrategy, batchSize } = parseFetch(options.fetch);
    const lazy = options.lazy ?? false;
    const cascade = parseCascade(options.cascade);

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!oneToManyMetadata.has(constructor)) {
        oneToManyMetadata.set(constructor, new Map());
      }
      oneToManyMetadata.get(constructor)!.set(fieldName, {
        fieldName,
        target: options.target,
        mappedBy: options.mappedBy,
        fetchStrategy,
        batchSize,
        lazy,
        cascade,
      });
    });
  };
}

export function getOneToManyRelations(target: object): OneToManyRelation[] {
  const map = oneToManyMetadata.get(target);
  if (!map) return [];
  return Array.from(map.values());
}

export interface JoinTableConfig {
  name: string;
  joinColumn: string;
  inverseJoinColumn: string;
}

export interface ManyToManyOptions {
  target: () => new (...args: any[]) => any;
  joinTable?: JoinTableConfig;
  mappedBy?: string;
  fetch?: FetchType | FetchOptions;
  lazy?: boolean;
  cascade?: CascadeType | CascadeType[];
}

export interface ManyToManyRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  joinTable?: JoinTableConfig;
  mappedBy?: string;
  isOwning: boolean;
  fetchStrategy: FetchType;
  batchSize: number;
  lazy: boolean;
  cascade: Set<CascadeType>;
}

const manyToManyMetadata = new WeakMap<object, Map<string | symbol, ManyToManyRelation>>();

export function ManyToMany(options: ManyToManyOptions) {
  return <T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void => {
    const fieldName = context.name;
    const isOwning = options.joinTable !== undefined;
    const { fetchStrategy, batchSize } = parseFetch(options.fetch);
    const lazy = options.lazy ?? false;
    const cascade = parseCascade(options.cascade);

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!manyToManyMetadata.has(constructor)) {
        manyToManyMetadata.set(constructor, new Map());
      }
      manyToManyMetadata.get(constructor)!.set(fieldName, {
        fieldName,
        target: options.target,
        joinTable: options.joinTable,
        mappedBy: options.mappedBy,
        isOwning,
        fetchStrategy,
        batchSize,
        lazy,
        cascade,
      });
    });
  };
}

export function getManyToManyRelations(target: object): ManyToManyRelation[] {
  const map = manyToManyMetadata.get(target);
  if (!map) return [];
  return Array.from(map.values());
}

export interface OneToOneOptions {
  target: () => new (...args: any[]) => any;
  joinColumn?: string;
  mappedBy?: string;
  nullable?: boolean;
  orphanRemoval?: boolean;
  fetch?: FetchType | FetchOptions;
  lazy?: boolean;
  cascade?: CascadeType | CascadeType[];
}

export interface OneToOneRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  joinColumn?: string;
  mappedBy?: string;
  nullable: boolean;
  isOwning: boolean;
  orphanRemoval: boolean;
  fetchStrategy: FetchType;
  batchSize: number;
  lazy: boolean;
  cascade: Set<CascadeType>;
}

const oneToOneMetadata = new WeakMap<object, Map<string | symbol, OneToOneRelation>>();

export function OneToOne(options: OneToOneOptions) {
  return <T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void => {
    const fieldName = context.name;
    const isOwning = options.mappedBy === undefined;
    const joinColumn = isOwning ? (options.joinColumn ?? `${String(fieldName)}_id`) : undefined;
    const nullable = options.nullable ?? true;
    const orphanRemoval = options.orphanRemoval ?? false;
    const { fetchStrategy, batchSize } = parseFetch(options.fetch);
    const lazy = options.lazy ?? false;
    const cascade = parseCascade(options.cascade);

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!oneToOneMetadata.has(constructor)) {
        oneToOneMetadata.set(constructor, new Map());
      }
      oneToOneMetadata.get(constructor)!.set(fieldName, {
        fieldName,
        target: options.target,
        joinColumn,
        mappedBy: options.mappedBy,
        nullable,
        isOwning,
        orphanRemoval,
        fetchStrategy,
        batchSize,
        lazy,
        cascade,
      });
    });
  };
}

export function getOneToOneRelations(target: object): OneToOneRelation[] {
  const map = oneToOneMetadata.get(target);
  if (!map) return [];
  return Array.from(map.values());
}
