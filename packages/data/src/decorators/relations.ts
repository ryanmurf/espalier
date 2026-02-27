export interface ManyToOneOptions {
  target: () => new (...args: any[]) => any;
  joinColumn?: string;
  nullable?: boolean;
}

export interface ManyToOneRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  joinColumn: string;
  nullable: boolean;
}

const manyToOneMetadata = new WeakMap<object, Map<string | symbol, ManyToOneRelation>>();

export function ManyToOne(options: ManyToOneOptions) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const fieldName = context.name;
    const joinColumn = options.joinColumn ?? `${String(fieldName)}_id`;
    const nullable = options.nullable ?? true;

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
}

export interface OneToManyRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  mappedBy: string;
}

const oneToManyMetadata = new WeakMap<object, Map<string | symbol, OneToManyRelation>>();

export function OneToMany(options: OneToManyOptions) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const fieldName = context.name;

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!oneToManyMetadata.has(constructor)) {
        oneToManyMetadata.set(constructor, new Map());
      }
      oneToManyMetadata.get(constructor)!.set(fieldName, {
        fieldName,
        target: options.target,
        mappedBy: options.mappedBy,
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
}

export interface ManyToManyRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  joinTable?: JoinTableConfig;
  mappedBy?: string;
  isOwning: boolean;
}

const manyToManyMetadata = new WeakMap<object, Map<string | symbol, ManyToManyRelation>>();

export function ManyToMany(options: ManyToManyOptions) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const fieldName = context.name;
    const isOwning = options.joinTable !== undefined;

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
}

export interface OneToOneRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  joinColumn?: string;
  mappedBy?: string;
  nullable: boolean;
  isOwning: boolean;
  orphanRemoval: boolean;
}

const oneToOneMetadata = new WeakMap<object, Map<string | symbol, OneToOneRelation>>();

export function OneToOne(options: OneToOneOptions) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const fieldName = context.name;
    const isOwning = options.mappedBy === undefined;
    const joinColumn = isOwning
      ? (options.joinColumn ?? `${String(fieldName)}_id`)
      : undefined;
    const nullable = options.nullable ?? true;
    const orphanRemoval = options.orphanRemoval ?? false;

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
      });
    });
  };
}

export function getOneToOneRelations(target: object): OneToOneRelation[] {
  const map = oneToOneMetadata.get(target);
  if (!map) return [];
  return Array.from(map.values());
}
