/**
 * Serverless environment detection and default configuration.
 */

export type ServerlessEnvironment = "aws-lambda" | "vercel" | "cloudflare-workers" | "unknown";

export interface EnvironmentDefaults {
  maxIdleTimeMs: number;
  maxConnections: number;
  validateOnBorrow: boolean;
}

const ENV_DEFAULTS: Record<ServerlessEnvironment, EnvironmentDefaults> = {
  "aws-lambda": {
    maxIdleTimeMs: 5 * 60 * 1000, // 5 minutes — Lambda freeze timeout
    maxConnections: 2,
    validateOnBorrow: true,
  },
  vercel: {
    maxIdleTimeMs: 10 * 1000, // 10 seconds — Vercel functions are short-lived
    maxConnections: 1,
    validateOnBorrow: true,
  },
  "cloudflare-workers": {
    maxIdleTimeMs: 30 * 1000, // 30 seconds
    maxConnections: 1,
    validateOnBorrow: true,
  },
  unknown: {
    maxIdleTimeMs: 60 * 1000, // 1 minute
    maxConnections: 5,
    validateOnBorrow: true,
  },
};

/**
 * Detect the current serverless environment from environment variables.
 */
export function detectEnvironment(): ServerlessEnvironment {
  // Cloudflare Workers: no process.env, but has global caches API with default property
  if (
    typeof globalThis !== "undefined" &&
    "caches" in globalThis &&
    typeof (globalThis as any).caches?.default !== "undefined"
  ) {
    return "cloudflare-workers";
  }
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent.includes("Cloudflare-Workers")
  ) {
    return "cloudflare-workers";
  }
  if (typeof process !== "undefined" && process.env) {
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "aws-lambda";
    if (process.env.VERCEL) return "vercel";
  }
  return "unknown";
}

/**
 * Get sensible defaults for the detected environment.
 */
export function getEnvironmentDefaults(env?: ServerlessEnvironment): EnvironmentDefaults {
  const detected = env ?? detectEnvironment();
  return { ...ENV_DEFAULTS[detected] };
}

/**
 * Whether this is a cold start (first invocation in this process).
 * Uses a module-level flag — once set to false, subsequent calls return false.
 */
let _isColdStart = true;

export function isColdStart(): boolean {
  if (_isColdStart) {
    _isColdStart = false;
    return true;
  }
  return false;
}

/**
 * Reset cold start flag (for testing only).
 */
export function resetColdStart(): void {
  _isColdStart = true;
}
