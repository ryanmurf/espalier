import { Column, DdlGenerator, Id, ManyToMany, ManyToOne, OneToMany, Table } from "espalier-data";
import type { Connection } from "espalier-jdbc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { PgSchemaIntrospector } from "../../pg-schema-introspector.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

// ---------- Entity definitions ----------

@Table("e2e_rel_departments")
class Department {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ nullable: false }) name: string = "";
  @OneToMany({ target: () => Employee, mappedBy: "department" })
  employees!: Employee[];
}

@Table("e2e_rel_employees")
class Employee {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ nullable: false }) name: string = "";
  @ManyToOne({ target: () => Department, joinColumn: "department_id", nullable: false })
  department!: Department;
}

@Table("e2e_rel_contractors")
class Contractor {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ nullable: false }) name: string = "";
  @ManyToOne({ target: () => Department, nullable: true })
  department!: Department | null;
}

@Table("e2e_rel_students")
class Student {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ nullable: false }) name: string = "";
  @ManyToMany({
    target: () => Course,
    joinTable: {
      name: "e2e_rel_student_courses",
      joinColumn: "student_id",
      inverseJoinColumn: "course_id",
    },
  })
  courses!: Course[];
}

@Table("e2e_rel_courses")
class Course {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ nullable: false }) title: string = "";
  @ManyToMany({ target: () => Student, mappedBy: "courses" })
  students!: Student[];
}

// Instantiate all entities to register decorator metadata
new Department();
new Employee();
new Contractor();
new Student();
new Course();

// ---------- Tests ----------

