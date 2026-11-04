/**
 * Libellés d'une tâche tenus à jour depuis ses tickets Jira : état du ticket
 * (`Jira : En cours`), type (`Story`) et libellés Jira.
 *
 * Module pur : le worker lit l'état et applique le résultat. Seuls les
 * libellés posés par le plugin sont retirés quand le ticket change ; ceux
 * ajoutés à la main restent.
 */
import type { JiraIssueSummary } from "./jira-client.js";
import { labelColor, labelNames } from "./import.js";

/** Préfixe des libellés d'état. */
export const STATUS_LABEL_PREFIX = "Jira : ";

/** Couleurs des libellés d'état (palette Paperclip), par catégorie de statut Jira. */
const STATUS_COLORS: Record<string, string> = {
  new: "#3b82f6",
  indeterminate: "#f97316",
  done: "#22c55e",
};

/** Ce que le plugin a posé sur une tâche, pour pouvoir le retirer ensuite. */
export interface LabelSyncState {
  /** Noms appliqués, dans l'ordre. */
  appliedNames: string[];
  /** Ids des libellés posés par le plugin. */
  managedIds: string[];
}

/** Libellé à créer dans Paperclip (l'interface s'en charge, avec la session de l'utilisateur). */
export interface LabelRequest {
  name: string;
  color: string;
}

/** Libellés connus de la société : nom en minuscules → id. */
export type LabelRegistry = Record<string, string>;

export type SyncTicket = Pick<JiraIssueSummary, "statusName" | "statusCategoryKey" | "issueType" | "labels">;

export function statusLabelName(statusName: string): string {
  return `${STATUS_LABEL_PREFIX}${statusName.replace(/\s+/g, " ").trim()}`;
}

/** Noms voulus sur la tâche : pour chaque ticket, son état, son type et ses libellés Jira. */
export function desiredLabels(tickets: SyncTicket[]): LabelRequest[] {
  const colors = new Map<string, string>();
  const values: string[] = [];
  for (const ticket of tickets) {
    const status = statusLabelName(ticket.statusName);
    values.push(status);
    colors.set(status.toLowerCase(), STATUS_COLORS[ticket.statusCategoryKey] ?? "#6366f1");
    values.push(ticket.issueType ?? "", ...ticket.labels);
  }
  return labelNames(values).map((name) => ({ name, color: colors.get(name.toLowerCase()) ?? labelColor(name) }));
}

export interface LabelPlan {
  /** `true` : il faut écrire `labelIds` sur la tâche. */
  changed: boolean;
  labelIds: string[];
  /** Libellés absents de la société, à créer avant de pouvoir les poser. */
  missing: LabelRequest[];
  next: LabelSyncState;
}

/**
 * Calcule les libellés de la tâche. Rien ne change tant que les libellés
 * voulus sont ceux déjà appliqués : un libellé retiré à la main n'est remis
 * qu'au prochain changement du ticket, sans bataille avec l'utilisateur.
 */
export function planLabels(input: {
  currentIds: string[];
  previous: LabelSyncState | null;
  desired: LabelRequest[];
  registry: LabelRegistry;
}): LabelPlan {
  const { currentIds, previous, desired, registry } = input;
  const resolved: Array<{ name: string; id: string }> = [];
  const missing: LabelRequest[] = [];
  for (const label of desired) {
    const id = registry[label.name.toLowerCase()];
    if (id) resolved.push({ name: label.name, id });
    else missing.push(label);
  }
  const appliedNames = resolved.map((r) => r.name);

  if (previous && sameNames(previous.appliedNames, appliedNames)) {
    return { changed: false, labelIds: currentIds, missing, next: previous };
  }

  const previouslyManaged = new Set(previous?.managedIds ?? []);
  const desiredIds = [...new Set(resolved.map((r) => r.id))];
  const kept = currentIds.filter((id) => !previouslyManaged.has(id));
  const labelIds = [...new Set([...kept, ...desiredIds])];
  return {
    changed: !sameIds(labelIds, currentIds),
    labelIds,
    missing,
    next: { appliedNames, managedIds: desiredIds },
  };
}

/** Fusionne des demandes de création, sans doublon (casse ignorée). */
export function mergeRequests(existing: LabelRequest[], added: LabelRequest[]): LabelRequest[] {
  const byName = new Map<string, LabelRequest>();
  for (const request of [...existing, ...added]) {
    if (!byName.has(request.name.toLowerCase())) byName.set(request.name.toLowerCase(), request);
  }
  return [...byName.values()];
}

export function registryFrom(labels: Array<{ id?: unknown; name?: unknown }>): LabelRegistry {
  const registry: LabelRegistry = {};
  for (const label of labels) {
    if (typeof label?.id === "string" && typeof label.name === "string" && label.name.trim()) {
      registry[label.name.trim().toLowerCase()] = label.id;
    }
  }
  return registry;
}

function sameNames(a: string[], b: string[]): boolean {
  const left = new Set(a.map((n) => n.toLowerCase()));
  const right = new Set(b.map((n) => n.toLowerCase()));
  return left.size === right.size && [...left].every((n) => right.has(n));
}

function sameIds(a: string[], b: string[]): boolean {
  const right = new Set(b);
  return new Set(a).size === right.size && a.every((id) => right.has(id));
}
