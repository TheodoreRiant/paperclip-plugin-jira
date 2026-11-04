import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginExternalObjectDetection,
  type PluginExternalObjectResolveResult,
  type PluginExternalObjectUrlCandidate,
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
import {
  desiredLabels,
  mergeRequests,
  planLabels,
  registryFrom,
  type LabelRegistry,
  type LabelRequest,
  type LabelSyncState,
} from "./label-sync.js";

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

/** Durée de mémorisation de l'id du champ « Sprint » d'un site (il ne change pas). */
const SPRINT_FIELD_TTL_MS = 60 * 60 * 1000;
/** Après un échec de lecture des champs, on réessaie plus tôt. */
const SPRINT_FIELD_RETRY_MS = 10 * 60 * 1000;
const sprintFields = new Map<string, { id: string | null; expiresAt: number }>();

async function sprintFieldFor(siteUrl: string, client: JiraClient): Promise<string | null> {
  const cached = sprintFields.get(siteUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.id;
  try {
    const id = await client.findSprintField();
    sprintFields.set(siteUrl, { id, expiresAt: Date.now() + SPRINT_FIELD_TTL_MS });
    return id;
  } catch (err) {
    // Sans le sprint, tout le reste marche : on n'échoue pas pour lui.
    ctx().logger.warn("Champ Sprint de Jira illisible", { error: describeError(err) });
    sprintFields.set(siteUrl, { id: cached?.id ?? null, expiresAt: Date.now() + SPRINT_FIELD_RETRY_MS });
    return cached?.id ?? null;
  }
}

/** Réservé aux tests : oublie les ids de champ « Sprint » mémorisés. */
export function resetSprintFieldCache(): void {
  sprintFields.clear();
}

async function clientFor(companyId: string, config?: JiraConfig): Promise<{ client: JiraClient; config: JiraConfig }> {
  const resolvedConfig = config ?? (await loadConfig(companyId));
  const apiToken = await ctx().secrets.resolve(resolvedConfig.apiTokenRef as never, {
    companyId,
    configPath: "apiToken",
  });
  const fetchImpl: FetchLike = (url, init) => ctx().http.fetch(url, init);
  const credentials = { siteUrl: resolvedConfig.siteUrl, email: resolvedConfig.email, apiToken };
  // Cherché à la première lecture d'un ticket seulement, puis mémorisé.
  const sprintField = () => sprintFieldFor(resolvedConfig.siteUrl, new JiraClient(credentials, fetchImpl));
  return {
    client: new JiraClient(credentials, fetchImpl, sprintField),
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

// ── Libellés tenus à jour depuis Jira ─────────────────────────────────────
//
// L'hôte relit chaque ticket à intervalle régulier (`onResolveExternalObject`)
// sans dire à quelles tâches il appartient : le plugin tient donc son propre
// index clé → tâches, alimenté par la détection des liens, l'affichage d'une
// tâche et la page Jira. Le worker pose les libellés ; il ne peut pas en
// créer : les libellés manquants sont demandés à l'interface, qui les crée
// avec la session de l'utilisateur (`label-requests` / `register-labels`).

const STATE_NS = "label-sync";
const INDEX_NS = "ticket-index";
const registryKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NS, stateKey: "registry" });
const requestsKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NS, stateKey: "requests" });
const waitingKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NS, stateKey: "waiting-issues" });
const issueSyncKey = (issueId: string) => ({ scopeKind: "issue" as const, scopeId: issueId, namespace: STATE_NS, stateKey: "applied" });
const indexKey = (companyId: string, key: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: INDEX_NS, stateKey: key });

/** Nombre maximal de tâches resynchronisées par appel (page Jira, libellés créés). */
export const MAX_SYNC_ISSUES = 200;

export interface LabelRequestsData {
  enabled: boolean;
  /** Libellés à créer dans Paperclip. */
  requests: LabelRequest[];
  /** `false` tant que l'interface n'a jamais transmis les libellés de la société. */
  registryKnown: boolean;
}

