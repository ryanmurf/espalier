export interface RepositoryOptions {
  entity: new (...args: any[]) => any;
  tableName?: string;
}

const repositoryMetadata = new WeakMap<object, RepositoryOptions>();
const registeredRepositories = new Map<new (...args: any[]) => any, new (...args: any[]) => any>();

export function Repository(options: RepositoryOptions) {
  return <T extends abstract new (...args: any[]) => any>(target: T, _context: ClassDecoratorContext<T>): T => {
    repositoryMetadata.set(target, options);
    registeredRepositories.set(options.entity, target as unknown as new (...args: any[]) => any);
    return target;
  };
}

export function getRepositoryMetadata(target: object): RepositoryOptions | undefined {
  return repositoryMetadata.get(target);
}

export function getRegisteredRepositories(): Map<new (...args: any[]) => any, new (...args: any[]) => any> {
  return new Map(registeredRepositories);
}
