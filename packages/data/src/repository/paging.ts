export interface Sort {
  property: string;
  direction: "ASC" | "DESC";
}

export interface Pageable {
  page: number;
  size: number;
  sort?: Sort[];
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

export function createPageable(
  page: number,
  size: number,
  sort?: Sort[],
): Pageable {
  return { page, size, sort };
}

export function createPage<T>(
  content: T[],
  pageable: Pageable,
  totalElements: number,
): Page<T> {
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
