import type { JiraImportDetails, JiraIssueSummary } from "./jira-client.js";

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
  };
}

const EMPTY_DETAILS: JiraImportDetails = {
  reporter: null,
  components: [],
  fixVersions: [],
  parent: null,
  dueDate: null,
  created: null,
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
