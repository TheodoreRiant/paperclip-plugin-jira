import type { JiraIssueSummary } from "./jira-client.js";

export const MAX_TITLE_LENGTH = 240;

export interface ImportedTaskDraft {
  key: string;
  url: string;
  title: string;
  description: string;
}

/**
 * Contenu d'une tâche Paperclip créée à partir d'un ticket Jira. L'URL du
 * ticket est en tête de description : l'hôte la détecte et affiche la pastille
 * de statut dès la création.
 */
export function draftTaskFromTicket(issue: JiraIssueSummary, descriptionMarkdown: string): ImportedTaskDraft {
  const prefix = `[${issue.key}] `;
  const summary = issue.summary.replace(/\s+/g, " ").trim() || "Ticket Jira";
  const title = (prefix + summary).slice(0, MAX_TITLE_LENGTH);

  const meta = [issue.issueType, issue.priority && `priorité ${issue.priority}`, issue.statusName].filter(Boolean).join(" · ");
  const parts = [`Ticket Jira : [${issue.key}](${issue.url})${meta ? ` — ${meta}` : ""}`];
  if (descriptionMarkdown.trim()) parts.push("---", descriptionMarkdown.trim());

  return { key: issue.key, url: issue.url, title, description: `${parts.join("\n\n")}\n` };
}
