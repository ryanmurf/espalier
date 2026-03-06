export interface Sort {
  property: string;
  direction: "ASC" | "DESC";
}

export interface Pageable {
  page: number;
  size: number;
  sort?: Sort[];
  /** Optional specification to filter both data and count queries. */
  spec?: { toPredicate(metadata: any): any };
}

export interface Page<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  page: number;
  size: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export function createPageable(page: number, size: number, sort?: Sort[]): Pageable {
  return { page, size, sort };
}

export function createPage<T>(content: T[], pageable: Pageable, totalElements: number): Page<T> {
  if (!Number.isFinite(pageable.size) || pageable.size <= 0) {
    throw new Error(`Page size must be a positive number, got ${pageable.size}`);
  }
  if (!Number.isFinite(pageable.page) || pageable.page < 0) {
    throw new Error(`Page number must be a non-negative number, got ${pageable.page}`);
  }
  if (!Number.isFinite(totalElements) || totalElements < 0) {
    throw new Error(`Total elements must be a non-negative number, got ${totalElements}`);
  }
  const totalPages = Math.ceil(totalElements / pageable.size);
  return {
    content,
    totalElements,
    totalPages,
    page: pageable.page,
    size: pageable.size,
    hasNext: pageable.page < totalPages - 1,
    hasPrevious: pageable.page > 0,
  };
}
