import { RoomService, type RoomServiceOptions } from "@teamroom/room-engine";
import { SqliteEventStore, type SqliteEventStoreOptions } from "./event-store.js";
import { SqliteSnapshotStore } from "./snapshot-store.js";
import type { TeamRoomDatabase } from "./database.js";
import { domainId, type Room } from "@teamroom/room-domain";

/** Room loads/commands always flow through event replay, never projection JSON. */
export class RoomRepository extends RoomService {
  constructor(options: RoomServiceOptions, private readonly database?: TeamRoomDatabase) { super(options) }
  async list(): Promise<readonly Room[]> {
    if (!this.database) throw new Error("Room listing requires a repository database");
    const rows = this.database.prepare("SELECT room_id FROM room_streams ORDER BY room_id").all() as { room_id: string }[];
    return Promise.all(rows.map(row => this.load(domainId.room(row.room_id))));
  }
  static sqlite(db: TeamRoomDatabase, options: SqliteEventStoreOptions & { readonly snapshotInterval?: number } = {}): RoomRepository {
    return new RoomRepository({ events: new SqliteEventStore(db, options), snapshots: new SqliteSnapshotStore(db), ...(options.snapshotInterval === undefined ? {} : { snapshotInterval: options.snapshotInterval }) }, db);
  }
}