export interface LabelSyncResult {
  changed: boolean;
  missing: number;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asRequests(value: unknown): LabelRequest[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is LabelRequest => Boolean(r) && typeof r.name === "string" && typeof r.color === "string",
  );
}

async function readRegistry(companyId: string): Promise<LabelRegistry | null> {
  const value = await ctx().state.get(registryKey(companyId));
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LabelRegistry) : null;
}

async function addToIndex(companyId: string, key: string, issueId: string): Promise<void> {
  const current = stringArray(await ctx().state.get(indexKey(companyId, key)));
  if (!current.includes(issueId)) await ctx().state.set(indexKey(companyId, key), [...current, issueId]);
}

async function removeFromIndex(companyId: string, key: string, issueId: string): Promise<void> {
  const current = stringArray(await ctx().state.get(indexKey(companyId, key)));
  if (current.includes(issueId)) await ctx().state.set(indexKey(companyId, key), current.filter((id) => id !== issueId));
}

/** Tickets d'une tâche : liés par le plugin (document `jira`) ou cités dans le titre ou la description. */
async function ticketKeysOfIssue(
  issue: { id: string; title?: string | null; description?: string | null },
  companyId: string,
  siteHost: string,
): Promise<string[]> {
  const { tickets } = await readLinkedTickets(issue.id, companyId, siteHost);
  return [
    ...new Set([...tickets.map((t) => t.key), ...issueKeysInText(`${issue.title ?? ""}\n${issue.description ?? ""}`, siteHost)]),
  ];
}

/**
 * Met les libellés d'une tâche en accord avec ses tickets. `known` évite de
 * relire un ticket que l'appelant vient de lire. Une panne de Jira laisse les
 * libellés tels quels.
 */
async function syncIssueLabels(
  companyId: string,
  issueId: string,
  config: JiraConfig,
  client: JiraClient,
  known: Map<string, TicketView> = new Map(),
): Promise<LabelSyncResult & { keys: string[] }> {
  const noop = { changed: false, missing: 0, keys: [] as string[] };
  if (!config.syncLabels) return noop;
  const issue = await ctx().issues.get(issueId, companyId);
  if (!issue) return noop;

  const keys = await ticketKeysOfIssue(issue, companyId, config.siteHost);
  for (const key of keys) await addToIndex(companyId, key, issueId);

  const unknown = keys.filter((key) => !known.has(key));
  const views = new Map(known);
  for (const [key, view] of await fetchTickets(client, config.siteUrl, unknown)) views.set(key, view);
  const tickets = keys.flatMap((key) => (views.get(key)?.issue ? [views.get(key)!.issue!] : []));

  const issueLabels = (issue as { labels?: Array<{ id?: unknown; name?: unknown }> }).labels ?? [];
  const currentIds = (issue as { labelIds?: string[] }).labelIds ?? stringArray(issueLabels.map((l) => l.id));
  const registry = { ...registryFrom(issueLabels), ...((await readRegistry(companyId)) ?? {}) };
  const previous = (await ctx().state.get(issueSyncKey(issueId))) as LabelSyncState | null;

  const plan = planLabels({ currentIds, previous, desired: desiredLabels(tickets), registry });
  if (plan.changed) {
    try {
      await ctx().issues.update(issueId, { labelIds: plan.labelIds }, companyId);
    } catch (err) {
      // Un libellé supprimé dans Paperclip rend l'id refusé : on oublie les
      // libellés connus, l'interface les retransmettra.
      ctx().logger.warn("Libellés Jira non posés", { issueId, error: describeError(err) });
      await ctx().state.delete(registryKey(companyId));
      await markWaiting(companyId, issueId, []);
      return { changed: false, missing: plan.missing.length, keys };
    }
  }
  if (plan.next !== previous) await ctx().state.set(issueSyncKey(issueId), plan.next);
  if (plan.missing.length > 0) await markWaiting(companyId, issueId, plan.missing);
  return { changed: plan.changed, missing: plan.missing.length, keys };
}

