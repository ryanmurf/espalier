import { describe, it, expect } from "vitest";
import { ManyToOne, getManyToOneRelations, OneToMany, getOneToManyRelations } from "../../decorators/relations.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { getEntityMetadata } from "../../mapping/entity-metadata.js";
import { DdlGenerator } from "../../schema/ddl-generator.js";

const generator = new DdlGenerator();

@Table("departments")
class Department {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
}
// Instantiate to trigger initializers
new Department();

describe("@ManyToOne decorator", () => {
  it("stores relation metadata with explicit joinColumn", () => {
    @Table("employees")
    class Employee {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @ManyToOne({ target: () => Department, joinColumn: "dept_id" })
      department!: Department;
    }
    new Employee();

    const relations = getManyToOneRelations(Employee);
    expect(relations).toHaveLength(1);
    expect(relations[0].fieldName).toBe("department");
    expect(relations[0].joinColumn).toBe("dept_id");
    expect(relations[0].nullable).toBe(true);
  });

  it("derives joinColumn from field name + _id by default", () => {
    @Table("tasks_default_join")
    class Task {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => Department })
      department!: Department;
    }
    new Task();

    const relations = getManyToOneRelations(Task);
    expect(relations[0].joinColumn).toBe("department_id");
  });

  it("respects nullable option", () => {
    @Table("required_dept")
    class RequiredDept {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => Department, nullable: false })
      department!: Department;
    }
    new RequiredDept();

    const relations = getManyToOneRelations(RequiredDept);
    expect(relations[0].nullable).toBe(false);
  });

  it("handles multiple @ManyToOne on same class", () => {
    @Table("projects")
    class Project {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => Department, joinColumn: "dept_id" })
      department!: Department;
      @ManyToOne({ target: () => Department, joinColumn: "parent_dept_id" })
      parentDepartment!: Department;
    }
    new Project();

    const relations = getManyToOneRelations(Project);
    expect(relations).toHaveLength(2);
    const joinColumns = relations.map((r) => r.joinColumn);
    expect(joinColumns).toContain("dept_id");
    expect(joinColumns).toContain("parent_dept_id");
  });

  it("returns empty array for class without @ManyToOne", () => {
    const relations = getManyToOneRelations(Department);
    expect(relations).toEqual([]);
  });

  it("isolates metadata between classes", () => {
    @Table("teams")
    class Team {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => Department })
      department!: Department;
    }
    new Team();

    expect(getManyToOneRelations(Team)).toHaveLength(1);
    expect(getManyToOneRelations(Department)).toHaveLength(0);
  });

  it("lazy target avoids circular dependency issues", () => {
    @Table("self_ref")
    class Category {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @ManyToOne({ target: () => Category, joinColumn: "parent_id", nullable: true })
      parent!: Category;
    }
    new Category();

    const relations = getManyToOneRelations(Category);
    expect(relations).toHaveLength(1);
    expect(relations[0].target()).toBe(Category);
    expect(relations[0].joinColumn).toBe("parent_id");
  });
});

describe("EntityMetadata with @ManyToOne", () => {
  it("includes manyToOneRelations in entity metadata", () => {
    @Table("emp_meta")
    class EmpMeta {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @ManyToOne({ target: () => Department, joinColumn: "department_id" })
      department!: Department;
    }
    new EmpMeta();

    const metadata = getEntityMetadata(EmpMeta);
    expect(metadata.manyToOneRelations).toHaveLength(1);
    expect(metadata.manyToOneRelations[0].joinColumn).toBe("department_id");
  });

  it("returns empty manyToOneRelations for entity without relations", () => {
    const metadata = getEntityMetadata(Department);
    expect(metadata.manyToOneRelations).toEqual([]);
  });
});

describe("DdlGenerator with @ManyToOne", () => {
  it("generates FK column with REFERENCES", () => {
    @Table("ddl_emp")
    class DdlEmp {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @ManyToOne({ target: () => Department, joinColumn: "department_id" })
      department!: Department;
    }
    new DdlEmp();

    const sql = generator.generateCreateTable(DdlEmp);
    expect(sql).toContain("department_id INTEGER REFERENCES departments(id)");
  });

  it("generates NOT NULL FK for nullable: false", () => {
    @Table("ddl_emp_required")
    class DdlEmpRequired {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => Department, joinColumn: "department_id", nullable: false })
      department!: Department;
    }
    new DdlEmpRequired();

    const sql = generator.generateCreateTable(DdlEmpRequired);
    expect(sql).toContain("department_id INTEGER NOT NULL REFERENCES departments(id)");
  });

  it("generates nullable FK by default", () => {
    @Table("ddl_emp_nullable")
    class DdlEmpNullable {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => Department })
      department!: Department;
    }
    new DdlEmpNullable();

    const sql = generator.generateCreateTable(DdlEmpNullable);
    expect(sql).toContain("department_id INTEGER REFERENCES departments(id)");
    expect(sql).not.toContain("department_id INTEGER NOT NULL");
  });

  it("generates self-referencing FK", () => {
    @Table("ddl_categories")
    class DdlCategory {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @ManyToOne({ target: () => DdlCategory, joinColumn: "parent_id" })
      parent!: DdlCategory;
    }
    new DdlCategory();

    const sql = generator.generateCreateTable(DdlCategory);
    expect(sql).toContain("parent_id INTEGER REFERENCES ddl_categories(id)");
  });

  it("generates multiple FK columns", () => {
    @Table("ddl_multi_fk")
    class DdlMultiFk {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => Department, joinColumn: "dept_id" })
      department!: Department;
      @ManyToOne({ target: () => Department, joinColumn: "parent_dept_id" })
      parentDepartment!: Department;
    }
    new DdlMultiFk();

    const sql = generator.generateCreateTable(DdlMultiFk);
    expect(sql).toContain("dept_id INTEGER REFERENCES departments(id)");
    expect(sql).toContain("parent_dept_id INTEGER REFERENCES departments(id)");
  });
});

