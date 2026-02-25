// src/decorators/table.ts
var tableMetadata = /* @__PURE__ */ new WeakMap();
function Table(name) {
  return function(target, _context) {
    const tableName = name ?? target.name.toLowerCase();
    tableMetadata.set(target, tableName);
    return target;
  };
}
function getTableName(target) {
  return tableMetadata.get(target);
}

// src/decorators/column.ts
var columnMetadata = /* @__PURE__ */ new WeakMap();
function Column(options) {
  return function(_target, context) {
    const columnName = typeof options === "string" ? options : options?.name ?? String(context.name);
    context.addInitializer(function() {
      const constructor = this.constructor;
      if (!columnMetadata.has(constructor)) {
        columnMetadata.set(constructor, /* @__PURE__ */ new Map());
      }
      columnMetadata.get(constructor).set(context.name, columnName);
    });
  };
}
function getColumnMappings(target) {
  return columnMetadata.get(target) ?? /* @__PURE__ */ new Map();
}

// src/decorators/id.ts
var idMetadata = /* @__PURE__ */ new WeakMap();
function Id(_target, context) {
  context.addInitializer(function() {
    const constructor = this.constructor;
    idMetadata.set(constructor, context.name);
  });
}
function getIdField(target) {
  return idMetadata.get(target);
}

// src/decorators/auditing.ts
var createdDateMetadata = /* @__PURE__ */ new WeakMap();
var lastModifiedDateMetadata = /* @__PURE__ */ new WeakMap();
function CreatedDate(_target, context) {
  context.addInitializer(function() {
    const constructor = this.constructor;
    createdDateMetadata.set(constructor, context.name);
  });
}
function LastModifiedDate(_target, context) {
  context.addInitializer(function() {
    const constructor = this.constructor;
    lastModifiedDateMetadata.set(constructor, context.name);
  });
}
function getCreatedDateField(target) {
  return createdDateMetadata.get(target);
}
function getLastModifiedDateField(target) {
  return lastModifiedDateMetadata.get(target);
}

// src/repository/paging.ts
function createPageable(page, size, sort) {
  return { page, size, sort };
}
function createPage(content, pageable, totalElements) {
  const totalPages = Math.ceil(totalElements / pageable.size);
  return {
    content,
    totalElements,
    totalPages,
    page: pageable.page,
    size: pageable.size,
    hasNext: pageable.page < totalPages - 1,
    hasPrevious: pageable.page > 0
  };
}

// src/mapping/entity-metadata.ts
function getEntityMetadata(entityClass) {
  const tableName = getTableName(entityClass);
  if (!tableName) {
    throw new Error(
      `No @Table decorator found on ${entityClass.name}. Ensure the class is decorated with @Table.`
    );
  }
  const idField = getIdField(entityClass);
  if (!idField) {
    throw new Error(
      `No @Id decorator found on ${entityClass.name}. Ensure a field is decorated with @Id.`
    );
  }
  const columnMappings = getColumnMappings(entityClass);
  const fields = [];
  for (const [fieldName, columnName] of columnMappings) {
    fields.push({ fieldName, columnName });
  }
  return {
    tableName,
    idField,
    fields,
    createdDateField: getCreatedDateField(entityClass),
    lastModifiedDateField: getLastModifiedDateField(entityClass)
  };
}

// src/mapping/row-mapper.ts
function createRowMapper(entityClass, metadata) {
  return {
    mapRow(resultSet) {
      const row = resultSet.getRow();
      const entity = Object.create(entityClass.prototype);
      for (const field of metadata.fields) {
        const value = row[field.columnName];
        entity[field.fieldName] = value;
      }
      return entity;
    }
  };
}