describe.skipIf(!canConnect)("Entity Relationships E2E", () => {
  let ds: PgDataSource;
  let conn: Connection;
  let introspector: PgSchemaIntrospector;
  const generator = new DdlGenerator();

  const ALL_TABLES = [
    "e2e_rel_student_courses",
    "e2e_rel_employees",
    "e2e_rel_contractors",
    "e2e_rel_students",
    "e2e_rel_courses",
    "e2e_rel_departments",
  ];

  // Data tables that hold rows (not the schema itself)
  const DATA_TABLES = [
    "e2e_rel_student_courses",
    "e2e_rel_employees",
    "e2e_rel_contractors",
    "e2e_rel_students",
    "e2e_rel_courses",
    "e2e_rel_departments",
  ];

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    introspector = new PgSchemaIntrospector(conn);

    // Clean up any leftover tables (drop in FK-safe order)
    const stmt = conn.createStatement();
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    // Create tables in correct order: parents first, then children, then join tables
    await stmt.executeUpdate(generator.generateCreateTable(Department));
    await stmt.executeUpdate(generator.generateCreateTable(Employee));
    await stmt.executeUpdate(generator.generateCreateTable(Contractor));
    await stmt.executeUpdate(generator.generateCreateTable(Student));
    await stmt.executeUpdate(generator.generateCreateTable(Course));

    const joinTableSqls = generator.generateJoinTables([Student, Course]);
    for (const sql of joinTableSqls) {
      await stmt.executeUpdate(sql);
    }
  });

  afterAll(async () => {
    try {
      const stmt = conn.createStatement();
      for (const table of ALL_TABLES) {
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
    } finally {
      await conn.close();
      await ds.close();
    }
  });

  /** Delete all data rows (FK-safe order: children first) */
  async function clearAllData() {
    const stmt = conn.createStatement();
    for (const table of DATA_TABLES) {
      await stmt.executeUpdate(`DELETE FROM ${table}`);
    }
  }

  describe("@ManyToOne generates FK column", () => {
    it("should create department_id column with REFERENCES on employee table", async () => {
      const columns = await introspector.getColumns("e2e_rel_employees");
      const names = columns.map((c) => c.columnName);
      expect(names).toContain("department_id");

      const deptIdCol = columns.find((c) => c.columnName === "department_id")!;
      expect(deptIdCol.dataType).toBe("integer");
      expect(deptIdCol.nullable).toBe(false);
    });

    it("should enforce FK constraint — valid insert succeeds", async () => {
      await clearAllData();
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO e2e_rel_departments (name) VALUES ('Engineering')");

      const ps = conn.prepareStatement("SELECT id FROM e2e_rel_departments WHERE name = $1");
      ps.setParameter(1, "Engineering");
      const rs = await ps.executeQuery();
      await rs.next();
      const deptId = rs.getNumber("id");

      const insPs = conn.prepareStatement("INSERT INTO e2e_rel_employees (name, department_id) VALUES ($1, $2)");
      insPs.setParameter(1, "Alice");
      insPs.setParameter(2, deptId);
      await expect(insPs.executeUpdate()).resolves.not.toThrow();
    });

    it("should reject insert with non-existent FK value", async () => {
      await clearAllData();
      const ps = conn.prepareStatement("INSERT INTO e2e_rel_employees (name, department_id) VALUES ($1, $2)");
      ps.setParameter(1, "Ghost");
      ps.setParameter(2, 99999);
      await expect(ps.executeUpdate()).rejects.toThrow();
    });
  });

  describe("@OneToMany does not add columns to parent", () => {
    it("should not add extra columns to department table", async () => {
      const columns = await introspector.getColumns("e2e_rel_departments");
      const names = columns.map((c) => c.columnName);
      expect(names).toEqual(["id", "name"]);
    });
  });

  describe("nullable @ManyToOne", () => {
    it("should allow NULL department_id on contractor", async () => {
      const columns = await introspector.getColumns("e2e_rel_contractors");
      const deptCol = columns.find((c) => c.columnName === "department_id")!;
      expect(deptCol.nullable).toBe(true);
    });

    it("should allow inserting contractor with NULL department", async () => {
      await clearAllData();
      const stmt = conn.createStatement();
      await expect(
        stmt.executeUpdate("INSERT INTO e2e_rel_contractors (name) VALUES ('Freelancer')"),
      ).resolves.not.toThrow();

      const ps = conn.prepareStatement("SELECT department_id FROM e2e_rel_contractors WHERE name = $1");
      ps.setParameter(1, "Freelancer");
      const rs = await ps.executeQuery();
      await rs.next();
      expect(rs.getNumber("department_id")).toBeNull();
    });

    it("should allow inserting contractor with valid department", async () => {
      await clearAllData();
      // Create the department first
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO e2e_rel_departments (name) VALUES ('Engineering')");

      const ps = conn.prepareStatement("SELECT id FROM e2e_rel_departments WHERE name = $1");
      ps.setParameter(1, "Engineering");
      const rs = await ps.executeQuery();
      await rs.next();
      const deptId = rs.getNumber("id");

      const insPs = conn.prepareStatement("INSERT INTO e2e_rel_contractors (name, department_id) VALUES ($1, $2)");
      insPs.setParameter(1, "ConsultantBob");
      insPs.setParameter(2, deptId);
      await expect(insPs.executeUpdate()).resolves.not.toThrow();
    });
  });

  describe("@ManyToMany join table", () => {
    it("should create join table with correct columns", async () => {
      const exists = await introspector.tableExists("e2e_rel_student_courses");
      expect(exists).toBe(true);

      const columns = await introspector.getColumns("e2e_rel_student_courses");
      const names = columns.map((c) => c.columnName);
      expect(names).toContain("student_id");
      expect(names).toContain("course_id");
    });

    it("should have NOT NULL on both FK columns", async () => {
      const columns = await introspector.getColumns("e2e_rel_student_courses");
      const studentIdCol = columns.find((c) => c.columnName === "student_id")!;
      expect(studentIdCol.nullable).toBe(false);

      const courseIdCol = columns.find((c) => c.columnName === "course_id")!;
      expect(courseIdCol.nullable).toBe(false);
    });

    it("should have composite primary key", async () => {
      const keys = await introspector.getPrimaryKeys("e2e_rel_student_courses");
      expect(keys).toHaveLength(2);
      expect(keys).toContain("student_id");
      expect(keys).toContain("course_id");
    });

    it("should enforce FK constraints on join table", async () => {
      await clearAllData();
      // Insert valid students and courses
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO e2e_rel_students (name) VALUES ('StudentA')");
      await stmt.executeUpdate("INSERT INTO e2e_rel_courses (title) VALUES ('Math 101')");

      const studentPs = conn.prepareStatement("SELECT id FROM e2e_rel_students WHERE name = $1");
      studentPs.setParameter(1, "StudentA");
      const studentRs = await studentPs.executeQuery();
      await studentRs.next();
      const studentId = studentRs.getNumber("id");

      const coursePs = conn.prepareStatement("SELECT id FROM e2e_rel_courses WHERE title = $1");
      coursePs.setParameter(1, "Math 101");
      const courseRs = await coursePs.executeQuery();
      await courseRs.next();
      const courseId = courseRs.getNumber("id");

      // Valid join table insert
      const joinPs = conn.prepareStatement(
        "INSERT INTO e2e_rel_student_courses (student_id, course_id) VALUES ($1, $2)",
      );
      joinPs.setParameter(1, studentId);
      joinPs.setParameter(2, courseId);
      await expect(joinPs.executeUpdate()).resolves.not.toThrow();
    });

    it("should reject join table insert with non-existent student FK", async () => {
      await clearAllData();
      // Need a valid course to test with
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO e2e_rel_courses (title) VALUES ('ValidCourse')");
      const coursePs = conn.prepareStatement("SELECT id FROM e2e_rel_courses WHERE title = $1");
      coursePs.setParameter(1, "ValidCourse");
      const courseRs = await coursePs.executeQuery();
      await courseRs.next();
      const courseId = courseRs.getNumber("id");

      const ps = conn.prepareStatement("INSERT INTO e2e_rel_student_courses (student_id, course_id) VALUES ($1, $2)");
      ps.setParameter(1, 99999);
      ps.setParameter(2, courseId);
      await expect(ps.executeUpdate()).rejects.toThrow();
    });

    it("should reject join table insert with non-existent course FK", async () => {
      await clearAllData();
      // Need a valid student to test with
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO e2e_rel_students (name) VALUES ('ValidStudent')");
      const studentPs = conn.prepareStatement("SELECT id FROM e2e_rel_students WHERE name = $1");
      studentPs.setParameter(1, "ValidStudent");
      const rs = await studentPs.executeQuery();
      await rs.next();
      const studentId = rs.getNumber("id");

      const ps = conn.prepareStatement("INSERT INTO e2e_rel_student_courses (student_id, course_id) VALUES ($1, $2)");
      ps.setParameter(1, studentId);
      ps.setParameter(2, 99999);
      await expect(ps.executeUpdate()).rejects.toThrow();
    });

    it("should reject duplicate composite key in join table", async () => {
      await clearAllData();
      // Set up student, course, and initial join entry
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO e2e_rel_students (name) VALUES ('StudentA')");
      await stmt.executeUpdate("INSERT INTO e2e_rel_courses (title) VALUES ('Math 101')");

      const studentPs = conn.prepareStatement("SELECT id FROM e2e_rel_students WHERE name = $1");
      studentPs.setParameter(1, "StudentA");
      const studentRs = await studentPs.executeQuery();
      await studentRs.next();
      const studentId = studentRs.getNumber("id");

      const coursePs = conn.prepareStatement("SELECT id FROM e2e_rel_courses WHERE title = $1");
      coursePs.setParameter(1, "Math 101");
      const courseRs = await coursePs.executeQuery();
      await courseRs.next();
      const courseId = courseRs.getNumber("id");

      // First insert succeeds
      const joinPs = conn.prepareStatement(
        "INSERT INTO e2e_rel_student_courses (student_id, course_id) VALUES ($1, $2)",
      );
      joinPs.setParameter(1, studentId);
      joinPs.setParameter(2, courseId);
      await joinPs.executeUpdate();

      // Duplicate insert should fail
      const dupPs = conn.prepareStatement(
        "INSERT INTO e2e_rel_student_courses (student_id, course_id) VALUES ($1, $2)",
      );
      dupPs.setParameter(1, studentId);
      dupPs.setParameter(2, courseId);
      await expect(dupPs.executeUpdate()).rejects.toThrow();
    });
  });

  describe("full relationship round-trip", () => {
    it("should query across relationships using JOINs", async () => {
      await clearAllData();
      const stmt = conn.createStatement();
      // Set up students and courses from scratch
      await stmt.executeUpdate("INSERT INTO e2e_rel_students (name) VALUES ('StudentB')");
      await stmt.executeUpdate("INSERT INTO e2e_rel_courses (title) VALUES ('Math 101')");
      await stmt.executeUpdate("INSERT INTO e2e_rel_courses (title) VALUES ('Physics 201')");

      // Get IDs
      const studentBPs = conn.prepareStatement("SELECT id FROM e2e_rel_students WHERE name = $1");
      studentBPs.setParameter(1, "StudentB");
      const sbRs = await studentBPs.executeQuery();
      await sbRs.next();
      const studentBId = sbRs.getNumber("id");

      const mathPs = conn.prepareStatement("SELECT id FROM e2e_rel_courses WHERE title = $1");
      mathPs.setParameter(1, "Math 101");
      const mathRs = await mathPs.executeQuery();
      await mathRs.next();
      const mathId = mathRs.getNumber("id");

      const physPs = conn.prepareStatement("SELECT id FROM e2e_rel_courses WHERE title = $1");
      physPs.setParameter(1, "Physics 201");
      const physRs = await physPs.executeQuery();
      await physRs.next();
      const physId = physRs.getNumber("id");

      // Enroll StudentB in both courses
      const insPs = conn.prepareStatement(
        "INSERT INTO e2e_rel_student_courses (student_id, course_id) VALUES ($1, $2)",
      );
      insPs.setParameter(1, studentBId);
      insPs.setParameter(2, mathId);
      await insPs.executeUpdate();

      const insPs2 = conn.prepareStatement(
        "INSERT INTO e2e_rel_student_courses (student_id, course_id) VALUES ($1, $2)",
      );
      insPs2.setParameter(1, studentBId);
      insPs2.setParameter(2, physId);
      await insPs2.executeUpdate();

      // Query: find all courses for StudentB via JOIN
      const queryPs = conn.prepareStatement(
        `SELECT c.title FROM e2e_rel_courses c
         JOIN e2e_rel_student_courses sc ON sc.course_id = c.id
         JOIN e2e_rel_students s ON s.id = sc.student_id
         WHERE s.name = $1
         ORDER BY c.title`,
      );
      queryPs.setParameter(1, "StudentB");
      const qrs = await queryPs.executeQuery();

      const titles: string[] = [];
      while (await qrs.next()) {
        titles.push(qrs.getString("title")!);
      }
      expect(titles).toEqual(["Math 101", "Physics 201"]);
    });

    it("should query ManyToOne relationship via JOIN", async () => {
      await clearAllData();
      // Set up department and employee from scratch
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO e2e_rel_departments (name) VALUES ('Engineering')");
      const deptPs = conn.prepareStatement("SELECT id FROM e2e_rel_departments WHERE name = $1");
      deptPs.setParameter(1, "Engineering");
      const deptRs = await deptPs.executeQuery();
      await deptRs.next();
      const deptId = deptRs.getNumber("id");

      const empPs = conn.prepareStatement("INSERT INTO e2e_rel_employees (name, department_id) VALUES ($1, $2)");
      empPs.setParameter(1, "Alice");
      empPs.setParameter(2, deptId);
      await empPs.executeUpdate();

      // Query: find all employees in Engineering department
      const ps = conn.prepareStatement(
        `SELECT e.name FROM e2e_rel_employees e
         JOIN e2e_rel_departments d ON e.department_id = d.id
         WHERE d.name = $1
         ORDER BY e.name`,
      );
      ps.setParameter(1, "Engineering");
      const rs = await ps.executeQuery();

      const names: string[] = [];
      while (await rs.next()) {
        names.push(rs.getString("name")!);
      }
      expect(names).toContain("Alice");
    });
  });

  describe("CASCADE behavior", () => {
    it("should drop referenced table with CASCADE", async () => {
      // Create an isolated set of tables for this test
      const stmt = conn.createStatement();
      await stmt.executeUpdate("CREATE TABLE e2e_rel_cascade_parent (id SERIAL PRIMARY KEY, name TEXT)");
      await stmt.executeUpdate(
        "CREATE TABLE e2e_rel_cascade_child (id SERIAL PRIMARY KEY, parent_id INTEGER REFERENCES e2e_rel_cascade_parent(id))",
      );

      // DROP with CASCADE should succeed
      await expect(stmt.executeUpdate("DROP TABLE e2e_rel_cascade_parent CASCADE")).resolves.not.toThrow();

      // Child table should still exist but FK constraint should be gone
      const exists = await introspector.tableExists("e2e_rel_cascade_child");
      expect(exists).toBe(true);

      // Clean up
      await stmt.executeUpdate("DROP TABLE IF EXISTS e2e_rel_cascade_child CASCADE");
    });
  });
});
