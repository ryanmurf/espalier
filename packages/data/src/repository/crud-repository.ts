import type { Repository } from "./repository.js";
import type { Page, Pageable } from "./paging.js";

export interface CrudRepository<T, ID> extends Repository<T, ID> {
  findAll(): Promise<T[]>;
  save(entity: T): Promise<T>;
  delete(entity: T): Promise<void>;
  deleteById(id: ID): Promise<void>;
  count(): Promise<number>;
}

export interface PagingAndSortingRepository<T, ID>
  extends CrudRepository<T, ID> {
  findAll(): Promise<T[]>;
  findAll(pageable: Pageable): Promise<Page<T>>;
}
