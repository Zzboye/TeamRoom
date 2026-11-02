export type DomainErrorCode =
  | "validation" | "conflict" | "retryable_adapter" | "permanent_adapter"
  | "timeout" | "approval_required" | "budget_exhausted" | "corrupt_data" | "status_unknown";

export class DomainError extends Error {
  override readonly name = "DomainError";

  constructor(readonly code: DomainErrorCode, message: string) {
    super(message);
    Object.freeze(this);
  }
}
