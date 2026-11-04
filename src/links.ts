import { browseUrl, issueKeyFromUrl } from "./jira-url.js";

/**
 * Les liens explicites (bouton « Lier à Jira ») sont stockés dans un document
 * de la tâche, de clé `jira`. Ce choix :
 * - garde une seule source de vérité, visible par les humains et les agents,
 *   avec l'historique des révisions de Paperclip ;
 * - fait apparaître la pastille de statut native : l'hôte analyse les URL des
 *   documents et les confie à `onDetectExternalObjects`.
 */
export const LINKS_DOCUMENT_KEY = "jira";
export const LINKS_DOCUMENT_TITLE = "Tickets Jira liés";

export interface LinkedTicket {
  key: string;
  summary?: string | null;
}

const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+/g;

/** Toutes les clés de tickets du site configuré citées dans un texte, sans doublon, dans l'ordre. */
export function issueKeysInText(text: string | null | undefined, siteHost: string): string[] {
  if (!text) return [];
  const keys: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const key = issueKeyFromUrl(match[0].replace(/[.,;:!?]+$/, ""), siteHost);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function renderLinksDocument(siteUrl: string, tickets: LinkedTicket[]): string {
  const lines = [
    `# ${LINKS_DOCUMENT_TITLE}`,
    "",
    "_Document géré par le plugin Jira : utilisez l'onglet « Jira » pour lier ou délier un ticket._",
    "",
  ];
  for (const ticket of tickets) {
    const summary = ticket.summary ? ` — ${oneLine(ticket.summary)}` : "";
    lines.push(`- [${ticket.key}](${browseUrl(siteUrl, ticket.key)})${summary}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Résumés déjà présents dans le document, pour ne pas les perdre à la réécriture. */
export function parseLinksDocument(body: string | null | undefined, siteHost: string): LinkedTicket[] {
  if (!body) return [];
  const tickets: LinkedTicket[] = [];
  for (const line of body.split("\n")) {
    const [key] = issueKeysInText(line, siteHost);
    if (!key || tickets.some((t) => t.key === key)) continue;
    const summary = /\)\s+—\s+(.+)$/.exec(line)?.[1]?.trim() ?? null;
    tickets.push({ key, summary });
  }
  return tickets;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
