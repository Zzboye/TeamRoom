import { decide, domainId, DomainError, reduceRoom, type EventEnvelope, type NewRoomEvent, type Room, type RoomCommand, type RoomId } from "@teamroom/room-domain";
import type { RoomEventStore, SnapshotStore } from "./stores.js";

export interface RoomServiceOptions {
  readonly events: RoomEventStore;
  readonly snapshots?: SnapshotStore;
  readonly snapshotInterval?: number;
}
const writers = new WeakMap<RoomService, EventWriter>();
function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(item => immutableCopy(item))) as T;
  if (value !== null && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableCopy(item)]))) as T;
  return value;
}

class EventWriter {
  readonly interval: number;
  constructor(readonly options: RoomServiceOptions) {
    this.interval = options.snapshotInterval ?? 100;
    if (!Number.isSafeInteger(this.interval) || this.interval < 1) throw new DomainError("validation", "Snapshot interval must be a positive integer");
  }
  async load(roomId: RoomId): Promise<Room | null> {
    const snapshot = await this.options.snapshots?.load(roomId);
    const valid = snapshot?.schemaVersion === 1 && snapshot.roomId === roomId && snapshot.room?.id === roomId && snapshot.sequence === snapshot.room.streamVersion && Number.isSafeInteger(snapshot.sequence) && snapshot.sequence > 0;
    let room: Room | null = valid ? immutableCopy(snapshot.room) : null;
    for (const envelope of await this.options.events.load(roomId, room?.streamVersion)) room = reduceRoom(room, envelope);
    return room;
  }
  async commit(roomId: RoomId, room: Room | null, events: readonly NewRoomEvent[]): Promise<Room> {
    if (events.length === 0) {
      if (room === null) throw new DomainError("validation", "Room does not exist");
      return room;
    }
    // Validate the entire batch before persistence. Store metadata is authoritative on replay.
    let preview = room;
    for (const [index, event] of events.entries()) {
      const envelope: EventEnvelope = { event, roomId, sequence: (room?.streamVersion ?? 0) + index + 1, eventId: domainId.event(`preview-${index}`), causationId: domainId.command("preview"), schemaVersion: 1, occurredAt: room?.updatedAt ?? "1970-01-01T00:00:00.000Z" };
      preview = reduceRoom(preview, envelope);
    }
    const committed = await this.options.events.append(roomId, room?.streamVersion ?? 0, events);
    let next = room;
    for (const envelope of committed) next = reduceRoom(next, envelope);
    if (next === null || committed.length !== events.length) throw new DomainError("corrupt_data", "Store returned an incomplete committed batch");
    if (this.options.snapshots) {
      const snapshot = await this.options.snapshots.load(roomId);
      const lastSequence = snapshot?.schemaVersion === 1 && snapshot.roomId === roomId && snapshot.room.streamVersion === snapshot.sequence ? snapshot.sequence : 0;
      if (next.streamVersion - lastSequence >= this.interval) await this.options.snapshots.save({ schemaVersion: 1, roomId, sequence: next.streamVersion, room: next });
    }
    return next;
  }
}

export class RoomService {
  constructor(options: RoomServiceOptions) { writers.set(this, new EventWriter(options)) }
  async load(roomId: RoomId): Promise<Room> {
    const room = await writers.get(this)!.load(roomId);
    if (room === null) throw new DomainError("validation", "Room does not exist");
    return room;
  }
  async execute(command: RoomCommand): Promise<Room> {
    const writer = writers.get(this)!;
    const room = await writer.load(command.roomId);
    if ((room?.streamVersion ?? 0) !== command.expectedVersion) throw new DomainError("conflict", "Stale room stream version");
    const decision = decide(room, command);
    if (!decision.ok) throw decision.error;
    return writer.commit(command.roomId, room, decision.events);
  }
}

/** Package-internal runner boundary. Intentionally absent from the public barrel. */
export function writeDerivedEvents(service: RoomService, room: Room, events: readonly NewRoomEvent[]): Promise<Room> {
  return writers.get(service)!.commit(room.id, room, events);
}
