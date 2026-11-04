/**
 * Reconnaissance des tickets Jira dans une URL ou une saisie libre.
 *
 * L'hôte Paperclip retire déjà query string et fragment des URL avant de les
 * transmettre au plugin : on ne s'appuie donc que sur le chemin.
 */

/** Clé de ticket Jira : projet (lettre puis lettres/chiffres/_) + numéro. */
const ISSUE_KEY_SOURCE = "[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]*";
const ISSUE_KEY_RE = new RegExp(`^${ISSUE_KEY_SOURCE}$`);

/**
 * Chemins Jira Cloud qui désignent un ticket précis :
 * - `/browse/ABC-123`
 * - `/jira/software/projects/ABC/issues/ABC-123`
 * - `/jira/software/c/projects/ABC/issues/ABC-123`
 * - `/jira/servicedesk/projects/SD/issues/SD-4`
 * - `/jira/core/projects/ABC/issues/ABC-123`
 */
const PATH_PATTERNS: RegExp[] = [
  new RegExp(`^/browse/(${ISSUE_KEY_SOURCE})/?$`, "i"),
  new RegExp(`^/jira/(?:software(?:/c)?|servicedesk|core|business)/projects/[^/]+/issues/(${ISSUE_KEY_SOURCE})/?$`, "i"),
];

export function normalizeIssueKey(value: string): string | null {
  const key = value.trim().toUpperCase();
  return ISSUE_KEY_RE.test(key) ? key : null;
}

/**
 * Extrait la clé d'un ticket d'une URL Jira appartenant au site configuré.
 * Retourne `null` pour tout autre hôte ou chemin (tableaux, filtres…).
 */
export function issueKeyFromUrl(rawUrl: string, siteHost: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() !== siteHost.toLowerCase()) return null;

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  for (const pattern of PATH_PATTERNS) {
    const match = pattern.exec(path);
    if (match?.[1]) return normalizeIssueKey(match[1]);
  }
  return null;
}

/**
 * Interprète la saisie de l'utilisateur dans le formulaire « Lier à Jira » :
 * une clé (`abc-123`) ou une URL du site configuré. Sinon `null` (texte libre,
 * à traiter comme une recherche).
 */
export function issueKeyFromInput(input: string, siteHost: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  return normalizeIssueKey(trimmed) ?? issueKeyFromUrl(trimmed, siteHost);
}

export function browseUrl(siteUrl: string, key: string): string {
  return `${siteUrl}/browse/${encodeURIComponent(key)}`;
}
