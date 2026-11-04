/**
 * Configuration du plugin (une par société Paperclip).
 *
 * Le jeton d'API n'est jamais stocké en clair : la config ne contient qu'une
 * référence de secret Paperclip (`{ type: "secret_ref", secretId }`), résolue
 * à chaque appel via `ctx.secrets.resolve`.
 */
export interface JiraConfig {
  /** Origine du site Jira Cloud, sans slash final. Ex. `https://acme.atlassian.net`. */
  siteUrl: string;
  /** Hôte du site, en minuscules. Ex. `acme.atlassian.net`. */
  siteHost: string;
  /** E-mail du compte Atlassian propriétaire du jeton. */
  email: string;
  /** Référence de secret vers le jeton d'API Atlassian. */
  apiTokenRef: unknown;
  /**
   * Commande indiquée en tête d'une tâche créée depuis un ticket, suivie de la
   * clé (`/ticket ABC-123`). Chaîne vide : pas d'instruction.
   */
  importCommand: string;
  /**
   * Tenir les libellés des tâches à jour depuis leurs tickets : état
   * (`Jira : En cours`), type et libellés Jira. Activé par défaut.
   */
  syncLabels: boolean;
}

export const DEFAULT_IMPORT_COMMAND = "/ticket";

export type ConfigParseResult =
  | { ok: true; config: JiraConfig }
  | { ok: false; errors: string[] };

export function parseConfig(raw: Record<string, unknown> | null | undefined): ConfigParseResult {
  const errors: string[] = [];
  const source = raw ?? {};

  const siteUrlRaw = typeof source.siteUrl === "string" ? source.siteUrl.trim() : "";
  let siteUrl = "";
  let siteHost = "";
  if (!siteUrlRaw) {
    errors.push("L'URL du site Jira est obligatoire (ex. https://acme.atlassian.net).");
  } else {
    try {
      const url = new URL(siteUrlRaw);
      if (url.protocol !== "https:") {
        errors.push("L'URL du site Jira doit être en https.");
      }
      siteHost = url.hostname.toLowerCase();
      siteUrl = `https://${url.host.toLowerCase()}`;
    } catch {
      errors.push(`URL du site Jira invalide : ${siteUrlRaw}`);
    }
  }

  const email = typeof source.email === "string" ? source.email.trim() : "";
  if (!email) {
    errors.push("L'e-mail du compte Atlassian est obligatoire.");
  }

  const apiTokenRef = source.apiToken;
  if (!isSecretRef(apiTokenRef)) {
    errors.push("Le jeton d'API doit être choisi dans les secrets Paperclip.");
  }

  const importCommand = typeof source.importCommand === "string" ? source.importCommand.trim() : DEFAULT_IMPORT_COMMAND;

  const syncLabels = source.syncLabels !== false;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { siteUrl, siteHost, email, apiTokenRef, importCommand, syncLabels } };
}

function isSecretRef(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "secret_ref" && typeof record.secretId === "string";
}