// src/query/criteria.ts
var ComparisonCriteria = class {
  constructor(type, column, value) {
    this.type = type;
    this.column = column;
    this.value = value;
  }
  toSql(paramOffset) {
    const ops = {
      eq: "=",
      neq: "!=",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
      like: "LIKE"
    };
    return {
      sql: `${this.column} ${ops[this.type]} $${paramOffset}`,
      params: [this.value]
    };
  }
};
var InCriteria = class {
  constructor(column, values) {
    this.column = column;
    this.values = values;
  }
  type = "in";
  toSql(paramOffset) {
    const placeholders = this.values.map((_, i) => `$${paramOffset + i}`);
    return {
      sql: `${this.column} IN (${placeholders.join(", ")})`,
      params: [...this.values]
    };
  }
};
var BetweenCriteria = class {
  constructor(column, low, high) {
    this.column = column;
    this.low = low;
    this.high = high;
  }
  type = "between";
  toSql(paramOffset) {
    return {
      sql: `${this.column} BETWEEN $${paramOffset} AND $${paramOffset + 1}`,
      params: [this.low, this.high]
    };
  }
};
var NullCriteria = class {
  constructor(type, column) {
    this.type = type;
    this.column = column;
  }
  toSql(_paramOffset) {
    const op = this.type === "isNull" ? "IS NULL" : "IS NOT NULL";
    return {
      sql: `${this.column} ${op}`,
      params: []
    };
  }
};
var LogicalCriteria = class {
  constructor(type, left, right) {
    this.type = type;
    this.left = left;
    this.right = right;
  }
  toSql(paramOffset) {
    const leftResult = this.left.toSql(paramOffset);
    const rightResult = this.right.toSql(paramOffset + leftResult.params.length);
    const op = this.type === "and" ? "AND" : "OR";
    return {
      sql: `(${leftResult.sql} ${op} ${rightResult.sql})`,
      params: [...leftResult.params, ...rightResult.params]
    };
  }
};
var NotCriteria = class {
  constructor(criteria) {
    this.criteria = criteria;
  }
  type = "not";
  toSql(paramOffset) {
    const result = this.criteria.toSql(paramOffset);
    return {
      sql: `NOT (${result.sql})`,
      params: result.params
    };
  }
};
function and(left, right) {
  return new LogicalCriteria("and", left, right);
}
function or(left, right) {
  return new LogicalCriteria("or", left, right);
}
function not(criteria) {
  return new NotCriteria(criteria);
}

// src/query/column-ref.ts
var ColumnRef = class {
  constructor(name) {
    this.name = name;
  }
  eq(value) {
    return new ComparisonCriteria("eq", this.name, value);
  }
  neq(value) {
    return new ComparisonCriteria("neq", this.name, value);
  }
  gt(value) {
    return new ComparisonCriteria("gt", this.name, value);
  }
  gte(value) {
    return new ComparisonCriteria("gte", this.name, value);
  }
  lt(value) {
    return new ComparisonCriteria("lt", this.name, value);
  }
  lte(value) {
    return new ComparisonCriteria("lte", this.name, value);
  }
  like(pattern) {
    return new ComparisonCriteria("like", this.name, pattern);
  }
  in(values) {
    return new InCriteria(this.name, values);
  }
  between(low, high) {
    return new BetweenCriteria(this.name, low, high);
  }
  isNull() {
    return new NullCriteria("isNull", this.name);
  }
  isNotNull() {
    return new NullCriteria("isNotNull", this.name);
  }
};
function col(name) {
  return new ColumnRef(name);
}

