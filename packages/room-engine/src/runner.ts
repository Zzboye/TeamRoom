import { decide, domainId, DomainError, type Action, type DomainErrorCode, type NewRoomEvent, type Room, type RoomCommand, type RoomId, type Usage } from "@teamroom/room-domain";
import type { ConvergenceDecision, FacilitatorPlan, FacilitatorPort, PersonaActionResult, PersonaPort } from "@teamroom/runtime-ports";
import { RoomService, writeDerivedEvents } from "./room-service.js";

export type StepOutcome = "advanced" | "paused" | "awaiting_input" | "awaiting_approval" | "awaiting_acceptance" | "completed";
export interface StepResult { readonly room: Room; readonly outcome: StepOutcome }
export interface AutonomousRunnerOptions { readonly service: RoomService; readonly facilitator: FacilitatorPort; readonly persona: PersonaPort }

const zero: Usage = { rounds: 0, actions: 0, tokens: 0, cost: 0 };
const order = (a: Action, b: Action) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function adapterValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError("permanent_adapter", message);
}
function adapterCode(error: unknown): DomainErrorCode {
  return error instanceof DomainError && ["retryable_adapter", "permanent_adapter", "timeout", "approval_required", "status_unknown"].includes(error.code) ? error.code : "permanent_adapter";
}
function result(room: Room): StepResult {
  const outcome = room.pauseRequested ? "paused" : room.status;
  if (outcome === "paused" || outcome === "awaiting_input" || outcome === "awaiting_approval" || outcome === "awaiting_acceptance" || outcome === "completed") return { room, outcome };
  return { room, outcome: "advanced" };
}
function executing(room: Room): boolean { return (room.status === "running" || room.status === "convergence_check") && !room.pauseRequested }

function validatePlan(room: Room, plan: FacilitatorPlan): void {
  adapterValid(plan && Array.isArray(plan.actions), "Invalid facilitator plan");
  const ids = new Set(room.actions.map(action => action.id));
  const keys = new Set(room.actions.map(action => action.idempotencyKey));
  const roundId = plan.actions[0]?.roundId;
  adapterValid(plan.actions.length === 0 || (roundId !== undefined && !room.activeRun?.roundIds.includes(roundId) && text(roundId)), "Invalid plan round");
  for (const action of plan.actions) {
    adapterValid(action && text(action.id) && !ids.has(action.id) && text(action.idempotencyKey) && !keys.has(action.idempotencyKey), "Duplicate or invalid action identity");
    adapterValid(action.roomId === room.id && action.runId === room.activeRun?.id && action.roundId === roundId && room.members.some(member => member.id === action.memberId), "Invalid facilitator assignment");
    adapterValid(Number.isSafeInteger(action.position) && action.position >= 0 && text(action.instruction) && Array.isArray(action.dependencies) && new Set(action.dependencies).size === action.dependencies.length && action.dependencies.every(text), "Invalid action plan");
    adapterValid(action.status === "planned" && action.errorCode === null && action.startedAt === null && action.completedAt === null, "Action must be unstarted");
    ids.add(action.id); keys.add(action.idempotencyKey);
  }
  const pending = new Map(plan.actions.map(action => [action.id, action]));
  const satisfied = new Set(room.actions.filter(action => action.status === "succeeded").map(action => action.id));
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(action => action.dependencies.every((id: Action["id"]) => satisfied.has(id)));
    adapterValid(ready.length > 0, "Missing, failed or cyclic action dependency");
    for (const action of ready) { pending.delete(action.id); satisfied.add(action.id) }
  }
}

function usageOf(value: PersonaActionResult): Usage {
  adapterValid(value && Array.isArray(value.messages) && Array.isArray(value.memoryProposals) && value.usage && typeof value.usage === "object", "Invalid persona result");
  const { rounds = 0, actions = 0, tokens = 0, cost = 0 } = value.usage;
  adapterValid(rounds === 0 && (actions === 0 || actions === 1) && Number.isSafeInteger(tokens) && tokens >= 0 && Number.isFinite(cost) && cost >= 0, "Invalid persona usage");
  return { rounds: 0, actions: 1, tokens, cost };
}

function outputEvents(room: Room, action: Action, output: PersonaActionResult): readonly NewRoomEvent[] {
  const events: NewRoomEvent[] = [];
  let preview = room;
  const command = (input: RoomCommand) => {
    const decision = decide(preview, input);
    adapterValid(decision.ok, decision.ok ? "" : decision.error.message);
    events.push(...decision.events);
  };
  for (const message of output.messages) {
    adapterValid(message && text(message.id) && text(message.content) && text(message.createdAt) && !Number.isNaN(Date.parse(message.createdAt)) && (message.type === "persona" || message.type === "facilitator" || message.type === "action_summary"), "Invalid persona message");
    const positioned = { ...message, sequence: preview.latestMessageSequence + 1 };
    command({ type: "PostMessage", commandId: domainId.command(action.id), roomId: room.id, expectedVersion: room.streamVersion, actor: action.memberId, message: positioned });
    // Later messages may link to earlier messages in the same result.
    preview = { ...preview, messages: [...preview.messages, positioned], latestMessageSequence: positioned.sequence };
  }
  const memoryIds = new Set<string>();
  for (const item of output.memoryProposals) {
    adapterValid(item && item.memberId === action.memberId && !memoryIds.has(item.id), "Cross-member or duplicate memory proposal");
    adapterValid(text(item.id) && text(item.createdByEventId) && text(item.updatedByEventId) && typeof item.pinned === "boolean", "Invalid memory metadata");
    command({ type: "EditMemoryItem", commandId: domainId.command(action.id), roomId: room.id, expectedVersion: room.streamVersion, actor: action.memberId, item });
    memoryIds.add(item.id);
  }
  return events;
}

