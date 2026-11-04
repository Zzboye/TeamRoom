import { domainId, DomainError, type Action, type BudgetLimits, type EventEnvelope, type NewRoomEvent, type RoomId } from "@teamroom/room-domain";
import type { RoomEventStore, RoomSnapshot, SnapshotStore } from "../src/stores.js";
import { RoomService } from "../src/room-service.js";

export const roomId = domainId.room("room-1");
export const time = "2026-11-02T00:00:00.000Z";
export const member = { id: domainId.member("member-1"), name: "Lead", role: "Lead", responsibilities: [], domainPerspective: "planning", communicationStyle: "clear", constraints: [], collaborationGuidance: [], isFacilitator: true, sourceTemplateId: null, sourceTemplateVersion: null } as const;
export const peer = { ...member, id: domainId.member("member-2"), name: "Peer", isFacilitator: false };
export class MemoryEvents implements RoomEventStore {
  events: EventEnvelope[] = [];
  appends = 0;
  loads: (number | undefined)[] = [];
  async load(id: RoomId, afterSequence?: number): Promise<readonly EventEnvelope[]> {
    this.loads.push(afterSequence);
    return this.events.filter(event => event.roomId === id && event.sequence > (afterSequence ?? 0));
  }
  async append(id: RoomId, expectedVersion: number, events: readonly NewRoomEvent[], causationId?: EventEnvelope["causationId"]): Promise<readonly EventEnvelope[]> {
    this.appends++;
    const version = this.events.filter(event => event.roomId === id).length;
    if (expectedVersion !== version) throw new DomainError("conflict", "Stale stream");
    const committed: EventEnvelope[] = events.map((event, index) => ({ event, roomId: id, sequence: version + index + 1, schemaVersion: 1, eventId: domainId.event(`event-${version + index + 1}`), causationId: causationId ?? ("actionId" in event ? event.actionId : domainId.command("test")), occurredAt: time }));
    this.events.push(...structuredClone(committed));
    return structuredClone(committed);
  }
}
export class MemorySnapshots implements SnapshotStore {
  saved: RoomSnapshot[] = [];
  async load(id: RoomId): Promise<RoomSnapshot | null> { return this.saved.findLast(snapshot => snapshot.roomId === id) ?? null }
  async save(snapshot: RoomSnapshot): Promise<void> { this.saved.push(structuredClone(snapshot)) }
}
export function fixture(snapshotInterval = 100) {
  const events = new MemoryEvents();
  const snapshots = new MemorySnapshots();
  const service = new RoomService({ events, snapshots, snapshotInterval });
  return { events, snapshots, service };
}
export function create(budget?: BudgetLimits) {
  return { type: "CreateRoom", commandId: domainId.command("create"), roomId, expectedVersion: 0, title: "Launch", task: "Plan launch", requirements: [], acceptanceCriteria: ["actionable"], backgroundPolicy: "pause_on_leave", ...(budget ? { budget } : {}) } as const;
}
export async function running(budget?: BudgetLimits) {
  const context = fixture();
  await context.service.execute(create(budget));
  await context.service.execute({ type: "ProposeTeam", commandId: domainId.command("team"), roomId, expectedVersion: 1, actor: "user", members: [member, peer] });
  await context.service.execute({ type: "ConfirmTeam", commandId: domainId.command("confirm"), roomId, expectedVersion: 2, actor: "user" });
  await context.service.execute({ type: "StartRun", commandId: domainId.command("start"), roomId, expectedVersion: 3, runId: domainId.run("run-1") });
  return context;
}
export function action(id = "action-1", position = 0, dependencies: Action["dependencies"] = []): Action {
  return { id: domainId.action(id), roomId, runId: domainId.run("run-1"), roundId: domainId.round("round-1"), memberId: peer.id, position, instruction: "Contribute", dependencies, idempotencyKey: id, status: "planned", errorCode: null, startedAt: null, completedAt: null };
}
