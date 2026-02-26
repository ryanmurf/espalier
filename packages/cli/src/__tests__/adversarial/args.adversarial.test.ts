import { describe, it, expect } from "vitest";
import { parseArgs, printUsage } from "../../args.js";

describe("parseArgs adversarial", () => {
  describe("empty / missing input", () => {
    it("handles completely empty argv (no node, no script)", () => {
      const result = parseArgs([]);
      expect(result.command).toBe("");
      expect(result.subcommand).toBe("");
      expect(result.positional).toEqual([]);
      expect(result.flags).toEqual({});
    });

    it("handles argv with only node path", () => {
      const result = parseArgs(["node"]);
      expect(result.command).toBe("");
      expect(result.subcommand).toBe("");
    });

    it("handles argv with node and script but nothing else", () => {
      const result = parseArgs(["node", "espalier"]);
      expect(result.command).toBe("");
      expect(result.subcommand).toBe("");
      expect(result.positional).toEqual([]);
    });
  });

  describe("special characters in args", () => {
    it("handles args with spaces (already split by shell)", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "add users table"]);
      expect(result.positional).toEqual(["add users table"]);
    });

    it("handles args with single quotes", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "it's_a_migration"]);
      expect(result.positional).toEqual(["it's_a_migration"]);
    });

    it("handles args with double quotes embedded", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", 'name"with"quotes']);
      expect(result.positional).toEqual(['name"with"quotes']);
    });

    it("handles args with backticks", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "`whoami`"]);
      expect(result.positional).toEqual(["`whoami`"]);
    });

    it("handles unicode in args", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "migracion_usuarios"]);
      expect(result.positional).toEqual(["migracion_usuarios"]);
    });

    it("handles emoji in args", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "add_\u{1F680}_table"]);
      expect(result.positional).toEqual(["add_\u{1F680}_table"]);
    });

    it("handles CJK characters in args", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "\u79FB\u884C"]);
      expect(result.positional).toEqual(["\u79FB\u884C"]);
    });

    it("handles null bytes in args", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "name\0with\0nulls"]);
      expect(result.positional).toEqual(["name\0with\0nulls"]);
    });

    it("handles newlines in args", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "name\nwith\nnewlines"]);
      expect(result.positional).toEqual(["name\nwith\nnewlines"]);
    });

    it("handles tabs in args", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "name\twith\ttabs"]);
      expect(result.positional).toEqual(["name\twith\ttabs"]);
    });

    it("handles shell metacharacters", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "$(rm -rf /)"]);
      expect(result.positional).toEqual(["$(rm -rf /)"]);
    });

    it("handles pipe and redirect characters", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "name|cat>/etc/passwd"]);
      expect(result.positional).toEqual(["name|cat>/etc/passwd"]);
    });

    it("handles semicolons (command separator)", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "name;rm -rf /"]);
      expect(result.positional).toEqual(["name;rm -rf /"]);
    });
  });

  describe("very long strings", () => {
    it("handles a very long command name", () => {
      const longCmd = "a".repeat(10000);
      const result = parseArgs(["node", "espalier", longCmd]);
      expect(result.command).toBe(longCmd);
    });

    it("handles a very long positional arg", () => {
      const longArg = "x".repeat(100000);
      const result = parseArgs(["node", "espalier", "migrate", "create", longArg]);
      expect(result.positional).toEqual([longArg]);
    });

    it("handles many positional args", () => {
      const manyArgs = Array.from({ length: 1000 }, (_, i) => `arg${i}`);
      const result = parseArgs(["node", "espalier", "cmd", "sub", ...manyArgs]);
      expect(result.positional.length).toBe(1000);
    });
  });

  describe("flag edge cases", () => {
    it("handles a flag with no name (just --)", () => {
      const result = parseArgs(["node", "espalier", "--"]);
      // -- with nothing after slice(2) is empty string key
      expect(result.flags[""]).toBe(true);
    });

    it("handles a flag that is just --- (triple dash)", () => {
      const result = parseArgs(["node", "espalier", "---"]);
      // slice(2) gives "-"
      expect(result.flags["-"]).toBe(true);
    });

    it("handles duplicate flags (last wins for value flags)", () => {
      const result = parseArgs(["node", "espalier", "--dir", "first", "--dir", "second"]);
      expect(result.flags.dir).toBe("second");
    });

    it("handles flag with empty value via equals", () => {
      const result = parseArgs(["node", "espalier", "--dir="]);
      expect(result.flags.dir).toBe("");
    });

    it("handles flag with multiple equals signs", () => {
      const result = parseArgs(["node", "espalier", "--dir=a=b=c"]);
      expect(result.flags.dir).toBe("a=b=c");
    });

    it("handles unknown flags without crashing", () => {
      const result = parseArgs(["node", "espalier", "--unknown-flag", "--another"]);
      expect(result.flags["unknown-flag"]).toBe(true);
      expect(result.flags["another"]).toBe(true);
    });

    it("handles flag value that looks like a flag (consumed as boolean, not value)", () => {
      // When next arg starts with --, current flag is boolean
      const result = parseArgs(["node", "espalier", "--foo", "--bar"]);
      expect(result.flags.foo).toBe(true);
      expect(result.flags.bar).toBe(true);
    });

    it("treats single dash as positional, not a flag", () => {
      const result = parseArgs(["node", "espalier", "-"]);
      expect(result.command).toBe("-");
      expect(Object.keys(result.flags)).toHaveLength(0);
    });

    it("treats -short as positional (no short flag support)", () => {
      const result = parseArgs(["node", "espalier", "-v"]);
      expect(result.command).toBe("-v");
      expect(result.flags.v).toBeUndefined();
    });

    it("handles flag name with special characters", () => {
      const result = parseArgs(["node", "espalier", "--name=<script>alert(1)</script>"]);
      expect(result.flags.name).toBe("<script>alert(1)</script>");
    });

    it("handles flag name that contains equals", () => {
      // --a=b=c -> key is "a", value is "b=c"
      const result = parseArgs(["node", "espalier", "--key=val=ue"]);
      expect(result.flags.key).toBe("val=ue");
    });

    it("handles flag with value that is empty string (space-separated)", () => {
      // --dir "" -> next arg is "" which is falsy but not undefined and doesn't start with --
      const result = parseArgs(["node", "espalier", "--dir", ""]);
      expect(result.flags.dir).toBe("");
    });

    it("--flag before subcommand does not consume next word as flag value (FIXED #117)", () => {
      // Only known valued flags (--config, --dir) consume the next argument.
      // Boolean flags like --verbose do not consume the next word.
      const result = parseArgs(["node", "espalier", "migrate", "--verbose", "create", "--dir", "/tmp", "my_name"]);
      expect(result.flags.verbose).toBe(true);
      expect(result.command).toBe("migrate");
      expect(result.subcommand).toBe("create");
      expect(result.flags.dir).toBe("/tmp");
      expect(result.positional).toEqual(["my_name"]);
    });

    it("handles a flag at the very end of args with no value", () => {
      const result = parseArgs(["node", "espalier", "migrate", "create", "myname", "--verbose"]);
      expect(result.flags.verbose).toBe(true);
      expect(result.positional).toEqual(["myname"]);
    });
  });

  describe("args that look like flags but are positional values", () => {
    it("handles positional that starts with -- when not after a flag", () => {
      // parseArgs sees anything starting with -- as a flag
      const result = parseArgs(["node", "espalier", "--name"]);
      expect(result.flags.name).toBe(true);
      // The user intended --name as a migration name, but it gets parsed as a flag
      // This is expected parser behavior, but may cause confusion for users
    });

    it("does not interpret -number as a flag", () => {
      const result = parseArgs(["node", "espalier", "migrate", "down", "-1"]);
      // -1 does not start with --, so it's positional
      expect(result.positional).toEqual(["-1"]);
    });
  });

  describe("prototype pollution attempts", () => {
    it("does not pollute Object.prototype via __proto__ flag", () => {
      const originalToString = ({}).toString;
      const result = parseArgs(["node", "espalier", "--__proto__", "polluted"]);
      // The flag gets set on the flags object, but should not affect Object.prototype
      expect(({} as any).polluted).toBeUndefined();
      expect(({}).toString).toBe(originalToString);
    });

    it("handles constructor flag name", () => {
      // constructor is not a valued flag, so "value" becomes a positional word
      const result = parseArgs(["node", "espalier", "--constructor", "value"]);
      expect(result.flags.constructor).toBe(true);
    });

    it("handles toString flag name", () => {
      const result = parseArgs(["node", "espalier", "--toString"]);
      expect(result.flags.toString).toBe(true);
    });

    it("handles hasOwnProperty flag name", () => {
      const result = parseArgs(["node", "espalier", "--hasOwnProperty"]);
      expect(result.flags.hasOwnProperty).toBe(true);
    });
  });
});

describe("printUsage adversarial", () => {
  it("returns a string, never undefined or null", () => {
    const usage = printUsage();
    expect(typeof usage).toBe("string");
    expect(usage.length).toBeGreaterThan(0);
  });

  it("contains all documented commands", () => {
    const usage = printUsage();
    expect(usage).toContain("migrate create");
    expect(usage).toContain("migrate up");
    expect(usage).toContain("migrate down");
    expect(usage).toContain("migrate status");
    expect(usage).toContain("--config");
    expect(usage).toContain("--dir");
    expect(usage).toContain("--help");
  });
});
