import type { JiraImportDetails, JiraIssueSummary, JiraSprint } from "./jira-client.js";

export const MAX_TITLE_LENGTH = 240;
/** Longueur maximale d'un nom de libellé Paperclip. */
export const MAX_LABEL_LENGTH = 48;

/** Priorités d'une tâche Paperclip. */
export type TaskPriority = "critical" | "high" | "medium" | "low";

export interface ImportedTaskDraft {
  key: string;
  url: string;
  title: string;
  description: string;
  /** Priorité Paperclip déduite de celle du ticket ; `null` : priorité par défaut de l'hôte. */
  priority: TaskPriority | null;
  /** Noms des libellés à poser sur la tâche : type du ticket puis libellés Jira, sans doublon. */
  labels: string[];
  /** Sprint du ticket : sert à choisir (ou créer) le projet de la tâche. */
  sprint: JiraSprint | null;
  /** Ticket parent (épopée, story d'une sous-tâche). */
  parentKey: string | null;
  /** Tâches Paperclip déjà liées au ticket parent, connues du plugin : candidates comme tâche parente. */
  parentTaskIds: string[];
  /** Derniers choix faits à la création (agent, objectif) : proposés par défaut. */
  preferences: ImportPreferences;
}

export interface ImportPreferences {
  agentId: string | null;
  goalId: string | null;
}

export const NO_PREFERENCES: ImportPreferences = { agentId: null, goalId: null };

/** Lit des préférences stockées, en ignorant ce qui n'a pas la bonne forme. */
export function asPreferences(value: unknown): ImportPreferences {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const id = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { agentId: id(record.agentId), goalId: id(record.goalId) };
}

const PRIORITY_BY_JIRA_NAME: Record<string, TaskPriority> = {
  highest: "critical",
  blocker: "critical",
  critical: "critical",
  urgent: "critical",
  high: "high",
  major: "high",
  medium: "medium",
  normal: "medium",
  low: "low",
  lowest: "low",
  minor: "low",
  trivial: "low",
};

/** Priorité Paperclip pour un nom de priorité Jira (schéma par défaut ou ancien schéma). Inconnue → `null`. */
export function priorityFromJira(name: string | null): TaskPriority | null {
  if (!name) return null;
  return PRIORITY_BY_JIRA_NAME[name.trim().toLowerCase()] ?? null;
}

/**
 * Instruction placée en tête de la tâche. `command` vient de la configuration
 * (`/ticket` par défaut) ; vide : pas d'instruction.
 */
export function importInstruction(command: string, key: string): string | null {
  const trimmed = command.trim();
  return trimmed ? `Lance \`${trimmed} ${key}\` sur ce ticket.` : null;
}

/**
 * Contenu d'une tâche Paperclip créée à partir d'un ticket Jira : titre,
 * instruction, propriétés du ticket, description. L'URL du ticket est dans la
 * description : l'hôte la détecte et affiche la pastille de statut dès la
 * création.
 */
export function draftTaskFromTicket(
  issue: JiraIssueSummary,
  descriptionMarkdown: string,
  details: JiraImportDetails = EMPTY_DETAILS,
  command = "",
): ImportedTaskDraft {
  const prefix = `[${issue.key}] `;
  const summary = issue.summary.replace(/\s+/g, " ").trim() || "Ticket Jira";
  const title = (prefix + summary).slice(0, MAX_TITLE_LENGTH);

  const parts: string[] = [];
  const instruction = importInstruction(command, issue.key);
  if (instruction) parts.push(instruction);
  parts.push(`Ticket Jira : [${issue.key}](${issue.url})`);
  parts.push(propertiesTable(issue, details));
  if (descriptionMarkdown.trim()) parts.push("---", descriptionMarkdown.trim());

  return {
    key: issue.key,
    url: issue.url,
    title,
    description: `${parts.join("\n\n")}\n`,
    priority: priorityFromJira(issue.priority),
    labels: labelNames([issue.issueType, ...issue.labels]),
    sprint: details.sprint,
    parentKey: details.parent?.key ?? null,
    parentTaskIds: [],
    preferences: NO_PREFERENCES,
  };
}

const EMPTY_DETAILS: JiraImportDetails = {
  reporter: null,
  components: [],
  fixVersions: [],
  parent: null,
  dueDate: null,
  created: null,
  sprint: null,
};

function propertiesTable(issue: JiraIssueSummary, details: JiraImportDetails): string {
  const parent = details.parent
    ? `[${details.parent.key}](${details.parent.url})${details.parent.summary ? ` ${details.parent.summary}` : ""}`
    : null;
  const rows: Array<[string, string | null]> = [
    ["Type", issue.issueType],
    ["Statut", issue.statusName],
    ["Priorité", issue.priority],
    ["Assigné", issue.assignee],
    ["Sprint", issue.sprint],
    ["Rapporteur", details.reporter],
    ["Parent", parent],
    ["Composants", details.components.join(", ") || null],
    ["Versions", details.fixVersions.join(", ") || null],
    ["Libellés", issue.labels.join(", ") || null],
    ["Échéance", details.dueDate],
    ["Créé le", details.created?.slice(0, 10) ?? null],
  ];
  const lines = rows.filter((row): row is [string, string] => Boolean(row[1])).map(([name, value]) => `| ${name} | ${cell(value)} |`);
  return ["| Propriété Jira | Valeur |", "|---|---|", ...lines].join("\n");
}

