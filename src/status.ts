import type {
  PluginExternalObjectResolveResult,
  PluginExternalObjectResolvedSnapshot,
} from "@paperclipai/plugin-sdk";
import { JiraError, type JiraIssueSummary } from "./jira-client.js";

type Category = PluginExternalObjectResolvedSnapshot["statusCategory"];
type Tone = PluginExternalObjectResolvedSnapshot["statusTone"];

/**
 * Correspondance des catégories de statut Jira (les seules stables d'un
 * workflow à l'autre) vers les catégories normalisées de Paperclip.
 */
const CATEGORY_MAP: Record<string, { category: Category; tone: Tone; terminal: boolean }> = {
  new: { category: "open", tone: "neutral", terminal: false },
  indeterminate: { category: "running", tone: "info", terminal: false },
  done: { category: "closed", tone: "success", terminal: true },
};

export const DEFAULT_TTL_SECONDS = 300;
export const DONE_TTL_SECONDS = 3600;

/** Longueur maximale du libellé de statut envoyé à l'hôte. */
export const MAX_STATUS_LABEL_LENGTH = 120;

/**
 * Libellé de la ligne « External objects » du panneau Propriétés : statut,
 * sprint et assigné (`En cours · Sprint 42 · Marie Dupont`). L'hôte l'affiche
 * après le résumé du ticket ; la ligne complète est dans l'infobulle.
 */
export function statusLabelFor(issue: Pick<JiraIssueSummary, "statusName" | "sprint" | "assignee">): string {
  const parts = [issue.statusName, issue.sprint, issue.assignee]
    .map((part) => (part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.join(" · ").slice(0, MAX_STATUS_LABEL_LENGTH);
}

export function snapshotFromIssue(issue: JiraIssueSummary): PluginExternalObjectResolvedSnapshot {
  const mapped = CATEGORY_MAP[issue.statusCategoryKey] ?? { category: "unknown", tone: "muted", terminal: false };
  return {
    displayKey: issue.key,
    displayTitle: issue.summary || null,
    iconKey: "jira",
    statusKey: issue.statusName.toLowerCase(),
    statusLabel: statusLabelFor(issue),
    statusCategory: mapped.category,
    statusTone: mapped.tone,
    isTerminal: mapped.terminal,
    remoteVersion: issue.updated,
    // Un ticket terminé bouge rarement : on le rafraîchit moins souvent.
    ttlSeconds: mapped.terminal ? DONE_TTL_SECONDS : DEFAULT_TTL_SECONDS,
    data: {
      key: issue.key,
      summary: issue.summary,
      issueType: issue.issueType,
      status: issue.statusName,
      assignee: issue.assignee,
      priority: issue.priority,
      sprint: issue.sprint,
      labels: issue.labels,
      updated: issue.updated,
      url: issue.url,
    },
  };
}

/** Ticket supprimé, déplacé ou invisible pour le compte configuré. */
export function notFoundSnapshot(key: string): PluginExternalObjectResolvedSnapshot {
  return {
    displayKey: key,
    statusKey: "not_found",
    statusLabel: "Introuvable",
    statusCategory: "unknown",
    statusTone: "muted",
    isTerminal: false,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    data: { key },
  };
}

export function resultFromError(err: unknown, key: string): PluginExternalObjectResolveResult {
  if (err instanceof JiraError) {
    switch (err.kind) {
      case "not_found":
        return { ok: true, snapshot: notFoundSnapshot(key) };
      case "auth":
        return { ok: false, liveness: "auth_required", errorCode: "jira_auth", errorMessage: err.message };
      case "rate_limited":
        return {
          ok: false,
          liveness: "unreachable",
          errorCode: "jira_rate_limited",
          errorMessage: err.message,
          retryAfterSeconds: err.retryAfterSeconds ?? 60,
        };
      case "bad_request":
      case "unreachable":
        return {
          ok: false,
          liveness: "unreachable",
          errorCode: err.kind === "bad_request" ? "jira_bad_request" : "jira_unreachable",
          errorMessage: err.message,
          ...(err.retryAfterSeconds != null ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
        };
    }
  }
  return {
    ok: false,
    liveness: "unreachable",
    errorCode: "jira_unexpected",
    errorMessage: err instanceof Error ? err.message : String(err),
  };
}
