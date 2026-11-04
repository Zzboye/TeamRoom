import { DomainError, snapshotTeam, type PersonaTemplate, type PersonaTemplateId, type TeamTemplate, type TeamTemplateId } from "@teamroom/room-domain";
import type { TemplateStore } from "@teamroom/room-engine";
import type { TeamRoomDatabase } from "./database.js";
import { canonicalJson, parseJson, storeError } from "./json.js";

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function personaValid(value: PersonaTemplate): boolean {
  return !!value && text(value.id) && Number.isSafeInteger(value.version) && value.version > 0 && text(value.name) && text(value.role) && typeof value.domainPerspective === "string" && typeof value.communicationStyle === "string" && strings(value.responsibilities) && strings(value.constraints) && strings(value.collaborationGuidance);
}
function teamValid(value: TeamTemplate): boolean {
  try {
    if (!value || !text(value.id) || !text(value.name) || !Array.isArray(value.members) || !value.members.every(item => item && text(item.memberId) && typeof item.isFacilitator === "boolean" && personaValid(item.persona))) return false;
    snapshotTeam(value);
    return true;
  } catch { return false }
}
export class SqliteTemplateStore implements TemplateStore {
  constructor(private readonly db: TeamRoomDatabase) {}
  async listPersonas(): Promise<readonly PersonaTemplate[]> { return this.list("persona_templates", personaValid) }
  async listTeams(): Promise<readonly TeamTemplate[]> { return this.list("team_templates", teamValid) }
  async getPersona(id: PersonaTemplateId, version: number): Promise<PersonaTemplate | null> { return this.get("persona_templates", id, version, personaValid) }
  async getTeam(id: TeamTemplateId, version: number): Promise<TeamTemplate | null> { return this.get("team_templates", id, version, teamValid) }
  async putPersona(template: PersonaTemplate): Promise<void> { this.put("persona_templates", template, personaValid) }
  async putTeam(template: TeamTemplate): Promise<void> { this.put("team_templates", template, teamValid) }
  private list<T extends PersonaTemplate | TeamTemplate>(table: string, valid: (value: T) => boolean): readonly T[] {
    const rows = this.db.prepare(`SELECT template_id, version FROM ${table} ORDER BY template_id, version`).all() as { template_id: string; version: number }[];
    return rows.map(row => this.get(table, row.template_id, row.version, valid)!);
  }
  private get<T extends PersonaTemplate | TeamTemplate>(table: string, id: string, version: number, valid: (value: T) => boolean): T | null {
    const row = this.db.prepare(`SELECT template_json FROM ${table} WHERE template_id = ? AND version = ?`).get(id, version) as { template_json: string } | undefined;
    if (!row) return null;
    const template = parseJson<T>(row.template_json);
    if (!valid(template) || template.id !== id || template.version !== version) throw new DomainError("corrupt_data", "Invalid persisted template");
    return template;
  }
  private put<T extends PersonaTemplate | TeamTemplate>(table: string, template: T, valid: (value: T) => boolean): void {
    if (!valid(template)) throw new DomainError("validation", "Invalid template");
    try { this.db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(template.id, template.version, canonicalJson(template)) }
    catch (error) {
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") throw new DomainError("conflict", "Template version already exists");
      storeError(error);
    }
  }
}
