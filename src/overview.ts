/**
 * Vue d'ensemble « Jira » : rapproche les tâches Paperclip des tickets Jira
 * que l'hôte a détectés dans ces tâches (URL dans le titre, la description,
 * les commentaires ou le document `jira`), et repère les écarts de statut.
 *
 * Module pur, sans dépendance Node : il est inclus dans le bundle navigateur.
 */

export const JIRA_PROVIDER_KEY = "jira";

/** Champs utiles d'une tâche renvoyée par `GET /api/companies/:id/issues`. */
export interface TaskLite {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  updatedAt?: string | null;
}

/** Sous-ensemble de `ExternalObjectSummaryItem` (hôte Paperclip). */
export interface ExternalObjectLite {
  providerKey: string;
  displayKey?: string | null;
  displayTitle: string | null;
  statusCategory: string;
  liveness: string;
  isTerminal: boolean;
}

export type GapKind = "ticket_done_task_open" | "task_done_ticket_open";

export interface OverviewRow {
  task: TaskLite;
  key: string;
  ticketTitle: string | null;
  ticketCategory: string;
  ticketTerminal: boolean;
  liveness: string;
  gap: GapKind | null;
}

const TASK_CLOSED = new Set(["done", "cancelled"]);
const TICKET_OPEN = new Set(["open", "running", "waiting", "blocked"]);
const UNRELIABLE = new Set(["auth_required", "unreachable", "not_found"]);

export function gapFor(taskStatus: string, ticket: Pick<ExternalObjectLite, "statusCategory" | "isTerminal" | "liveness">): GapKind | null {
  if (UNRELIABLE.has(ticket.liveness)) return null;
  const taskClosed = TASK_CLOSED.has(taskStatus);
  if (ticket.isTerminal && !taskClosed) return "ticket_done_task_open";
  if (taskStatus === "done" && !ticket.isTerminal && TICKET_OPEN.has(ticket.statusCategory)) return "task_done_ticket_open";
  return null;
}

export function buildOverview(
  tasks: TaskLite[],
  summaries: Record<string, { objects?: ExternalObjectLite[] } | undefined>,
): OverviewRow[] {
  const rows: OverviewRow[] = [];
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const object of summaries[task.id]?.objects ?? []) {
      if (object.providerKey !== JIRA_PROVIDER_KEY || !object.displayKey) continue;
      const key = object.displayKey.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        task,
        key,
        ticketTitle: object.displayTitle,
        ticketCategory: object.statusCategory,
        ticketTerminal: object.isTerminal,
        liveness: object.liveness,
        gap: gapFor(task.status, object),
      });
    }
  }
  // Écarts d'abord, puis tâches ouvertes, puis par clé.
  return rows.sort(
    (a, b) =>
      Number(b.gap !== null) - Number(a.gap !== null) ||
      Number(TASK_CLOSED.has(a.task.status)) - Number(TASK_CLOSED.has(b.task.status)) ||
      a.key.localeCompare(b.key, "en", { numeric: true }),
  );
}

/** Tâches déjà liées à chaque clé, pour éviter les doublons à l'import. */
export function tasksByKey(rows: OverviewRow[]): Map<string, TaskLite[]> {
  const map = new Map<string, TaskLite[]>();
  for (const row of rows) map.set(row.key, [...(map.get(row.key) ?? []), row.task]);
  return map;
}

/**
 * Identifiant de tâche (`ABC-12`) dans un chemin de l'interface Paperclip :
 * `/<préfixe>/issues/<identifiant>` (suivi éventuellement d'un sous-chemin).
 */
export function taskRefFromPath(pathname: string): string | null {
  const match = /^\/[^/]+\/issues\/([^/?#]+)/.exec(pathname);
  if (!match?.[1]) return null;
  const ref = decodeURIComponent(match[1]);
  return ref === "new" ? null : ref;
}