function budgetReason(room: Room, beforeRound = false): string | null {
  const budget = room.budget;
  if (!budget) return null;
  const reserved = room.actions.filter(action => action.status === "started").length;
  if ((beforeRound && budget.maxRounds !== undefined && room.usage.rounds >= budget.maxRounds) ||
    (budget.maxActions !== undefined && room.usage.actions + reserved >= budget.maxActions) ||
    (budget.maxTokens !== undefined && room.usage.tokens >= budget.maxTokens) ||
    (budget.maxCost !== undefined && room.usage.cost >= budget.maxCost)) return `budget_exhausted: usage ${JSON.stringify(room.usage)}`;
  return null;
}

/** One deterministic plan/execution/evaluation cycle; no tool or external-effect dispatch. */
export class AutonomousRunner {
  private readonly active = new Set<RoomId>();
  constructor(private readonly options: AutonomousRunnerOptions) {}

  async step(roomId: RoomId): Promise<StepResult> {
    if (this.active.has(roomId)) throw new DomainError("conflict", "A step is already active for this room");
    this.active.add(roomId);
    try { return await this.advance(roomId) }
    catch (error) {
      // A new user command invalidates work based on the old committed snapshot.
      if (error instanceof DomainError && error.code === "conflict") return result(await this.options.service.load(roomId));
      throw error;
    } finally { this.active.delete(roomId) }
  }

  private async pause(room: Room, reason: string): Promise<Room> {
    if (!executing(room)) return room;
    return writeDerivedEvents(this.options.service, room, [{ type: room.actions.some(action => action.status === "started") ? "RunPauseRequested" : "RunPaused", reason }]);
  }

  private async advance(roomId: RoomId): Promise<StepResult> {
    const { service, facilitator, persona } = this.options;
    let room = await service.load(roomId);
    if (!executing(room)) return result(room);
    if (room.actions.some(action => action.status === "started")) return result(room); // Recovery owns already-started work.
    // A terminal unsuccessful prerequisite cannot become ready after resume. Surface
    // the blocked plan before scheduling/evaluation, without inventing action starts.
    const blocked = room.actions.filter(action => action.status === "planned" && action.dependencies.some(id => room.actions.some(dependency => dependency.id === id && (dependency.status === "failed" || dependency.status === "cancelled" || dependency.status === "status_unknown")))).sort(order);
    if (blocked.length > 0) return result(await this.pause(room, `blocked_plan: Unsuccessful prerequisites block actions ${blocked.map(action => action.id).join(", ")}; plan repair required`));
    if (!room.actions.some(action => action.status === "planned")) {
      const exhausted = budgetReason(room, true);
      if (exhausted) return result(await this.pause(room, exhausted));
      let plan: FacilitatorPlan;
      try {
        plan = await facilitator.plan({ room, callKey: `${room.activeRun!.id}:plan:${room.usage.rounds + 1}` });
        validatePlan(room, plan);
      } catch (error) { return result(await this.pause(await service.load(roomId), `${adapterCode(error)}: Invalid facilitator plan`)) }
      const roundId = plan.actions[0]?.roundId ?? domainId.round(`${room.activeRun!.id}:round:${room.usage.rounds + 1}`);
      room = await writeDerivedEvents(service, room, [{ type: "RoundPlanned", roundId, actions: plan.actions }]);
    }

    if (executing(room)) {
      const ready = room.actions.filter(action => action.status === "planned" && action.dependencies.every(id => room.actions.some(dependency => dependency.id === id && dependency.status === "succeeded"))).sort(order);
      const dispatched: { action: Action; promise: Promise<PersonaActionResult> }[] = [];
      let schedulingError: unknown;
      try {
        for (const action of ready) {
          room = await service.load(roomId);
          if (!executing(room)) break;
          const exhausted = budgetReason(room);
          if (exhausted) { room = await this.pause(room, exhausted); break }
          room = await writeDerivedEvents(service, room, [{ type: "ActionStarted", actionId: action.id }]);
          const started = room.actions.find(item => item.id === action.id)!;
          const memory = Object.freeze(room.memory.filter(item => item.memberId === action.memberId));
          const input = { room: Object.freeze({ ...room, memory }), action: started, memory, callKey: action.idempotencyKey };
          // Attach rejection handling immediately, including synchronous adapter throws.
          const promise = Promise.resolve().then(() => persona.act(input));
          void promise.catch(() => undefined);
          dispatched.push({ action: started, promise });
        }
      } catch (error) { schedulingError = error }
      const outcomes = await Promise.allSettled(dispatched.map(item => item.promise));
      // dispatched is sorted before execution, so settling order cannot affect committed order.
      for (const [index, dispatchedAction] of dispatched.entries()) {
        await this.complete(roomId, dispatchedAction.action, outcomes[index]!);
      }
      if (schedulingError) throw schedulingError;
      room = await service.load(roomId);
      if (!executing(room)) return result(room);
      if (room.actions.some(action => dispatched.some(item => item.action.id === action.id) && (action.status === "failed" || action.status === "status_unknown"))) return result(await this.pause(room, "permanent_adapter: Action failed; review required"));
    }
    if (!executing(room)) return result(room);
    if (room.actions.some(action => action.status === "started")) return result(room);
    const exhausted = budgetReason(room);
    if (exhausted) return result(await this.pause(room, exhausted));

    let decision: ConvergenceDecision;
    try {
      const completed = room.actions.filter(action => action.status !== "planned" && action.status !== "started").length;
      decision = await facilitator.evaluate({ room, callKey: `${room.activeRun!.id}:evaluate:${room.usage.rounds}:${completed}` });
      this.validateConvergence(room, decision);
    } catch (error) { return result(await this.pause(await service.load(roomId), `${adapterCode(error)}: Invalid convergence decision`)) }
    const check = decision.type === "candidate" || !room.actions.some(action => action.status === "planned");
    const events: NewRoomEvent[] = room.status === "running" && check ? [{ type: "ConvergenceChecked", converged: decision.type === "candidate" }] : [];
    switch (decision.type) {
      case "continue": break;
      case "pause": events.push({ type: "RunPaused", reason: decision.reason }); break;
      case "request_input": events.push({ type: "InputRequested", prompt: decision.question }); break;
      case "request_approval": events.push({ type: "ApprovalRequested", actionId: decision.actionId }); break;
      case "candidate": events.push({ type: "CandidateProduced", actor: "facilitator", candidate: decision.candidate }); break;
    }
    // An empty batch has no optimistic append to detect concurrent user commands.
    return result(events.length === 0 ? await service.load(roomId) : await writeDerivedEvents(service, room, events));
  }