/** Une cellule de tableau markdown ne peut contenir ni `|` ni retour à la ligne. */
function cell(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/** Noms de libellés : espaces normalisés, tronqués à la limite de l'hôte, sans doublon (casse ignorée). */
export function labelNames(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    const name = (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/** Palette des couleurs de Paperclip (`PROJECT_COLORS` de `@paperclipai/shared`), pour les libellés créés. */
export const HOST_LABEL_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
] as const;

/** Couleur stable d'un libellé : le même nom donne toujours la même couleur. */
export function labelColor(name: string): string {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return HOST_LABEL_COLORS[hash % HOST_LABEL_COLORS.length]!;
}

export interface HostLabel {
  id: string;
  name: string;
}

/**
 * Associe chaque nom à un libellé existant de la société (casse ignorée).
 * Retourne les ids trouvés et les noms à créer, dans l'ordre demandé.
 */
export function matchLabels(names: string[], existing: HostLabel[]): { ids: string[]; missing: string[] } {
  const byName = new Map(existing.map((label) => [label.name.trim().toLowerCase(), label.id]));
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const id = byName.get(name.toLowerCase());
    if (id) ids.push(id);
    else missing.push(name);
  }
  return { ids, missing };
}

// ── Choix par défaut de la fiche de création ────────────────────────────

export interface HostProject {
  id: string;
  name: string;
  status?: string | null;
  archivedAt?: string | null;
  goalIds?: string[] | null;
}

export interface HostAgent {
  id: string;
  name: string;
  status?: string | null;
}

export interface HostGoal {
  id: string;
  title: string;
  status?: string | null;
}

/** Projet de la tâche : un projet existant, un projet à créer pour le sprint, ou aucun. */
export type ProjectChoice = { kind: "existing"; id: string } | { kind: "sprint" } | { kind: "none" };

function normalizeName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sprintNumber(value: string): string | null {
  return /\bsprint\s*#?\s*(\d+)\b/i.exec(value)?.[1] ?? null;
}

/**
 * Projet Paperclip du sprint : même nom (casse, accents et espaces ignorés),
 * sinon même numéro de sprint (« BO Sprint 21 » ↔ « Sprint 21 »), si ce
 * numéro désigne un seul projet. Les projets archivés sont ignorés.
 */
export function projectForSprint<P extends HostProject>(sprintName: string | null, projects: P[]): P | null {
  if (!sprintName) return null;
  const live = projects.filter((p) => !p.archivedAt);
  const wanted = normalizeName(sprintName);
  const exact = live.find((p) => normalizeName(p.name) === wanted);
  if (exact) return exact;
  const number = sprintNumber(sprintName);
  if (!number) return null;
  const sameNumber = live.filter((p) => sprintNumber(p.name) === number);
  return sameNumber.length === 1 ? sameNumber[0]! : null;
}

/** Corps de `POST /api/companies/:id/projects` pour le projet d'un sprint. */
export function projectBodyForSprint(sprint: JiraSprint): Record<string, unknown> {
  const status = sprint.state === "active" ? "in_progress" : sprint.state === "closed" ? "completed" : "planned";
  const period = [sprint.startDate && `du ${sprint.startDate}`, sprint.endDate && `au ${sprint.endDate}`].filter(Boolean).join(" ");
  const description = [sprint.goal, period && `Sprint Jira ${period}.`].filter(Boolean).join("\n\n");
  return {
    name: sprint.name,
    status,
    icon: "rocket",
    color: labelColor(sprint.name),
    ...(sprint.endDate ? { targetDate: sprint.endDate } : {}),
    ...(description ? { description } : {}),
  };
}

/** Un agent peut recevoir une tâche s'il n'est ni supprimé ni en attente de validation. */
export function assignableAgents<A extends HostAgent>(agents: A[]): A[] {
  return agents.filter((a) => !["terminated", "pending_approval"].includes(a.status ?? ""));
}

export interface ImportChoices {
  agentId: string | null;
  project: ProjectChoice;
  goalId: string | null;
  parentId: string | null;
}

/**
 * Choix proposés : le dernier agent choisi, le projet du sprint (à créer s'il
 * n'existe pas), l'objectif du projet sinon le dernier choisi, et la tâche du
 * ticket parent quand il y en a une.
 */
export function defaultImportChoices(input: {
  draft: Pick<ImportedTaskDraft, "sprint" | "preferences">;
  agents: HostAgent[];
  projects: HostProject[];
  goals: HostGoal[];
  parentTaskId: string | null;
}): ImportChoices {
  const { draft, agents, projects, goals } = input;
  const agentId = assignableAgents(agents).some((a) => a.id === draft.preferences.agentId) ? draft.preferences.agentId : null;
  const matched = projectForSprint(draft.sprint?.name ?? null, projects);
  const project: ProjectChoice = matched ? { kind: "existing", id: matched.id } : draft.sprint ? { kind: "sprint" } : { kind: "none" };
  return { agentId, project, goalId: goalForProject(matched, goals, draft.preferences.goalId), parentId: input.parentTaskId };
}

/** Objectif proposé pour un projet : le sien s'il en a un, sinon `fallback` s'il existe encore. */
export function goalForProject(project: HostProject | null, goals: HostGoal[], fallback: string | null): string | null {
  const known = (id: string | null | undefined) => (id && goals.some((g) => g.id === id) ? id : null);
  return known(project?.goalIds?.[0]) ?? known(fallback);
}