async function markWaiting(companyId: string, issueId: string, missing: LabelRequest[]): Promise<void> {
  const requests = asRequests(await ctx().state.get(requestsKey(companyId)));
  await ctx().state.set(requestsKey(companyId), mergeRequests(requests, missing));
  const waiting = stringArray(await ctx().state.get(waitingKey(companyId)));
  if (!waiting.includes(issueId)) await ctx().state.set(waitingKey(companyId), [...waiting, issueId].slice(-MAX_SYNC_ISSUES));
}

/** Après la relecture d'un ticket par l'hôte : met à jour les tâches qui l'ont. */
async function syncTicketTasks(companyId: string, views: Map<string, TicketView>): Promise<void> {
  const parsed = parseConfig(await ctx().config.get(companyId));
  if (!parsed.ok || !parsed.config.syncLabels) return;
  let client: JiraClient | null = null;
  for (const key of views.keys()) {
    for (const issueId of stringArray(await ctx().state.get(indexKey(companyId, key)))) {
      try {
        client ??= (await clientFor(companyId, parsed.config)).client;
        const { keys } = await syncIssueLabels(companyId, issueId, parsed.config, client, views);
        if (!keys.includes(key)) await removeFromIndex(companyId, key, issueId);
      } catch (err) {
        ctx().logger.warn("Synchronisation des libellés Jira impossible", { issueId, key, error: describeError(err) });
      }
    }
  }
}

