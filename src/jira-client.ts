/**
 * Client minimal de l'API REST Jira Cloud (v3), en lecture seule.
 *
 * Le `fetch` est injecté : en production c'est `ctx.http.fetch` (tracé et
 * contrôlé par l'hôte via la capacité `http.outbound`), en test un double.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface JiraCredentials {
  siteUrl: string;
  email: string;
  apiToken: string;
}

/** Champs d'un ticket qu'on accepte d'afficher dans Paperclip. */
export interface JiraIssueSummary {
  id: string;
  key: string;
  url: string;
  summary: string;
  issueType: string | null;
  statusName: string;
  /** `new` | `indeterminate` | `done` (ou `undefined` côté Jira). */
  statusCategoryKey: string;
  assignee: string | null;
  priority: string | null;
  updated: string | null;
}

export type JiraErrorKind = "auth" | "not_found" | "rate_limited" | "unreachable" | "bad_request";

export class JiraError extends Error {
  constructor(
    readonly kind: JiraErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

export const ISSUE_FIELDS = ["summary", "status", "issuetype", "assignee", "priority", "updated"] as const;

/** Taille de lot pour `key in (...)` : reste loin des limites de longueur JQL. */
export const SEARCH_BATCH_SIZE = 50;

export const ASSIGNED_TO_ME_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

export class JiraClient {
  private readonly authHeader: string;

  constructor(
    private readonly credentials: JiraCredentials,
    private readonly fetchImpl: FetchLike,
  ) {
    const raw = `${credentials.email}:${credentials.apiToken}`;
    this.authHeader = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  /** Vérifie les identifiants. Retourne le nom affiché du compte. */
  async myself(): Promise<{ displayName: string; accountId: string }> {
    const body = (await this.request("GET", "/rest/api/3/myself")) as Record<string, unknown>;
    return {
      displayName: typeof body.displayName === "string" ? body.displayName : "",
      accountId: typeof body.accountId === "string" ? body.accountId : "",
    };
  }

  async getIssue(key: string): Promise<JiraIssueSummary> {
    const query = new URLSearchParams({ fields: ISSUE_FIELDS.join(",") });
    const body = await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?${query}`);
    return this.toSummary(body);
  }

  /**
   * Récupère plusieurs tickets par clé, par lots. Les clés absentes du
   * résultat (supprimées, déplacées, ou invisibles pour le compte) ne sont
   * simplement pas dans la Map retournée.
   */
  async getIssuesByKeys(keys: string[]): Promise<Map<string, JiraIssueSummary>> {
    const found = new Map<string, JiraIssueSummary>();
    const unique = [...new Set(keys)];
    for (let start = 0; start < unique.length; start += SEARCH_BATCH_SIZE) {
      const batch = unique.slice(start, start + SEARCH_BATCH_SIZE);
      const issues = await this.searchJql(`key in (${batch.join(",")})`, batch.length);
      for (const issue of issues) found.set(issue.key, issue);
    }
    return found;
  }

  /** Recherche plein texte pour le formulaire de liaison. */
  async searchText(text: string, maxResults = 10): Promise<JiraIssueSummary[]> {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return this.searchJql(`text ~ "${escaped}" ORDER BY updated DESC`, maxResults);
  }

  /**
   * Suggestions pendant la frappe : API `issue/picker` de Jira (celle de sa
   * propre barre de recherche), qui gère les clés partielles et les débuts de
   * mots. Requête vide : tickets consultés récemment. Les statuts sont relus
   * en un seul appel JQL ; si Jira ne propose rien, repli sur une recherche
   * plein texte avec joker de fin (`conn*`).
   */
  async suggest(query: string, maxResults = 8): Promise<JiraIssueSummary[]> {
    const q = query.trim();
    const params = new URLSearchParams({ query: q, showSubTasks: "true", showSubTaskParent: "true" });
    const body = (await this.request("GET", `/rest/api/3/issue/picker?${params}`)) as {
      sections?: { issues?: { key?: unknown; summaryText?: unknown }[] }[];
    };
    const picked = new Map<string, string>();
    for (const section of body.sections ?? []) {
      for (const issue of section.issues ?? []) {
        if (typeof issue.key === "string" && issue.key && !picked.has(issue.key)) {
          picked.set(issue.key, typeof issue.summaryText === "string" ? issue.summaryText : "");
        }
      }
    }
    const keys = [...picked.keys()].slice(0, maxResults);
    if (keys.length === 0) return q.length >= 2 ? this.searchPrefix(q, maxResults) : [];

    let details: Map<string, JiraIssueSummary>;
    try {
      details = await this.getIssuesByKeys(keys);
    } catch (err) {
      if (!(err instanceof JiraError) || err.kind !== "bad_request") throw err;
      details = new Map();
    }
    return keys.map(
      (key) =>
        details.get(key) ?? {
          id: "",
          key,
          url: `${this.credentials.siteUrl}/browse/${encodeURIComponent(key)}`,
          summary: picked.get(key) ?? "",
          issueType: null,
          statusName: "Inconnu",
          statusCategoryKey: "undefined",
          assignee: null,
          priority: null,
          updated: null,
        },
    );
  }

  /** Recherche plein texte sur un début de mot. Une syntaxe refusée par Jira donne une liste vide. */
  private async searchPrefix(text: string, maxResults: number): Promise<JiraIssueSummary[]> {
    const cleaned = text.replace(/[\\"*?~^(){}[\]!+:&|-]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    try {
      return await this.searchJql(`text ~ "${cleaned}*" ORDER BY updated DESC`, maxResults);
    } catch (err) {
      if (err instanceof JiraError && err.kind === "bad_request") return [];
      throw err;
    }
  }

  /** Tickets non terminés assignés au compte du jeton, les plus récents d'abord. */
  async assignedToMe(maxResults = 30): Promise<JiraIssueSummary[]> {
    return this.searchJql(ASSIGNED_TO_ME_JQL, maxResults);
  }

  /** Ticket avec sa description (document ADF brut), pour créer une tâche. */
  async getIssueWithDescription(key: string): Promise<{ issue: JiraIssueSummary; description: unknown }> {
    const query = new URLSearchParams({ fields: [...ISSUE_FIELDS, "description"].join(",") });
    const body = (await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?${query}`)) as {
      fields?: { description?: unknown };
    };
    return { issue: this.toSummary(body), description: body?.fields?.description ?? null };
  }

  private async searchJql(jql: string, maxResults: number): Promise<JiraIssueSummary[]> {
    const body = (await this.request("POST", "/rest/api/3/search/jql", {
      jql,
      fields: [...ISSUE_FIELDS],
      maxResults,
    })) as { issues?: unknown[] };
    return (body.issues ?? []).map((issue) => this.toSummary(issue));
  }

  private async request(method: "GET" | "POST", path: string, json?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.credentials.siteUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...(json === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
    } catch (err) {
      throw new JiraError("unreachable", `Jira injoignable : ${errorMessage(err)}`);
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new JiraError("unreachable", "Réponse Jira illisible (JSON invalide).", response.status);
      }
    }

    const detail = await readErrorDetail(response);
    switch (response.status) {
      case 401:
      case 403:
        throw new JiraError("auth", `Jira refuse l'accès (${response.status})${detail}`, response.status);
      case 404:
        throw new JiraError("not_found", `Ticket introuvable ou non visible pour ce compte${detail}`, 404);
      case 400:
        throw new JiraError("bad_request", `Requête refusée par Jira${detail}`, 400);
      case 429:
        throw new JiraError(
          "rate_limited",
          "Jira limite le débit (429).",
          429,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      default:
        throw new JiraError(
          "unreachable",
          `Erreur Jira ${response.status}${detail}`,
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
    }
  }

  private toSummary(raw: unknown): JiraIssueSummary {
    const issue = (raw ?? {}) as Record<string, unknown>;
    const fields = (issue.fields ?? {}) as Record<string, any>;
    const key = String(issue.key ?? "");
    return {
      id: String(issue.id ?? ""),
      key,
      url: `${this.credentials.siteUrl}/browse/${encodeURIComponent(key)}`,
      summary: typeof fields.summary === "string" ? fields.summary : "",
      issueType: stringOrNull(fields.issuetype?.name),
      statusName: stringOrNull(fields.status?.name) ?? "Inconnu",
      statusCategoryKey: stringOrNull(fields.status?.statusCategory?.key) ?? "undefined",
      assignee: stringOrNull(fields.assignee?.displayName),
      priority: stringOrNull(fields.priority?.name),
      updated: stringOrNull(fields.updated),
    };
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { errorMessages?: unknown };
    const messages = Array.isArray(body.errorMessages) ? body.errorMessages.filter((m) => typeof m === "string") : [];
    return messages.length > 0 ? ` : ${messages.join(" ; ").slice(0, 300)}` : "";
  } catch {
    return "";
  }
}
