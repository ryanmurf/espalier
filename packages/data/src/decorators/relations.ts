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
