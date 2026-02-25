import type { Repository } from "./repository.js";
import type { Page, Pageable } from "./paging.js";
import type { Specification } from "../query/specification.js";
import type { StreamOptions } from "./streaming.js";

export interface CrudRepository<T, ID> extends Repository<T, ID> {
  findAll(): Promise<T[]>;
  findAll(spec: Specification<T>): Promise<T[]>;
  findAll<P>(projectionClass: new (...args: any[]) => P): Promise<P[]>;
  findAllStream(options?: StreamOptions<T>): AsyncIterable<T>;
  findById(id: ID): Promise<T | null>;
  findById<P>(id: ID, projectionClass: new (...args: any[]) => P): Promise<P | null>;
  save(entity: T): Promise<T>;
  saveAll(entities: T[]): Promise<T[]>;
  delete(entity: T): Promise<void>;
  deleteAll(entities: T[]): Promise<void>;
  deleteById(id: ID): Promise<void>;
  count(): Promise<number>;
  count(spec: Specification<T>): Promise<number>;
}

export interface PagingAndSortingRepository<T, ID>
  extends CrudRepository<T, ID> {
  findAll(): Promise<T[]>;
  findAll(pageable: Pageable): Promise<Page<T>>;
}