  private async complete(roomId: RoomId, action: Action, settled: PromiseSettledResult<PersonaActionResult>): Promise<void> {
    // Reload/retry only persistence of an already-obtained result, never adapter execution.
    for (let attempt = 0; attempt < 3; attempt++) {
      const room = await this.options.service.load(roomId);
      let events: readonly NewRoomEvent[];
      let usage = { ...zero, actions: 1 };
      try {
        if (settled.status === "rejected") throw settled.reason;
        usage = usageOf(settled.value);
        const outputs = outputEvents(room, action, settled.value);
        events = [...outputs, { type: "ActionCompleted", actionId: action.id, status: "succeeded", errorCode: null, usage }];
      } catch (error) {
        const code = adapterCode(error);
        events = [{ type: "ActionCompleted", actionId: action.id, status: code === "status_unknown" ? "status_unknown" : "failed", errorCode: code, usage }];
      }
      try { await writeDerivedEvents(this.options.service, room, events); return }
      catch (error) {
        if (!(error instanceof DomainError && error.code === "conflict") || attempt === 2) throw error;
      }
    }
  }

  private validateConvergence(room: Room, decision: ConvergenceDecision): void {
    adapterValid(decision && typeof decision === "object", "Invalid convergence decision");
    switch (decision.type) {
      case "continue": case "pause": adapterValid(text(decision.reason), "Missing convergence reason"); return;
      case "request_input": adapterValid(text(decision.question), "Missing question"); return;
      case "request_approval": adapterValid(text(decision.reason) && room.actions.some(action => action.id === decision.actionId && action.status === "planned"), "Invalid approval action"); return;
      case "candidate": {
        const candidate = decision.candidate;
        adapterValid(candidate && text(candidate.id) && candidate.roomId === room.id && text(candidate.deliverable) && candidate.acceptedAt === null && text(candidate.createdAt), "Invalid candidate");
        adapterValid(Array.isArray(candidate.checklist) && candidate.checklist.every(item => text(item.criterion) && typeof item.satisfied === "boolean" && text(item.evidence)) && room.acceptanceCriteria.every(criterion => candidate.checklist.some(item => item.criterion === criterion)), "Candidate must cover acceptance criteria");
        adapterValid(Array.isArray(candidate.decisions) && candidate.decisions.every(text) && Array.isArray(candidate.unresolvedIssues) && candidate.unresolvedIssues.every(text) && Array.isArray(candidate.messageIds) && candidate.messageIds.every(id => room.messages.some(message => message.id === id)) && Array.isArray(candidate.artifactIds) && candidate.artifactIds.every(text) && Array.isArray(candidate.sourceIds) && candidate.sourceIds.every(text), "Invalid candidate references");
        return;
      }
      default: throw new DomainError("permanent_adapter", "Unknown convergence decision");
    }
  }
}
