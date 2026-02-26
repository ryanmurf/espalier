import { describe, it, expect } from "vitest";
import { parseArgs, printUsage } from "../args.js";

describe("parseArgs", () => {
  it("parses command and subcommand", () => {
    const result = parseArgs(["node", "espalier", "migrate", "create", "add_users"]);
    expect(result.command).toBe("migrate");
    expect(result.subcommand).toBe("create");
    expect(result.positional).toEqual(["add_users"]);
  });

  it("returns empty strings for missing command/subcommand", () => {
    const result = parseArgs(["node", "espalier"]);
    expect(result.command).toBe("");
    expect(result.subcommand).toBe("");
    expect(result.positional).toEqual([]);
  });

  it("parses --flag=value syntax", () => {
    const result = parseArgs(["node", "espalier", "migrate", "create", "--dir=/tmp/migrations", "my_migration"]);
    expect(result.flags.dir).toBe("/tmp/migrations");
    expect(result.positional).toEqual(["my_migration"]);
  });

  it("parses --flag value syntax", () => {
    const result = parseArgs(["node", "espalier", "migrate", "create", "--dir", "/tmp/migrations", "my_migration"]);
    expect(result.flags.dir).toBe("/tmp/migrations");
    expect(result.positional).toEqual(["my_migration"]);
  });

  it("parses boolean flags", () => {
    const result = parseArgs(["node", "espalier", "--help"]);
    expect(result.flags.help).toBe(true);
  });

  it("handles multiple positional args", () => {
    const result = parseArgs(["node", "espalier", "migrate", "create", "first", "second"]);
    expect(result.positional).toEqual(["first", "second"]);
  });

  it("handles command with no subcommand", () => {
    const result = parseArgs(["node", "espalier", "help"]);
    expect(result.command).toBe("help");
    expect(result.subcommand).toBe("");
  });
});

describe("printUsage", () => {
  it("returns usage string containing commands", () => {
    const usage = printUsage();
    expect(usage).toContain("migrate create");
    expect(usage).toContain("migrate up");
    expect(usage).toContain("migrate down");
    expect(usage).toContain("migrate status");
  });
});
