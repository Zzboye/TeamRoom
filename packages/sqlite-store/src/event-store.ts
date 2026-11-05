import { randomUUID } from "node:crypto";
import { assertEventSafeBoundary, buildHandoff, domainId, DomainError, reduceRoom, type EventEnvelope, type HandoffPackageV1, type NewRoomEvent, type Room, type RoomId } from "@teamroom/room-domain";
import type { RoomEventStore } from "@teamroom/room-engine";
import type { ClockPort, IdPort } from "@teamroom/runtime-ports";
import type { TeamRoomDatabase } from "./database.js";
import { canonicalJson, parseJson, storeError } from "./json.js";

export interface SqliteEventStoreOptions { readonly clock?: ClockPort; readonly ids?: IdPort }
interface EventRow { room_id: string; sequence: number; event_id: string; event_type: string; occurred_at: string; causation_id: string; schema_version: number; event_json: string }
const eventTypes = new Set(["RoomCreated", "TeamProposed", "TeamConfirmed", "RoomMemberEdited", "MessagePosted", "MessageLinked", "MemoryUpdated", "RunStarted", "RunResumed", "RoundPlanned", "ActionStarted", "ActionCompleted", "RunPaused", "RunPauseRequested", "InputRequested", "InputProvided", "ApprovalRequested", "ActionApproved", "ActionRejected", "WaveEvaluated", "ConvergenceChecked", "CandidateProduced", "CandidateAccepted", "CandidateRejected", "HandoffGenerated", "RoomArchived"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Reads the canonical log; projections and snapshots never determine its version. */
export function readEvents(db: TeamRoomDatabase, roomId: RoomId, afterSequence = 0): readonly EventEnvelope[] {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new DomainError("validation", "Invalid event cursor");
  const stream = db.prepare("SELECT version FROM room_streams WHERE room_id = ?").get(roomId) as { version: number } | undefined;
  if (!stream) {
    if (afterSequence > 0) throw new DomainError("corrupt_data", "Snapshot has no event stream");
    return [];
  }
  if (!Number.isSafeInteger(stream.version) || stream.version < afterSequence) throw new DomainError("corrupt_data", "Invalid stream version");
  const rows = db.prepare("SELECT * FROM room_events WHERE room_id = ? AND sequence > ? ORDER BY sequence").all(roomId, afterSequence) as EventRow[];
  if (rows.length !== stream.version - afterSequence) throw new DomainError("corrupt_data", "Incomplete event stream");
  return rows.map((row, index) => {
    const value = parseJson<EventEnvelope>(row.event_json);
    if (!value || value.schemaVersion !== 1 || value.roomId !== roomId || value.sequence !== afterSequence + index + 1 || value.sequence !== row.sequence || value.eventId !== row.event_id || value.occurredAt !== row.occurred_at || value.causationId !== row.causation_id || row.schema_version !== 1 || !text(value.eventId) || !text(value.causationId) || !text(value.occurredAt) || Number.isNaN(Date.parse(value.occurredAt)) || !value.event || !eventTypes.has(value.event.type) || value.event.type !== row.event_type) throw new DomainError("corrupt_data", "Invalid event envelope");
    return value;
  });
}

export function replay(events: readonly EventEnvelope[]): Room | null {
  try { return events.reduce<Room | null>((room, event) => reduceRoom(room, event), null) }
  catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("corrupt_data", "Invalid event payload") }
}

function project(db: TeamRoomDatabase, room: Room, events: readonly EventEnvelope[], handoffs: ReadonlyMap<number, HandoffPackageV1>): void {
  db.prepare("INSERT INTO rooms VALUES (?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET status = excluded.status, room_json = excluded.room_json").run(room.id, room.status, canonicalJson(room));
  // These tables are disposable views, rebuilt atomically from the log.
  for (const table of ["message_links", "messages", "memory_items", "room_members", "actions", "runs"]) db.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(room.id);
  for (const member of room.members) db.prepare("INSERT INTO room_members VALUES (?, ?, ?)").run(room.id, member.id, canonicalJson(member));
  for (const message of room.messages) db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run(room.id, message.id, message.sequence, canonicalJson(message));
  for (const [position, link] of (room.messageLinks ?? []).entries()) db.prepare("INSERT INTO message_links VALUES (?, ?, ?, ?)").run(room.id, link.messageId, position, canonicalJson(link.link));
  for (const item of room.memory) db.prepare("INSERT INTO memory_items VALUES (?, ?, ?, ?, ?)").run(room.id, item.id, item.memberId, item.kind, canonicalJson(item));
  if (room.activeRun) db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?)").run(room.id, room.activeRun.id, room.activeRun.status, canonicalJson(room.activeRun));
  for (const action of room.actions) db.prepare("INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?)").run(room.id, action.id, action.runId, action.status, action.idempotencyKey, canonicalJson(action));
  for (const envelope of events) {
    if (envelope.event.type === "CandidateProduced") db.prepare("INSERT INTO candidate_results VALUES (?, ?, ?) ON CONFLICT(room_id, candidate_id) DO UPDATE SET candidate_json = excluded.candidate_json").run(room.id, envelope.event.candidate.id, canonicalJson(envelope.event.candidate));
    if (envelope.event.type === "HandoffGenerated") db.prepare("INSERT INTO handoffs VALUES (?, ?, ?, ?)").run(room.id, envelope.event.handoffId, envelope.sequence, canonicalJson(handoffs.get(envelope.sequence)));
  }
  if (room.candidate) db.prepare("UPDATE candidate_results SET candidate_json = ? WHERE room_id = ? AND candidate_id = ?").run(canonicalJson(room.candidate), room.id, room.candidate.id);
}

