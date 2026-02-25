import type { Repository } from "./repository.js";
import type { Page, Pageable } from "./paging.js";
import type { Specification } from "../query/specification.js";

export interface CrudRepository<T, ID> extends Repository<T, ID> {
  findAll(): Promise<T[]>;
  findAll(spec: Specification<T>): Promise<T[]>;
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