// src/query/query-builder.ts
var SelectBuilder = class {
  _columns = ["*"];
  _from;
  _joins = [];
  _where;
  _orderBy = [];
  _groupBy = [];
  _having;
  _limit;
  _offset;
  constructor(from) {
    this._from = from;
  }
  columns(...columns) {
    this._columns = columns;
    return this;
  }
  where(criteria) {
    this._where = criteria;
    return this;
  }
  and(criteria) {
    if (!this._where) {
      this._where = criteria;
    } else {
      this._where = new LogicalCriteria("and", this._where, criteria);
    }
    return this;
  }
  or(criteria) {
    if (!this._where) {
      this._where = criteria;
    } else {
      this._where = new LogicalCriteria("or", this._where, criteria);
    }
    return this;
  }
  join(type, table, on) {
    this._joins.push({ type, table, on });
    return this;
  }
  orderBy(column, direction = "ASC") {
    this._orderBy.push({ column, direction });
    return this;
  }
  groupBy(...columns) {
    this._groupBy = columns;
    return this;
  }
  having(criteria) {
    this._having = criteria;
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  offset(n) {
    this._offset = n;
    return this;
  }
  build() {
    const params = [];
    let paramIdx = 1;
    const parts = [];
    parts.push(`SELECT ${this._columns.join(", ")}`);
    parts.push(`FROM ${this._from}`);
    for (const join of this._joins) {
      parts.push(`${join.type} JOIN ${join.table} ON ${join.on}`);
    }
    if (this._where) {
      const result = this._where.toSql(paramIdx);
      parts.push(`WHERE ${result.sql}`);
      params.push(...result.params);
      paramIdx += result.params.length;
    }
    if (this._groupBy.length > 0) {
      parts.push(`GROUP BY ${this._groupBy.join(", ")}`);
    }
    if (this._having) {
      const result = this._having.toSql(paramIdx);
      parts.push(`HAVING ${result.sql}`);
      params.push(...result.params);
      paramIdx += result.params.length;
    }
    if (this._orderBy.length > 0) {
      const clauses = this._orderBy.map((o) => `${o.column} ${o.direction}`);
      parts.push(`ORDER BY ${clauses.join(", ")}`);
    }
    if (this._limit !== void 0) {
      parts.push(`LIMIT $${paramIdx}`);
      params.push(this._limit);
      paramIdx++;
    }
    if (this._offset !== void 0) {
      parts.push(`OFFSET $${paramIdx}`);
      params.push(this._offset);
      paramIdx++;
    }
    return { sql: parts.join(" "), params };
  }
};
var InsertBuilder = class {
  _table;
  _columns = [];
  _values = [];
  _returning = [];
  constructor(table) {
    this._table = table;
  }
  set(column, value) {
    this._columns.push(column);
    this._values.push(value);
    return this;
  }
  values(record) {
    for (const [column, value] of Object.entries(record)) {
      this._columns.push(column);
      this._values.push(value);
    }
    return this;
  }
  returning(...columns) {
    this._returning = columns;
    return this;
  }
  build() {
    const placeholders = this._columns.map((_, i) => `$${i + 1}`);
    let sql = `INSERT INTO ${this._table} (${this._columns.join(", ")}) VALUES (${placeholders.join(", ")})`;
    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.join(", ")}`;
    }
    return { sql, params: [...this._values] };
  }
};
var UpdateBuilder = class {
  _table;
  _sets = [];
  _where;
  _returning = [];
  constructor(table) {
    this._table = table;
  }
  set(column, value) {
    this._sets.push({ column, value });
    return this;
  }
  values(record) {
    for (const [column, value] of Object.entries(record)) {
      this._sets.push({ column, value });
    }
    return this;
  }
  where(criteria) {
    this._where = criteria;
    return this;
  }
  and(criteria) {
    if (!this._where) {
      this._where = criteria;
    } else {
      this._where = new LogicalCriteria("and", this._where, criteria);
    }
    return this;
  }
  returning(...columns) {
    this._returning = columns;
    return this;
  }
  build() {
    const params = [];
    let paramIdx = 1;
    const setClauses = this._sets.map((s) => {
      params.push(s.value);
      return `${s.column} = $${paramIdx++}`;
    });
    let sql = `UPDATE ${this._table} SET ${setClauses.join(", ")}`;
    if (this._where) {
      const result = this._where.toSql(paramIdx);
      sql += ` WHERE ${result.sql}`;
      params.push(...result.params);
    }
    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.join(", ")}`;
    }
    return { sql, params };
  }
};
var DeleteBuilder = class {
  _table;
  _where;
  _returning = [];
  constructor(table) {
    this._table = table;
  }
  where(criteria) {
    this._where = criteria;
    return this;
  }
  and(criteria) {
    if (!this._where) {
      this._where = criteria;
    } else {
      this._where = new LogicalCriteria("and", this._where, criteria);
    }
    return this;
  }
  returning(...columns) {
    this._returning = columns;
    return this;
  }
  build() {
    const params = [];
    const paramIdx = 1;
    let sql = `DELETE FROM ${this._table}`;
    if (this._where) {
      const result = this._where.toSql(paramIdx);
      sql += ` WHERE ${result.sql}`;
      params.push(...result.params);
    }
    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.join(", ")}`;
    }
    return { sql, params };
  }
};
function resolveTable(entityOrTable) {
  if (typeof entityOrTable === "string") {
    return { table: entityOrTable };
  }
  const metadata = getEntityMetadata(entityOrTable);
  return { table: metadata.tableName, metadata };
}
function resolveColumns(metadata) {
  return metadata.fields.map((f) => f.columnName);
}
var QueryBuilder = {
  select(entityOrTable) {
    const { table, metadata } = resolveTable(entityOrTable);
    const builder = new SelectBuilder(table);
    if (metadata) {
      builder.columns(...resolveColumns(metadata));
    }
    return builder;
  },
  insert(entityOrTable) {
    const { table } = resolveTable(entityOrTable);
    return new InsertBuilder(table);
  },
  update(entityOrTable) {
    const { table } = resolveTable(entityOrTable);
    return new UpdateBuilder(table);
  },
  delete(entityOrTable) {
    const { table } = resolveTable(entityOrTable);
    return new DeleteBuilder(table);
  }
};
export {
  BetweenCriteria,
  Column,
  ColumnRef,
  ComparisonCriteria,
  CreatedDate,
  DeleteBuilder,
  Id,
  InCriteria,
  InsertBuilder,
  LastModifiedDate,
  LogicalCriteria,
  NotCriteria,
  NullCriteria,
  QueryBuilder,
  SelectBuilder,
  Table,
  UpdateBuilder,
  and,
  col,
  createPage,
  createPageable,
  createRowMapper,
  getColumnMappings,
  getCreatedDateField,
  getEntityMetadata,
  getIdField,
  getLastModifiedDateField,
  getTableName,
  not,
  or
};
//# sourceMappingURL=index.js.map