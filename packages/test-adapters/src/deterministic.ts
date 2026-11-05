import { domainId } from "@teamroom/room-domain";
import type { ActionId, ArtifactId, RoomId, Usage } from "@teamroom/room-domain";
import type {
  ArtifactPort, ArtifactRead, ArtifactRef, ArtifactWrite, ClockPort, ConvergenceInput,
  FacilitatorPort, FacilitatorPlan, ConvergenceDecision, IdKind, IdPort, NotificationPort, PersonaActionInput, PersonaActionResult, PersonaPort,
  PlanInput, RoomNotification, ToolPort, ToolRequest, ToolResult, ToolReconciliation, UsageDelta, UsagePort,
} from "@teamroom/runtime-ports";
import { loadScenario, usageDeltaSchema } from "./scenario.js";
import type { Scenario } from "./scenario.js";

export class DeterministicClock implements ClockPort {
  private time: number;
  constructor(startTime: string) {
    this.time = Date.parse(startTime);
    if (!Number.isFinite(this.time)) throw new Error("Invalid deterministic start time");
  }
  now(): string { return new Date(this.time).toISOString() }
  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isFinite(new Date(this.time + milliseconds).getTime())) throw new Error("Invalid clock advance");
    this.time += milliseconds;
  }
}

export class DeterministicIdPort implements IdPort {
  private readonly counts = new Map<IdKind, number>();
  next(kind: IdKind): string {
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    return `${kind}-${String(count).padStart(4, "0")}`;
  }
}

interface Script<T> { readonly response: T; readonly advanceMs?: number | undefined }
/** Keys, rather than call order, select results. A replayed key advances time only once. */
class ScriptReader {
  private readonly seen = new Set<string>();
  constructor(private readonly clock: DeterministicClock) {}
  read<T>(operation: string, entries: Readonly<Record<string, Script<T>>>, key: string): T {
    if (!Object.hasOwn(entries, key)) throw new Error(`Missing ${operation} script for ${key}`);
    const entry = entries[key]!;
    const identity = JSON.stringify([operation, key]);
    if (!this.seen.has(identity)) {
      this.clock.advance(entry.advanceMs ?? 0);
      this.seen.add(identity);
    }
    return structuredClone(entry.response);
  }
}

export class DeterministicFacilitator implements FacilitatorPort {
  constructor(private readonly scenario: Scenario, private readonly reader: ScriptReader) {}
  async plan(input: PlanInput): Promise<FacilitatorPlan> { return this.reader.read("plan", this.scenario.plans, input.callKey) }
  async evaluate(input: ConvergenceInput): Promise<ConvergenceDecision> { return this.reader.read("evaluate", this.scenario.convergence, input.callKey) }
}
export class DeterministicPersona implements PersonaPort {
  constructor(private readonly scenario: Scenario, private readonly reader: ScriptReader) {}
  async act(input: PersonaActionInput): Promise<PersonaActionResult> { return this.reader.read("act", this.scenario.personaActions, input.callKey) }
}
export class DeterministicTool implements ToolPort {
  constructor(private readonly scenario: Scenario, private readonly reader: ScriptReader) {}
  async execute(input: ToolRequest): Promise<ToolResult> { return this.reader.read("execute", this.scenario.tools, input.callKey) }
  async reconcile(actionId: ActionId, idempotencyKey: string): Promise<ToolReconciliation> {
    const entry = this.scenario.reconciliations.find(item => item.actionId === actionId && item.idempotencyKey === idempotencyKey);
    if (!entry) throw new Error(`Missing reconciliation script for ${actionId} / ${idempotencyKey}`);
    return structuredClone(entry.response);
  }
}

export class InMemoryArtifactPort implements ArtifactPort {
  private readonly entries = new Map<ArtifactId, ArtifactRead>();
  constructor(private readonly ids: IdPort, private readonly clock: ClockPort) {}
  async put(input: ArtifactWrite): Promise<ArtifactRef> {
    const ref = { id: domainId.artifact(this.ids.next("artifact")), roomId: input.roomId, name: input.name, mediaType: input.mediaType, createdAt: this.clock.now() };
    this.entries.set(ref.id, { ...ref, content: input.content });
    return structuredClone(ref);
  }
  async get(id: ArtifactId): Promise<ArtifactRead | null> { return structuredClone(this.entries.get(id) ?? null) }
}
export class InMemoryUsagePort implements UsagePort {
  private readonly entries = new Map<RoomId, Usage>();
  async current(roomId: RoomId): Promise<Usage> { return { ...(this.entries.get(roomId) ?? { rounds: 0, actions: 0, tokens: 0, cost: 0 }) } }
  async charge(roomId: RoomId, delta: UsageDelta): Promise<Usage> {
    const valid = usageDeltaSchema.parse(delta);
    // Keep the read/update synchronous so concurrent callers cannot lose charges.
    const previous = this.entries.get(roomId) ?? { rounds: 0, actions: 0, tokens: 0, cost: 0 };
    const next = {
      rounds: previous.rounds + (valid.rounds ?? 0), actions: previous.actions + (valid.actions ?? 0),
      tokens: previous.tokens + (valid.tokens ?? 0), cost: previous.cost + (valid.cost ?? 0),
    };
    usageDeltaSchema.parse(next);
    this.entries.set(roomId, next);
    return { ...next };
  }
}
export class InMemoryNotificationPort implements NotificationPort {
  private readonly entries: RoomNotification[] = [];
  get published(): readonly RoomNotification[] { return structuredClone(this.entries) }
  async publish(notification: RoomNotification): Promise<void> { this.entries.push(structuredClone(notification)) }
}

/** Each factory call owns isolated fixture data, counters, time, and in-memory stores. */
export function createDeterministicAdapters(input: Scenario) {
  const scenario = loadScenario(input);
  const clock = new DeterministicClock(scenario.startTime);
  const ids = new DeterministicIdPort();
  const reader = new ScriptReader(clock);
  return {
    facilitator: new DeterministicFacilitator(scenario, reader), persona: new DeterministicPersona(scenario, reader),
    tool: new DeterministicTool(scenario, reader), clock, ids,
    artifacts: new InMemoryArtifactPort(ids, clock), usage: new InMemoryUsagePort(), notifications: new InMemoryNotificationPort(),
  };
}
