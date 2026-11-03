import { DomainError } from "@teamroom/room-domain";

/** Stable persisted bytes, independent of object insertion order. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, normalize(item)]));
    return input;
  };
  return JSON.stringify(normalize(value));
}
export function parseJson<T>(json: string): T {
  try { return JSON.parse(json) as T } catch { throw new DomainError("corrupt_data", "Invalid persisted JSON") }
}
export function storeError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = (error as { code?: string } | null)?.code ?? "";
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) throw new DomainError("conflict", "Database writer is busy");
  if (code.startsWith("SQLITE_CONSTRAINT")) throw new DomainError("corrupt_data", "Persistence constraint failed");
  throw error;
}
