declare const console: {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  OFF = 5,
}

export interface Logger {
  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  isEnabled(level: LogLevel): boolean;
  child(name: string): Logger;
}

export class NoopLogger implements Logger {
  trace(_message: string, _context?: Record<string, unknown>): void {}
  debug(_message: string, _context?: Record<string, unknown>): void {}
  info(_message: string, _context?: Record<string, unknown>): void {}
  warn(_message: string, _context?: Record<string, unknown>): void {}
  error(_message: string, _context?: Record<string, unknown>): void {}
  isEnabled(_level: LogLevel): boolean {
    return false;
  }
  child(_name: string): Logger {
    return this;
  }
}

const LEVEL_LABELS: Record<number, string> = {
  [LogLevel.TRACE]: "TRACE",
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly name: string;

  constructor(options?: { level?: LogLevel; name?: string }) {
    this.level = options?.level ?? LogLevel.DEBUG;
    this.name = options?.name ?? "espalier";
  }

  trace(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.TRACE, message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, context);
  }

  isEnabled(level: LogLevel): boolean {
    return level >= this.level;
  }

  child(name: string): Logger {
    return new ConsoleLogger({ level: this.level, name: `${this.name}.${name}` });
  }

  private static safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value, (_key, v) => {
        if (typeof v === "bigint") return `${v}n`;
        return v;
      });
    } catch {
      return "[unserializable]";
    }
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (level < this.level) return;

    const timestamp = new Date().toISOString();
    const label = LEVEL_LABELS[level] ?? "UNKNOWN";
    const prefix = `${timestamp} ${label} [${this.name}]`;
    const line = context !== undefined
      ? `${prefix} ${message} ${ConsoleLogger.safeStringify(context)}`
      : `${prefix} ${message}`;

    if (level >= LogLevel.ERROR) {
      console.error(line);
    } else if (level >= LogLevel.WARN) {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

let globalLogger: Logger = new NoopLogger();

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}

export function getGlobalLogger(): Logger {
  return globalLogger;
}

export function createConsoleLogger(options?: { level?: LogLevel; name?: string }): Logger {
  return new ConsoleLogger(options);
}
