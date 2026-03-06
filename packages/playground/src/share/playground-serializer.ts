const MAX_CODE_BYTES = 10 * 1024; // 10KB
const MAX_SCHEMA_BYTES = 5 * 1024; // 5KB

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad === 2) base64 += "==";
  else if (pad === 3) base64 += "=";

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export class PlaygroundSerializer {
  serialize(code: string, schema?: string): string {
    const codeBytes = new TextEncoder().encode(code).length;
    if (codeBytes > MAX_CODE_BYTES) {
      throw new Error(`Code exceeds maximum size of ${MAX_CODE_BYTES} bytes (got ${codeBytes})`);
    }

    if (schema !== undefined) {
      const schemaBytes = new TextEncoder().encode(schema).length;
      if (schemaBytes > MAX_SCHEMA_BYTES) {
        throw new Error(`Schema exceeds maximum size of ${MAX_SCHEMA_BYTES} bytes (got ${schemaBytes})`);
      }
    }

    const payload = JSON.stringify({ code, ...(schema !== undefined ? { schema } : {}) });
    return toBase64Url(payload);
  }

  deserialize(encoded: string): { code: string; schema?: string } {
    if (encoded.length === 0) {
      throw new Error("Cannot deserialize empty string");
    }

    let json: string;
    try {
      json = fromBase64Url(encoded);
    } catch {
      throw new Error("Invalid base64url encoding");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Invalid JSON payload");
    }

    if (typeof parsed !== "object" || parsed === null || !("code" in parsed)) {
      throw new Error("Invalid playground payload: missing 'code' field");
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.code !== "string") {
      throw new Error("Invalid playground payload: 'code' must be a string");
    }

    const codeBytes = new TextEncoder().encode(obj.code).length;
    if (codeBytes > MAX_CODE_BYTES) {
      throw new Error(`Code exceeds maximum size of ${MAX_CODE_BYTES} bytes (got ${codeBytes})`);
    }

    if (obj.schema !== undefined) {
      if (typeof obj.schema !== "string") {
        throw new Error("Invalid playground payload: 'schema' must be a string");
      }
      const schemaBytes = new TextEncoder().encode(obj.schema).length;
      if (schemaBytes > MAX_SCHEMA_BYTES) {
        throw new Error(`Schema exceeds maximum size of ${MAX_SCHEMA_BYTES} bytes (got ${schemaBytes})`);
      }
    }

    return {
      code: obj.code,
      ...(typeof obj.schema === "string" ? { schema: obj.schema } : {}),
    };
  }

  generateUrl(baseUrl: string, code: string, schema?: string): string {
    const encoded = this.serialize(code, schema);
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}p=${encoded}`;
  }
}