export class SqliteEventStore implements RoomEventStore {
  constructor(private readonly db: TeamRoomDatabase, private readonly options: SqliteEventStoreOptions = {}) {}
  async load(roomId: RoomId, afterSequence = 0): Promise<readonly EventEnvelope[]> {
    try { return this.db.transaction(() => readEvents(this.db, roomId, afterSequence))() } catch (error) { return storeError(error) }
  }
  async append(roomId: RoomId, expectedVersion: number, events: readonly NewRoomEvent[], causationId?: EventEnvelope["causationId"]): Promise<readonly EventEnvelope[]> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new DomainError("validation", "Invalid expected version");
    canonicalJson(events); // Reject lossy non-finite JSON values before admission or writes.
    try {
      return this.db.transaction(() => {
        const stream = this.db.prepare("SELECT version FROM room_streams WHERE room_id = ?").get(roomId) as { version: number } | undefined;
        if ((stream?.version ?? 0) !== expectedVersion) throw new DomainError("conflict", "Stale room stream version");
        if (events.length === 0) return [];
        const previous = readEvents(this.db, roomId);
        let room = replay(previous);
        const knownEvents = new Set<string>(previous.map(item => item.eventId));
        const committed: EventEnvelope[] = [];
        const handoffs = new Map<number, HandoffPackageV1>();
        for (const [index, event] of events.entries()) {
          if (!event || !eventTypes.has(event.type)) throw new DomainError("corrupt_data", "Unknown event type");
          assertEventSafeBoundary(room, event);
          const eventId = domainId.event(this.options.ids?.next("event") ?? randomUUID());
          const envelope: EventEnvelope = { eventId, roomId, sequence: expectedVersion + index + 1, occurredAt: this.options.clock?.now() ?? new Date().toISOString(), causationId: causationId ?? ("actionId" in event ? event.actionId : domainId.command(this.options.ids?.next("command") ?? randomUUID())), schemaVersion: 1, event: structuredClone(event) };
          if (!text(envelope.causationId)) throw new DomainError("validation", "Invalid event causation");
          if (!text(envelope.occurredAt) || Number.isNaN(Date.parse(envelope.occurredAt))) throw new DomainError("validation", "Invalid event timestamp");
          if (event.type === "MemoryUpdated" && event.item && !event.item.provenance.every(id => knownEvents.has(id) || room?.messages.some(message => message.id === id))) throw new DomainError("validation", "Memory provenance must reference this room's committed messages or events");
          try { room = reduceRoom(room, envelope) } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("corrupt_data", "Invalid event payload") }
          if (event.type === "HandoffGenerated") handoffs.set(envelope.sequence, buildHandoff(room));
          knownEvents.add(eventId);
          committed.push(envelope);
        }
        this.db.prepare("INSERT INTO room_streams VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET version = excluded.version").run(roomId, expectedVersion + committed.length);
        const insert = this.db.prepare("INSERT INTO room_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const envelope of committed) insert.run(roomId, envelope.sequence, envelope.eventId, envelope.event.type, envelope.occurredAt, envelope.causationId, envelope.schemaVersion, canonicalJson(envelope));
        project(this.db, room!, committed, handoffs);
        return committed;
      }).immediate();
    } catch (error) { return storeError(error) }
  }
}
