import { randomUUID } from "node:crypto";
import { domainId, DomainError, type Action, type NewRoomEvent, type Room, type RoomId, type Usage } from "@teamroom/room-domain";
import type { ClockPort, IdPort, ToolPort, ToolReconciliation, ToolResult } from "@teamroom/runtime-ports";
import { RoomService, writeDerivedEvents } from "./room-service.js";

/** This declaration is only for side-effect-free, reproducible work. */
export interface SafeDeterministicRecovery {
  canResume(room: Room, action: Action): boolean;
  resume(room: Room, action: Action): Promise<ToolResult>;
}
export interface RoomRecoveryOptions {
  readonly service: RoomService;
  readonly tool: ToolPort;
  readonly safeDeterministic?: SafeDeterministicRecovery;
  readonly clock?: ClockPort;
  readonly ids?: IdPort;
}
type Success = Extract<ToolReconciliation, { status: "succeeded" }>;
type Outcome = { readonly status: "succeeded"; readonly result: Success; readonly usage: Usage } | { readonly status: "failed" | "status_unknown"; readonly reason: string };
const zero: Usage = { rounds: 0, actions: 1, tokens: 0, cost: 0 };
const unknown = (reason: string): Outcome => ({ status: "status_unknown", reason });
function outcome(value: ToolReconciliation | ToolResult): Outcome {
  if (value?.status === "succeeded") {
    const usage = value.usage;
    if (typeof value.output !== "string" || !Array.isArray(value.artifactIds) || !value.artifactIds.every(id => typeof id === "string" && id.trim().length > 0) || !usage || typeof usage !== "object") return unknown("Invalid reconciliation success");
    const { rounds = 0, actions = 0, tokens = 0, cost = 0 } = usage;
    if (rounds !== 0 || (actions !== 0 && actions !== 1) || !Number.isSafeInteger(tokens) || tokens < 0 || !Number.isFinite(cost) || cost < 0) return unknown("Invalid reconciliation usage");
    return { status: "succeeded", result: structuredClone(value), usage: { rounds: 0, actions: 1, tokens, cost } };
  }
  if (value?.status === "failed" || value?.status === "permanent_failure") return { status: "failed", reason: value.reason || "Adapter confirmed failure" };
  return unknown(value && "reason" in value && typeof value.reason === "string" ? value.reason : "Completion cannot be proven");
}

/** Recovery retries persistence of obtained results, never uncertain execution. */
export class RoomRecovery {
  private readonly active = new Set<RoomId>();
  constructor(private readonly options: RoomRecoveryOptions) {}

  async recoverRoom(roomId: RoomId): Promise<Room> {
    if (this.active.has(roomId)) throw new DomainError("conflict", "Recovery is already active for this room");
    this.active.add(roomId);
    try {
      const initial = await this.options.service.load(roomId);
      const pending = initial.actions.filter(action => action.status === "started").sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const action of pending) {
        const room = await this.options.service.load(roomId);
        if (room.actions.find(item => item.id === action.id)?.status !== "started") continue;
        let obtained: Outcome;
        try {
          const reconciled = await this.options.tool.reconcile(action.id, action.idempotencyKey);
          if (reconciled?.status === "not_started" && this.options.safeDeterministic) {
            // User intent may have changed while reconciliation was in flight.
            const current = await this.options.service.load(roomId);
            const currentAction = current.actions.find(item => item.id === action.id);
            if (currentAction?.status !== "started") continue;
            if (current.status === "running" && !current.pauseRequested && this.options.safeDeterministic.canResume(current, currentAction)) obtained = outcome(await this.options.safeDeterministic.resume(current, currentAction));
            else obtained = unknown("Action was not completed; deterministic resume is not permitted");
          } else obtained = outcome(reconciled);
        } catch { obtained = unknown("Adapter could not prove completion") }
        await this.commit(roomId, action, obtained);
      }
      return this.options.service.load(roomId);
    } finally { this.active.delete(roomId) }
  }

  private async commit(roomId: RoomId, action: Action, obtained: Outcome): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const room = await this.options.service.load(roomId);
      if (room.actions.find(item => item.id === action.id)?.status !== "started") return;
      const events: NewRoomEvent[] = [];
      if (obtained.status !== "succeeded" && !room.pauseRequested) events.push({ type: "RunPauseRequested", reason: `${obtained.status}: ${obtained.reason}` });
      if (obtained.status === "succeeded") {
        // Retain the complete reconciled payload in the existing message model.
        // Message, usage and terminal action are one optimistic transaction.
        events.push({ type: "MessagePosted", message: {
          id: domainId.message(this.options.ids?.next("message") ?? randomUUID()), roomId,
          authorType: "system", authorId: "system", type: "action_summary",
          content: JSON.stringify({ actionId: action.id, output: obtained.result.output, artifactIds: obtained.result.artifactIds }),
          sequence: room.latestMessageSequence + 1, createdAt: this.options.clock?.now() ?? new Date().toISOString(),
        } });
      }
      events.push({ type: "ActionCompleted", actionId: action.id, status: obtained.status, errorCode: obtained.status === "succeeded" ? null : obtained.status === "failed" ? "permanent_adapter" : "status_unknown", usage: obtained.status === "succeeded" ? obtained.usage : zero });
      try { await writeDerivedEvents(this.options.service, room, events); return }
      catch (error) { if (!(error instanceof DomainError && error.code === "conflict") || attempt === 2) throw error }
    }
  }
}

export function recoverRoom(roomId: RoomId, options: RoomRecoveryOptions): Promise<Room> {
  return new RoomRecovery(options).recoverRoom(roomId);
}
