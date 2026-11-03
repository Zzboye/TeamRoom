import { RoomService, type RoomServiceOptions } from "@teamroom/room-engine";
import { SqliteEventStore, type SqliteEventStoreOptions } from "./event-store.js";
import { SqliteSnapshotStore } from "./snapshot-store.js";
import type { TeamRoomDatabase } from "./database.js";

/** Room loads/commands always flow through event replay, never projection JSON. */
export class RoomRepository extends RoomService {
  constructor(options: RoomServiceOptions) { super(options) }
  static sqlite(db: TeamRoomDatabase, options: SqliteEventStoreOptions & { readonly snapshotInterval?: number } = {}): RoomRepository {
    return new RoomRepository({ events: new SqliteEventStore(db, options), snapshots: new SqliteSnapshotStore(db), ...(options.snapshotInterval === undefined ? {} : { snapshotInterval: options.snapshotInterval }) });
  }
}
