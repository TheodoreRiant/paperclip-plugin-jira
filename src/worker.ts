import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginExternalObjectDetection,
  type PluginExternalObjectResolveResult,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { parseConfig, type JiraConfig } from "./config.js";
import { JiraClient, JiraError, type FetchLike, type JiraIssueSummary } from "./jira-client.js";
import { issueKeyFromInput, issueKeyFromUrl, normalizeIssueKey } from "./jira-url.js";
import { adfToMarkdown } from "./adf.js";
import { draftTaskFromTicket, type ImportedTaskDraft } from "./import.js";
import {
  LINKS_DOCUMENT_KEY,
  LINKS_DOCUMENT_TITLE,
  issueKeysInText,
  parseLinksDocument,
  renderLinksDocument,
  type LinkedTicket,
} from "./links.js";
import { OBJECT_TYPE, PROVIDER_KEY, TOOL_GET_ISSUE } from "./manifest.js";
import { notFoundSnapshot, resultFromError, snapshotFromIssue } from "./status.js";

/** Types échangés avec l'UI (dupliqués côté `ui/` pour garder le bundle navigateur sans dépendance Node). */
export interface TicketView {
  key: string;
  url: string;
  issue: JiraIssueSummary | null;
  error: string | null;
}

export interface IssueLinksData {
  configured: boolean;
  configErrors: string[];
  siteUrl: string | null;
  /** Tickets liés explicitement (document `jira`). */
  linked: TicketView[];
  /** Tickets cités par URL dans le titre ou la description, sans lien explicite. */
  mentioned: TicketView[];
  documentRevisionId: string | null;
}

/** Contenu du document `jira` à écrire par l'UI (`null` = supprimer le document). */
export interface LinkDocumentChange {
  key: string;
  issue: JiraIssueSummary | null;
  alreadyLinked: boolean;
  documentKey: string;
  documentTitle: string;
  documentBody: string | null;
  baseRevisionId: string | null;
}

export interface TicketsData {
  configured: boolean;
  configErrors: string[];
  siteUrl: string | null;
  tickets: Record<string, TicketView>;
}

export type { ImportedTaskDraft };

/** Borne le nombre de tickets relus par affichage de la page. */
export const MAX_PAGE_KEYS = 500;

function isString(value: string | null): value is string {
  return value !== null;
}

let pluginCtx: PluginContext | null = null;

function ctx(): PluginContext {
  if (!pluginCtx) throw new Error("Plugin Jira non initialisé.");
  return pluginCtx;
}

async function loadConfig(companyId: string): Promise<JiraConfig> {
  const parsed = parseConfig(await ctx().config.get(companyId));
  if (!parsed.ok) throw new ConfigError(parsed.errors);
  return parsed.config;
}

class ConfigError extends Error {
  constructor(readonly errors: string[]) {
    super(`Plugin Jira mal configuré : ${errors.join(" ")}`);
    this.name = "ConfigError";
  }
}

