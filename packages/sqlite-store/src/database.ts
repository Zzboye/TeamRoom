import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { DomainError } from "@teamroom/room-domain";

export type TeamRoomDatabase = Database.Database;

export function openTeamRoomDatabase(path: string): TeamRoomDatabase {
  const db = new Database(path);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      const version = db.pragma("user_version", { simple: true });
      if (version === 0) {
        db.exec(readFileSync(new URL("../migrations/001-initial.sql", import.meta.url), "utf8"));
        db.prepare("INSERT INTO schema_migrations VALUES (1, ?)").run(new Date().toISOString());
        db.pragma("user_version = 1");
      } else if (version !== 1) throw new DomainError("corrupt_data", "Unsupported database schema");
    }).immediate();
    return db;
  } catch (error) { db.close(); throw error }
}