/** Synchronise une tâche sans faire échouer l'appelant (affichage, détection). */
async function syncQuietly(companyId: string, issueId: string, known?: Map<string, TicketView>): Promise<void> {
  try {
    const parsed = parseConfig(await ctx().config.get(companyId));
    if (!parsed.ok || !parsed.config.syncLabels) return;
    const { client } = await clientFor(companyId, parsed.config);
    await syncIssueLabels(companyId, issueId, parsed.config, client, known);
  } catch (err) {
    ctx().logger.warn("Synchronisation des libellés Jira impossible", { issueId, error: describeError(err) });
  }
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

      // Afficher une tâche suffit à l'indexer et à mettre ses libellés à jour
      // (tâches liées avant la synchronisation des libellés comprises).
      await syncQuietly(companyId, issueId, views);

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
        const { issue, description, details } = await client.getIssueForImport(key);
        return draftTaskFromTicket(issue, adfToMarkdown(description), details, config.importCommand);
      } catch (err) {
        throw new Error(describeError(err));
      }
    });

    // ── Libellés : demandes de création (lues par l'interface) ───────────
    context.data.register("label-requests", async (params): Promise<LabelRequestsData> => {
      const companyId = requireString(params, "companyId");
      const parsed = parseConfig(await context.config.get(companyId));
      if (!parsed.ok || !parsed.config.syncLabels) return { enabled: false, requests: [], registryKnown: true };
      return {
        enabled: true,
        requests: asRequests(await context.state.get(requestsKey(companyId))),
        registryKnown: (await readRegistry(companyId)) !== null,
      };
    });

    // ── Libellés : l'interface transmet ceux de la société (après création) ─
    context.actions.register("register-labels", async (params, actionContext) => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const labels = Array.isArray(params.labels) ? (params.labels as Array<{ id?: unknown; name?: unknown }>) : [];
      const registry = registryFrom(labels);
      await context.state.set(registryKey(companyId), registry);
      const stillMissing = asRequests(await context.state.get(requestsKey(companyId))).filter(
        (r) => !registry[r.name.toLowerCase()],
      );
      await context.state.set(requestsKey(companyId), stillMissing);

      const waiting = stringArray(await context.state.get(waitingKey(companyId)));
      await context.state.set(waitingKey(companyId), []);
      let synced = 0;
      for (const issueId of waiting.slice(0, MAX_SYNC_ISSUES)) {
        await syncQuietly(companyId, issueId);
        synced += 1;
      }
      return { registered: Object.keys(registry).length, synced };
    });

    // ── Libellés : resynchroniser une tâche (après lien, délien, import) ──
    context.actions.register("sync-issue-labels", async (params, actionContext): Promise<LabelSyncResult> => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const issueId = requireString(params, "issueId");
      const parsed = parseConfig(await context.config.get(companyId));
      if (!parsed.ok || !parsed.config.syncLabels) return { changed: false, missing: 0 };
      const { client } = await clientFor(companyId, parsed.config);
      const { changed, missing } = await syncIssueLabels(companyId, issueId, parsed.config, client);
      return { changed, missing };
    });

    // ── Libellés : la page Jira transmet les liens tâche ↔ ticket connus de l'hôte ─
    context.actions.register("index-links", async (params, actionContext) => {
      const companyId = actionContext.companyId ?? requireString(params, "companyId");
      const parsed = parseConfig(await context.config.get(companyId));
      if (!parsed.ok || !parsed.config.syncLabels) return { synced: 0 };
      const links = (Array.isArray(params.links) ? params.links : []).flatMap((link) => {
        const issueId = typeof link?.issueId === "string" ? link.issueId : null;
        const key = typeof link?.key === "string" ? normalizeIssueKey(link.key) : null;
        return issueId && key ? [{ issueId, key }] : [];
      });
      const issueIds = [...new Set(links.map((l) => l.issueId))].slice(0, MAX_SYNC_ISSUES);
      if (issueIds.length === 0) return { synced: 0 };
      // Un seul appel Jira pour tous les tickets, réutilisé par chaque tâche.
      const { client, config } = await clientFor(companyId, parsed.config);
      const views = await fetchTickets(client, config.siteUrl, [...new Set(links.map((l) => l.key))].slice(0, MAX_PAGE_KEYS));
      let synced = 0;
      for (const issueId of issueIds) {
        try {
          await syncIssueLabels(companyId, issueId, config, client, views);
          synced += 1;
        } catch (err) {
          context.logger.warn("Synchronisation des libellés Jira impossible", { issueId, error: describeError(err) });
        }
      }
      return { synced };
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
  async onDetectExternalObjects({ companyId, urls, sourceContext }) {
    const parsed = parseConfig(await ctx().config.get(companyId));
    if (!parsed.ok) return { detections: [] };
    const detected = detectionsFor(urls, parsed.config.siteHost);
    // Un nouveau lien : la tâche reçoit ses libellés sans attendre la
    // prochaine relecture du ticket. Sans attendre : la détection doit rester rapide.
    if (parsed.config.syncLabels && detected.length > 0 && sourceContext?.sourceIssueId) {
      const issueId = sourceContext.sourceIssueId;
      void (async () => {
        for (const d of detected) await addToIndex(companyId, d.externalId, issueId);
        await syncQuietly(companyId, issueId);
      })().catch((err) => ctx().logger.warn("Indexation Jira impossible", { issueId, error: describeError(err) }));
    }
    return { detections: detected };
  },

  async onResolveExternalObject({ companyId, externalId }) {
    let issue: JiraIssueSummary;
    try {
      const { client } = await clientFor(companyId);
      issue = await client.getIssue(externalId);
    } catch (err) {
      return resolveFailure(err, externalId);
    }
    await syncTicketTasks(companyId, new Map([[issue.key, { key: issue.key, url: issue.url, issue, error: null }]]));
    return { ok: true, snapshot: snapshotFromIssue(issue) };
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
    await syncTicketTasks(companyId, new Map([...views].filter(([, view]) => view.issue !== null)));
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

function detectionsFor(urls: PluginExternalObjectUrlCandidate[], siteHost: string): PluginExternalObjectDetection[] {
  const detections: PluginExternalObjectDetection[] = [];
  for (const candidate of urls) {
    const key = issueKeyFromUrl(candidate.sanitizedCanonicalUrl, siteHost);
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
  return detections;
}

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
    `Statut : ${i.statusName} · Type : ${i.issueType ?? "?"} · Priorité : ${i.priority ?? "?"} · Assigné : ${i.assignee ?? "personne"}${i.sprint ? ` · Sprint : ${i.sprint}` : ""}`,
    `Mis à jour : ${i.updated ?? "?"} · ${i.url}`,
  ].join("\n");
}

export default plugin;
runWorker(plugin, import.meta.url);
