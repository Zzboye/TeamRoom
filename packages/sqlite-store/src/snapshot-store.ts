import { createHash } from "node:crypto";
import { DomainError, type RoomId } from "@teamroom/room-domain";
import type { RoomSnapshot, SnapshotStore } from "@teamroom/room-engine";
import type { TeamRoomDatabase } from "./database.js";
import { readEvents, replay } from "./event-store.js";
import { canonicalJson, storeError } from "./json.js";

const checksum = (json: string) => createHash("sha256").update(json).digest("hex");
interface SnapshotRow { last_sequence: number; schema_version: number; snapshot_json: string; checksum: string }
function validSnapshot(value: RoomSnapshot, roomId: RoomId, sequence: number): boolean {
  const room = value?.room;
  return value?.schemaVersion === 1 && value.roomId === roomId && value.sequence === sequence && Number.isSafeInteger(sequence) && sequence > 0 && room?.id === roomId && room.streamVersion === sequence && typeof room.title === "string" && typeof room.task === "string" && Array.isArray(room.members) && Array.isArray(room.actions) && Array.isArray(room.messages) && Array.isArray(room.memory) && Array.isArray(room.requirements) && Array.isArray(room.acceptanceCriteria) && typeof room.usage === "object" && room.usage !== null && Number.isSafeInteger(room.latestMessageSequence) && typeof room.createdAt === "string" && typeof room.updatedAt === "string" && ["draft", "team_review", "ready", "running", "convergence_check", "paused", "awaiting_input", "awaiting_approval", "awaiting_acceptance", "completed", "archived"].includes(room.status) && (room.pauseRequested === undefined || typeof room.pauseRequested === "boolean");
}

export class SqliteSnapshotStore implements SnapshotStore {
  constructor(private readonly db: TeamRoomDatabase) {}
  async load(roomId: RoomId): Promise<RoomSnapshot | null> {
    try {
      return this.db.transaction(() => {
        const stream = this.db.prepare("SELECT version FROM room_streams WHERE room_id = ?").get(roomId) as { version: number } | undefined;
        if (!stream) return null;
        const rows = this.db.prepare("SELECT * FROM room_snapshots WHERE room_id = ? ORDER BY last_sequence DESC").all(roomId) as SnapshotRow[];
        for (const row of rows) {
          if (row.schema_version !== 1 || row.last_sequence > stream.version || checksum(row.snapshot_json) !== row.checksum) continue;
          try {
            const snapshot = JSON.parse(row.snapshot_json) as RoomSnapshot;
            if (validSnapshot(snapshot, roomId, row.last_sequence) && this.db.prepare("SELECT 1 FROM room_events WHERE room_id = ? AND sequence = ?").get(roomId, row.last_sequence)) return snapshot;
          } catch { /* Invalid snapshots are disposable; try the preceding one. */ }
        }
        return null;
      })();
    } catch (error) { return storeError(error) }
  }
  async save(snapshot: RoomSnapshot): Promise<void> {
    try {
      this.db.transaction(() => {
        if (!validSnapshot(snapshot, snapshot.roomId, snapshot.sequence)) throw new DomainError("corrupt_data", "Invalid snapshot");
        // Only verified event-derived state enters the cache. Loading checks the
        // bytes and metadata without replaying the prefix it is intended to skip.
        const events = readEvents(this.db, snapshot.roomId);
        const room = replay(events.filter(event => event.sequence <= snapshot.sequence));
        if (canonicalJson(room) !== canonicalJson(snapshot.room)) throw new DomainError("corrupt_data", "Snapshot differs from its event prefix");
        const json = canonicalJson(snapshot);
        this.db.prepare("INSERT INTO room_snapshots VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_id, last_sequence) DO UPDATE SET schema_version = excluded.schema_version, snapshot_json = excluded.snapshot_json, checksum = excluded.checksum").run(snapshot.roomId, snapshot.sequence, snapshot.schemaVersion, json, checksum(json));
      }).immediate();
    } catch (error) { storeError(error) }
  }
}