describe("@OneToMany decorator", () => {
  it("stores relation metadata with mappedBy", () => {
    @Table("otm_departments")
    class OtmDepartment {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @OneToMany({ target: () => OtmEmployee, mappedBy: "department" })
      employees!: OtmEmployee[];
    }

    @Table("otm_employees")
    class OtmEmployee {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => OtmDepartment })
      department!: OtmDepartment;
    }
    new OtmDepartment();
    new OtmEmployee();

    const relations = getOneToManyRelations(OtmDepartment);
    expect(relations).toHaveLength(1);
    expect(relations[0].fieldName).toBe("employees");
    expect(relations[0].mappedBy).toBe("department");
    expect(relations[0].target()).toBe(OtmEmployee);
  });

  it("returns empty array for class without @OneToMany", () => {
    const relations = getOneToManyRelations(Department);
    expect(relations).toEqual([]);
  });

  it("handles multiple @OneToMany on same class", () => {
    @Table("otm_org")
    class OtmOrg {
      @Id @Column() id: number = 0;
      @OneToMany({ target: () => Department, mappedBy: "org" })
      departments!: Department[];
      @OneToMany({ target: () => Department, mappedBy: "parentOrg" })
      subOrgs!: Department[];
    }
    new OtmOrg();

    const relations = getOneToManyRelations(OtmOrg);
    expect(relations).toHaveLength(2);
    const mappedBys = relations.map((r) => r.mappedBy);
    expect(mappedBys).toContain("org");
    expect(mappedBys).toContain("parentOrg");
  });

  it("isolates metadata between classes", () => {
    @Table("otm_parent")
    class OtmParent {
      @Id @Column() id: number = 0;
      @OneToMany({ target: () => Department, mappedBy: "parent" })
      children!: Department[];
    }
    new OtmParent();

    expect(getOneToManyRelations(OtmParent)).toHaveLength(1);
    expect(getOneToManyRelations(Department)).toHaveLength(0);
  });
});

describe("EntityMetadata with @OneToMany", () => {
  it("includes oneToManyRelations in entity metadata", () => {
    @Table("otm_meta_dept")
    class OtmMetaDept {
      @Id @Column() id: number = 0;
      @OneToMany({ target: () => Department, mappedBy: "dept" })
      children!: Department[];
    }
    new OtmMetaDept();

    const metadata = getEntityMetadata(OtmMetaDept);
    expect(metadata.oneToManyRelations).toHaveLength(1);
    expect(metadata.oneToManyRelations[0].mappedBy).toBe("dept");
  });

  it("returns empty oneToManyRelations for entity without @OneToMany", () => {
    const metadata = getEntityMetadata(Department);
    expect(metadata.oneToManyRelations).toEqual([]);
  });
});

describe("@OneToMany does not affect DDL", () => {
  it("does not generate additional columns for @OneToMany", () => {
    @Table("ddl_otm_dept")
    class DdlOtmDept {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @OneToMany({ target: () => Department, mappedBy: "dept" })
      children!: Department[];
    }
    new DdlOtmDept();

    const sql = generator.generateCreateTable(DdlOtmDept);
    // Should only have id and name columns, no FK for @OneToMany
    expect(sql).toContain("id INTEGER PRIMARY KEY");
    expect(sql).toContain("name TEXT");
    expect(sql).not.toContain("children");
    expect(sql).not.toContain("REFERENCES");
  });
});

describe("@ManyToOne + @OneToMany bidirectional", () => {
  it("both sides store correct metadata for a pair of entities", () => {
    @Table("bi_dept")
    class BiDept {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @OneToMany({ target: () => BiEmp, mappedBy: "department" })
      employees!: BiEmp[];
    }

    @Table("bi_emp")
    class BiEmp {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @ManyToOne({ target: () => BiDept, joinColumn: "department_id" })
      department!: BiDept;
    }
    new BiDept();
    new BiEmp();

    // Check @OneToMany side (Department)
    const otmRelations = getOneToManyRelations(BiDept);
    expect(otmRelations).toHaveLength(1);
    expect(otmRelations[0].fieldName).toBe("employees");
    expect(otmRelations[0].target()).toBe(BiEmp);
    expect(otmRelations[0].mappedBy).toBe("department");

    // Check @ManyToOne side (Employee)
    const mtoRelations = getManyToOneRelations(BiEmp);
    expect(mtoRelations).toHaveLength(1);
    expect(mtoRelations[0].fieldName).toBe("department");
    expect(mtoRelations[0].target()).toBe(BiDept);
    expect(mtoRelations[0].joinColumn).toBe("department_id");

    // DDL should have FK only on Employee side
    const deptSql = generator.generateCreateTable(BiDept);
    expect(deptSql).not.toContain("REFERENCES");

    const empSql = generator.generateCreateTable(BiEmp);
    expect(empSql).toContain("department_id INTEGER REFERENCES bi_dept(id)");
  });
});
