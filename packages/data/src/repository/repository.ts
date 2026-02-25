export interface Repository<T, ID> {
  findById(id: ID): Promise<T | null>;
  existsById(id: ID): Promise<boolean>;
}