async function clientFor(companyId: string, config?: JiraConfig): Promise<{ client: JiraClient; config: JiraConfig }> {
  const resolvedConfig = config ?? (await loadConfig(companyId));
  const apiToken = await ctx().secrets.resolve(resolvedConfig.apiTokenRef as never, {
    companyId,
    configPath: "apiToken",
  });
  const fetchImpl: FetchLike = (url, init) => ctx().http.fetch(url, init);
  return {
    client: new JiraClient({ siteUrl: resolvedConfig.siteUrl, email: resolvedConfig.email, apiToken }, fetchImpl),
    config: resolvedConfig,
  };
}

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Paramètre manquant : ${name}`);
  }
  return value.trim();
}

function describeError(err: unknown): string {
  if (err instanceof JiraError || err instanceof ConfigError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

async function readLinkedTickets(issueId: string, companyId: string, siteHost: string) {
  const doc = await ctx().issues.documents.get(issueId, LINKS_DOCUMENT_KEY, companyId);
  return {
    tickets: parseLinksDocument(doc?.body, siteHost),
    revisionId: doc?.latestRevisionId ?? null,
  };
}

/**
 * Lit les tickets en un minimum d'appels. Si la recherche groupée est refusée
 * (JQL `key in (...)` rejette une clé d'un projet inexistant), on retombe sur
 * des lectures unitaires pour isoler la clé fautive.
 */
async function fetchTickets(client: JiraClient, siteUrl: string, keys: string[]): Promise<Map<string, TicketView>> {
  const views = new Map<string, TicketView>();
  if (keys.length === 0) return views;
  const urlFor = (key: string) => `${siteUrl}/browse/${encodeURIComponent(key)}`;

  try {
    const found = await client.getIssuesByKeys(keys);
    for (const key of keys) {
      const issue = found.get(key) ?? null;
      views.set(key, { key, url: urlFor(key), issue, error: issue ? null : "Ticket introuvable ou non visible." });
    }
    return views;
  } catch (err) {
    if (!(err instanceof JiraError && err.kind === "bad_request")) throw err;
  }

  for (const key of keys) {
    try {
      const issue = await client.getIssue(key);
      views.set(key, { key, url: issue.url, issue, error: null });
    } catch (err) {
      if (err instanceof JiraError && err.kind !== "not_found" && err.kind !== "bad_request") throw err;
      views.set(key, { key, url: urlFor(key), issue: null, error: "Ticket introuvable ou non visible." });
    }
  }
  return views;
}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(context) {
    pluginCtx = context;

    // ── Données de l'onglet « Jira » ────────────────────────────────────
    context.data.register("issue-links", async (params): Promise<IssueLinksData> => {
      const companyId = requireString(params, "companyId");
      // Le bouton de la barre du haut interroge aussi hors tâche : pas de tâche, pas de ticket.
      const issueId = typeof params.issueId === "string" ? params.issueId.trim() : "";

      const parsed = parseConfig(await context.config.get(companyId));
      if (!issueId && parsed.ok) {
        return { configured: true, configErrors: [], siteUrl: parsed.config.siteUrl, linked: [], mentioned: [], documentRevisionId: null };
      }
      if (!parsed.ok) {
        return {
          configured: false,
          configErrors: parsed.errors,
          siteUrl: null,
          linked: [],
          mentioned: [],
          documentRevisionId: null,
        };
      }
      const config = parsed.config;

      const [{ tickets, revisionId }, issue] = await Promise.all([
        readLinkedTickets(issueId, companyId, config.siteHost),
        context.issues.get(issueId, companyId),
      ]);
      const linkedKeys = tickets.map((t) => t.key);
      const mentionedKeys = issueKeysInText(`${issue?.title ?? ""}\n${issue?.description ?? ""}`, config.siteHost).filter(
        (key) => !linkedKeys.includes(key),
      );

      const { client } = await clientFor(companyId, config);
      const views = await fetchTickets(client, config.siteUrl, [...linkedKeys, ...mentionedKeys]);
      const pick = (key: string) => views.get(key) ?? { key, url: `${config.siteUrl}/browse/${key}`, issue: null, error: null };

      return {
        configured: true,
        configErrors: [],
        siteUrl: config.siteUrl,
        linked: linkedKeys.map(pick),
        mentioned: mentionedKeys.map(pick),
        documentRevisionId: revisionId,
      };
    });

    // ── Recherche pour le formulaire de liaison ─────────────────────────
    context.actions.register("search", async (params, actionContext) => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const text = requireString(params, "text");
      const { client, config } = await clientFor(companyId);
      const key = issueKeyFromInput(text, config.siteHost);
      if (key) {
        try {
          return { results: [await client.getIssue(key)] };
        } catch (err) {
          if (err instanceof JiraError && err.kind === "not_found") return { results: [] };
          throw err;
        }
      }
      return { results: await client.searchText(text) };
    });

    // ── Suggestions pendant la frappe (vide : tickets récents) ──────────
    context.actions.register("suggest", async (params, actionContext) => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const query = typeof params.query === "string" ? params.query.trim().slice(0, 200) : "";
      const { client, config } = await clientFor(companyId);
      const key = issueKeyFromInput(query, config.siteHost);
      // Clé complète ou URL : le ticket exact en tête, s'il existe.
      const exact = key
        ? await client.getIssue(key).catch((err: unknown) => {
            if (err instanceof JiraError && err.kind === "not_found") return null;
            throw err;
          })
        : null;
      if (exact && /^https?:\/\//i.test(query)) return { recent: false, results: [exact] };
      const suggested = await client.suggest(query);
      const results = exact ? [exact, ...suggested.filter((i) => i.key !== exact.key)] : suggested;
      return { recent: query === "", results: results.slice(0, 8) };
    });

    // ── Préparer un lien : valide le ticket et calcule le nouveau document ─
    context.actions.register("prepare-link", async (params, actionContext): Promise<LinkDocumentChange> => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const issueId = requireString(params, "issueId");
      const input = requireString(params, "input");
      const { client, config } = await clientFor(companyId);

      const key = issueKeyFromInput(input, config.siteHost);
      if (!key) {
        throw new Error(`« ${input} » n'est ni une clé Jira (ex. ABC-123) ni une URL de ${config.siteHost}.`);
      }
      let issue: JiraIssueSummary;
      try {
        issue = await client.getIssue(key);
      } catch (err) {
        throw new Error(describeError(err));
      }

      const { tickets, revisionId } = await readLinkedTickets(issueId, companyId, config.siteHost);
      const alreadyLinked = tickets.some((t) => t.key === issue.key);
      const next: LinkedTicket[] = alreadyLinked
        ? tickets
        : [...tickets, { key: issue.key, summary: issue.summary }];

      return {
        key: issue.key,
        issue,
        alreadyLinked,
        documentKey: LINKS_DOCUMENT_KEY,
        documentTitle: LINKS_DOCUMENT_TITLE,
        documentBody: alreadyLinked ? null : renderLinksDocument(config.siteUrl, next),
        baseRevisionId: revisionId,
      };
    });

    // ── Préparer un délien ───────────────────────────────────────────────
    context.actions.register("prepare-unlink", async (params, actionContext): Promise<LinkDocumentChange> => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const issueId = requireString(params, "issueId");
      const key = requireString(params, "key").toUpperCase();
      const config = await loadConfig(companyId);

      const { tickets, revisionId } = await readLinkedTickets(issueId, companyId, config.siteHost);
      const next = tickets.filter((t) => t.key !== key);
      return {
        key,
        issue: null,
        alreadyLinked: tickets.length !== next.length,
        documentKey: LINKS_DOCUMENT_KEY,
        documentTitle: LINKS_DOCUMENT_TITLE,
        documentBody: next.length > 0 ? renderLinksDocument(config.siteUrl, next) : null,
        baseRevisionId: revisionId,
      };
    });

    // ── Page « Jira » : statut détaillé des tickets listés ────────────────
    context.data.register("tickets", async (params): Promise<TicketsData> => {
      const companyId = requireString(params, "companyId");
      const rawKeys = Array.isArray(params.keys) ? params.keys : [];
      const parsed = parseConfig(await context.config.get(companyId));
      if (!parsed.ok) return { configured: false, configErrors: parsed.errors, siteUrl: null, tickets: {} };
      const keys = [
        ...new Set(rawKeys.flatMap((k) => (typeof k === "string" ? [normalizeIssueKey(k)] : [])).filter(isString)),
      ].slice(0, MAX_PAGE_KEYS);
      const { client, config } = await clientFor(companyId, parsed.config);
      const views = await fetchTickets(client, config.siteUrl, keys);
      return { configured: true, configErrors: [], siteUrl: config.siteUrl, tickets: Object.fromEntries(views) };
    });

    // ── Import : mes tickets assignés ────────────────────────────────────
    context.actions.register("my-tickets", async (params, actionContext) => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const { client } = await clientFor(companyId);
      try {
        return { results: await client.assignedToMe() };
      } catch (err) {
        throw new Error(describeError(err));
      }
    });

    // ── Import : contenu de la tâche à créer depuis un ticket ────────────
    context.actions.register("prepare-import", async (params, actionContext): Promise<ImportedTaskDraft> => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const input = requireString(params, "input");
      const { client, config } = await clientFor(companyId);
      const key = issueKeyFromInput(input, config.siteHost);
      if (!key) throw new Error(`« ${input} » n'est ni une clé Jira (ex. ABC-123) ni une URL de ${config.siteHost}.`);
      try {
        const { issue, description } = await client.getIssueWithDescription(key);
        return draftTaskFromTicket(issue, adfToMarkdown(description));
      } catch (err) {
        throw new Error(describeError(err));
      }
    });

    // ── Outil agent ──────────────────────────────────────────────────────
    const toolDeclaration = context.manifest.tools?.find((t) => t.name === TOOL_GET_ISSUE);
    if (toolDeclaration) {
      context.tools.register(TOOL_GET_ISSUE, toolDeclaration, async (rawParams, runCtx): Promise<ToolResult> => {
        const params = (rawParams ?? {}) as { key?: unknown; issueId?: unknown };
        try {
          const { client, config } = await clientFor(runCtx.companyId);
          let keys: string[];
          if (typeof params.key === "string" && params.key.trim()) {
            const key = issueKeyFromInput(params.key, config.siteHost);
            if (!key) return { error: `Clé Jira invalide : ${params.key}` };
            keys = [key];
          } else if (typeof params.issueId === "string" && params.issueId.trim()) {
            const issueId = params.issueId.trim();
            const [{ tickets }, issue] = await Promise.all([
              readLinkedTickets(issueId, runCtx.companyId, config.siteHost),
              context.issues.get(issueId, runCtx.companyId),
            ]);
            if (!issue) return { error: `Tâche introuvable : ${issueId}` };
            keys = [
              ...new Set([
                ...tickets.map((t) => t.key),
                ...issueKeysInText(`${issue.title}\n${issue.description ?? ""}`, config.siteHost),
              ]),
            ];
            if (keys.length === 0) return { content: "Aucun ticket Jira lié à cette tâche.", data: { tickets: [] } };
          } else {
            return { error: "Préciser `key` (ex. ABC-123) ou `issueId`." };
          }

          const views = [...(await fetchTickets(client, config.siteUrl, keys)).values()];
          return { content: views.map(formatTicketForAgent).join("\n\n"), data: { tickets: views } };
        } catch (err) {
          return { error: describeError(err) };
        }
      });
    }
  },

  async onHealth() {
    return { status: "ok" };
  },

  async onValidateConfig(rawConfig) {
    const parsed = parseConfig(rawConfig);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    try {
      const apiToken = await ctx().secrets.resolve(parsed.config.apiTokenRef as never, { configPath: "apiToken" });
      const client = new JiraClient(
        { siteUrl: parsed.config.siteUrl, email: parsed.config.email, apiToken },
        (url, init) => ctx().http.fetch(url, init),
      );
      const me = await client.myself();
      return { ok: true, warnings: me.displayName ? [`Connecté à Jira en tant que ${me.displayName}.`] : [] };
    } catch (err) {
      if (err instanceof JiraError) return { ok: false, errors: [err.message] };
      // Résolution du secret impossible hors contexte société : on ne bloque pas l'enregistrement.
      return { ok: true, warnings: [`Connexion non testée : ${describeError(err)}`] };
    }
  },

  // ── Références d'objets externes (pastille native) ─────────────────────
  async onDetectExternalObjects({ companyId, urls }) {
    const parsed = parseConfig(await ctx().config.get(companyId));
    if (!parsed.ok) return { detections: [] };
    const detections: PluginExternalObjectDetection[] = [];
    for (const candidate of urls) {
      const key = issueKeyFromUrl(candidate.sanitizedCanonicalUrl, parsed.config.siteHost);
      if (!key) continue;
      detections.push({
        urlIdentityHash: candidate.canonicalIdentityHash,
        providerKey: PROVIDER_KEY,
        objectType: OBJECT_TYPE,
        externalId: key,
        displayKey: key,
        iconKey: "jira",
        confidence: "exact",
      });
    }
    return { detections };
  },

  async onResolveExternalObject({ companyId, externalId }) {
    try {
      const { client } = await clientFor(companyId);
      return { ok: true, snapshot: snapshotFromIssue(await client.getIssue(externalId)) };
    } catch (err) {
      return resolveFailure(err, externalId);
    }
  },

  async onRefreshExternalObjects({ companyId, objects }) {
    const keys = objects.map((o) => o.externalId);
    let views: Map<string, TicketView>;
    try {
      const { client, config } = await clientFor(companyId);
      views = await fetchTickets(client, config.siteUrl, keys);
    } catch (err) {
      return { results: objects.map((o) => ({ objectId: o.id, result: resolveFailure(err, o.externalId) })) };
    }
    return {
      results: objects.map((o) => {
        const issue = views.get(o.externalId)?.issue;
        return {
          objectId: o.id,
          result: issue
            ? { ok: true as const, snapshot: snapshotFromIssue(issue) }
            : { ok: true as const, snapshot: notFoundSnapshot(o.externalId) },
        };
      }),
    };
  },
});

function resolveFailure(err: unknown, key: string): PluginExternalObjectResolveResult {
  if (err instanceof ConfigError) {
    return { ok: false, liveness: "auth_required", errorCode: "jira_not_configured", errorMessage: err.message };
  }
  return resultFromError(err, key);
}

function formatTicketForAgent(view: TicketView): string {
  if (!view.issue) return `${view.key} — ${view.error ?? "introuvable"} (${view.url})`;
  const i = view.issue;
  return [
    `${i.key} — ${i.summary}`,
    `Statut : ${i.statusName} · Type : ${i.issueType ?? "?"} · Priorité : ${i.priority ?? "?"} · Assigné : ${i.assignee ?? "personne"}`,
    `Mis à jour : ${i.updated ?? "?"} · ${i.url}`,
  ].join("\n");
}

export default plugin;
runWorker(plugin, import.meta.url);
