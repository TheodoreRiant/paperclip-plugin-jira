import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { RefreshCw, Ticket, TriangleAlert, Unlink, UserRound } from "lucide-react";
import {
  DataTable,
  Spinner,
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type DataTableColumn,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import type { ImportedTaskDraft, IssueLinksData, LinkDocumentChange, TicketView, TicketsData } from "../worker.js";
import {
  buildOverview,
  taskRefFromPath,
  tasksByKey,
  type ExternalObjectLite,
  type GapKind,
  type OverviewRow,
  type TaskLite,
} from "../overview.js";
import {
  Button,
  COMMAND_ITEM_CLASS,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
  CommandRoot,
  CommandShortcut,
  ErrorNotice,
  ExternalKey,
  FilterChip,
  Muted,
  SectionHeader,
  TaskStatusGlyph,
  TicketStatus,
  asExternalCategory,
  buttonClass,
  categoryFromJira,
  cn,
  taskStatusLabel,
} from "./primitives.js";

type JiraIssue = NonNullable<TicketView["issue"]>;

/** Doit correspondre à `JIRA_PAGE_ROUTE` du manifeste. */
const JIRA_ROUTE = "jira";

// ── Appels à l'API Paperclip avec la session de l'utilisateur ───────────

/**
 * Les écritures (document `jira`, création de tâche) passent par l'API HTTP
 * standard avec la session de l'utilisateur : c'est cette route qui déclenche
 * l'analyse des liens par l'hôte, donc l'apparition de la pastille native
 * (une écriture faite par le worker ne la déclenche pas dans cette version).
 */
async function hostJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      detail = body.error ?? body.message ?? "";
    } catch {
      /* corps non JSON */
    }
    throw new HostError(response.status, `Paperclip a refusé la requête (${response.status})${detail ? ` : ${detail}` : ""}`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function applyDocumentChange(issueId: string, change: LinkDocumentChange): Promise<void> {
  const url = `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(change.documentKey)}`;
  try {
    if (change.documentBody === null) {
      await hostJson(url, { method: "DELETE" });
    } else {
      await hostJson(url, {
        method: "PUT",
        body: JSON.stringify({
          title: change.documentTitle,
          format: "markdown",
          body: change.documentBody,
          changeSummary: `Lien Jira : ${change.key}`,
          baseRevisionId: change.baseRevisionId,
        }),
      });
    }
  } catch (err) {
    if (err instanceof HostError && err.status === 404) return;
    if (err instanceof HostError && err.status === 409) {
      throw new Error("Le document Jira a été modifié entre-temps. Rechargez puis réessayez.");
    }
    throw err;
  }
}

interface CreatedTask {
  id: string;
  identifier: string | null;
}

async function createTaskFromDraft(companyId: string, draft: ImportedTaskDraft): Promise<CreatedTask> {
  return hostJson<CreatedTask>(`/api/companies/${encodeURIComponent(companyId)}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: draft.title, description: draft.description }),
  });
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

// ── Libellés ────────────────────────────────────────────────────────────

/** Libellé d'une catégorie de l'hôte, quand Jira n'a pas encore été relu. */
const HOST_CATEGORY_LABELS: Record<string, string> = {
  open: "À faire",
  waiting: "À faire",
  running: "En cours",
  closed: "Terminé",
  succeeded: "Terminé",
  auth_required: "Accès Jira refusé",
  unreachable: "Jira injoignable",
};

const GAP_LABELS: Record<GapKind, string> = {
  ticket_done_task_open: "Ticket terminé, tâche encore ouverte",
  task_done_ticket_open: "Tâche terminée, ticket encore ouvert",
};

function JiraIssueStatus({ issue }: { issue: JiraIssue }) {
  return <TicketStatus category={categoryFromJira(issue.statusCategoryKey)} label={issue.statusName} />;
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner label={label} />
      {label}
    </div>
  );
}

// ── Ticket lié ──────────────────────────────────────────────────────────

function TicketRow({ view, onUnlink, busy }: { view: TicketView; onUnlink?: () => void; busy?: boolean }) {
  const issue = view.issue;
  const meta = issue
    ? [issue.issueType, issue.priority && `Priorité ${issue.priority}`, `Assigné : ${issue.assignee ?? "personne"}`].filter(Boolean).join(" · ")
    : null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <ExternalKey href={view.url}>{view.key}</ExternalKey>
        <span className="min-w-0 flex-1 truncate text-sm">{issue?.summary ?? ""}</span>
        {issue ? <JiraIssueStatus issue={issue} /> : <TicketStatus category="unknown" label={view.error ?? "Introuvable"} />}
        {onUnlink ? (
          <Button variant="ghost" size="icon-xs" onClick={onUnlink} disabled={busy} title="Délier" aria-label={`Délier ${view.key}`}>
            {busy ? <Spinner label="Délien…" /> : <Unlink aria-hidden="true" />}
          </Button>
        ) : null}
      </div>
      {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
    </div>
  );
}

// ── Recherche en direct (présentation `Command` de l'hôte) ──────────────

function looksLikeKeyOrUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value) || /^https?:\/\//i.test(value);
}

/** Délai après la dernière frappe avant d'interroger Jira. */
const SUGGEST_DEBOUNCE_MS = 250;

interface SuggestResponse {
  recent: boolean;
  results: JiraIssue[];
}

/**
 * Champ de recherche Jira avec suggestions en direct : les tickets
 * apparaissent au fil de la frappe (clé partielle, début de mot, URL). Champ
 * vide : tickets consultés récemment dans Jira. Clavier : ↑ ↓ pour choisir,
 * Entrée pour valider, Échap pour fermer la liste.
 */
function TicketSearchBox({
  companyId,
  ariaLabel,
  actionLabel,
  busyKey,
  disabled,
  autoFocus,
  aside,
  onPick,
}: {
  companyId: string;
  ariaLabel: string;
  /** Libellé de l'action d'une suggestion (« Lier », « Créer la tâche »…). */
  actionLabel: (issue: JiraIssue) => string;
  /** Clé en cours de traitement (affiche « … » sur sa ligne). */
  busyKey: string | null;
  disabled: boolean;
  autoFocus?: boolean;
  /** Information complémentaire sur une suggestion (ex. tâche déjà liée). */
  aside?: (issue: JiraIssue) => ReactNode;
  /** Reçoit la clé choisie, ou la saisie brute (clé / URL) validée par Entrée. */
  onPick: (value: string) => Promise<boolean>;
}) {
  const suggestAction = usePluginAction("suggest");
  const suggestRef = useRef(suggestAction);
  suggestRef.current = suggestAction;
  const cache = useRef(new Map<string, SuggestResponse>());
  const requestSeq = useRef(0);
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SuggestResponse | null>(null);
  const [highlight, setHighlight] = useState(0);
  const query = input.trim();

  useEffect(() => {
    if (!focused && !query) return;
    const cached = cache.current.get(query);
    if (cached) {
      setResponse(cached);
      setHighlight(0);
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = setTimeout(
      () => {
        suggestRef
          .current({ companyId, query })
          .then((r) => {
            const result = r as SuggestResponse;
            cache.current.set(query, result);
            if (seq !== requestSeq.current) return; // une frappe plus récente a pris le relais
            setResponse(result);
            setHighlight(0);
            setError(null);
          })
          .catch((err) => seq === requestSeq.current && setError(errorText(err)))
          .finally(() => seq === requestSeq.current && setLoading(false));
      },
      query ? SUGGEST_DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [companyId, query, focused]);

  const results = response?.results ?? [];

  async function pick(value: string) {
    if (await onPick(value)) {
      setInput("");
      setOpen(false);
      cache.current.clear(); // les tickets récents ont pu changer
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (h + step + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (disabled) return;
      const chosen = open ? results[highlight] : undefined;
      // La saisie exacte prime tant que les suggestions ne l'ont pas rattrapée.
      if (looksLikeKeyOrUrl(query) && (loading || !chosen)) void pick(query);
      else if (chosen) void pick(chosen.key);
    } else if (event.key === "Escape" && open) {
      // Ferme la liste sans fermer la fenêtre qui contient le champ.
      event.stopPropagation();
      setOpen(false);
    }
  }

  const showList = open && (focused || busyKey !== null) && response !== null;

  return (
    <div className="flex flex-col gap-2">
      <CommandRoot className="border">
        <CommandInput
          divider={showList}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          placeholder="Clé (ABC-12…), quelques mots ou URL du ticket"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={showList}
          role="combobox"
          disabled={disabled}
          autoFocus={autoFocus}
          trailing={loading ? <Spinner label="Recherche…" /> : null}
        />
        {showList ? (
          <CommandList label={ariaLabel}>
            {results.length === 0 ? (
              loading ? null : (
                <CommandEmpty>{query ? "Aucun ticket ne correspond." : "Commencez à taper pour chercher un ticket."}</CommandEmpty>
              )
            ) : (
              <CommandGroup heading={response.recent ? "Consultés récemment dans Jira" : "Suggestions"}>
                {results.map((issue, index) => (
                  <div
                    key={issue.key}
                    role="option"
                    aria-selected={index === highlight}
                    data-selected={index === highlight}
                    data-disabled={disabled}
                    className={COMMAND_ITEM_CLASS}
                    // mousedown : choisir avant que le champ ne perde le focus.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (!disabled) void pick(issue.key);
                    }}
                    onMouseEnter={() => setHighlight(index)}
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.key}</span>
                    <span className="min-w-0 flex-1 truncate">{issue.summary}</span>
                    {aside?.(issue)}
                    <JiraIssueStatus issue={issue} />
                    <CommandShortcut>{busyKey === issue.key ? "…" : index === highlight ? `${actionLabel(issue)} ↵` : ""}</CommandShortcut>
                  </div>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        ) : null}
      </CommandRoot>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </div>
  );
}

// ── Tickets d'une tâche ─────────────────────────────────────────────────

function LinkForm({ companyId, issueId, onLinked }: { companyId: string; issueId: string; onLinked: () => void }) {
  const prepareLink = usePluginAction("prepare-link");
  const toast = usePluginToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function link(value: string): Promise<boolean> {
    setBusyKey(value);
    setError(null);
    try {
      const change = (await prepareLink({ companyId, issueId, input: value })) as LinkDocumentChange;
      if (change.alreadyLinked) {
        toast({ title: `${change.key} est déjà lié à cette tâche.`, tone: "info" });
      } else {
        await applyDocumentChange(issueId, change);
        toast({ title: `Ticket ${change.key} lié.`, tone: "success" });
      }
      onLinked();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <TicketSearchBox
        companyId={companyId}
        ariaLabel="Ticket Jira à lier"
        actionLabel={() => "Lier"}
        busyKey={busyKey}
        disabled={busyKey !== null}
        autoFocus
        onPick={link}
      />
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </div>
  );
}

function NotConfigured({ errors }: { errors: string[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-sm">
      <p className="font-medium">Plugin Jira non configuré</p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      <Muted>Réglages → Plugins → Jira link.</Muted>
    </div>
  );
}

/** Tickets liés à une tâche + formulaire de liaison. Utilisé par l'onglet et par les boutons Jira. */
function IssueJiraPanel({ companyId, issueId }: { companyId: string; issueId: string }) {
  const { data, loading, error, refresh } = usePluginData<IssueLinksData>("issue-links", { companyId, issueId });
  const prepareUnlink = usePluginAction("prepare-unlink");
  const toast = usePluginToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function unlink(key: string) {
    setBusyKey(key);
    try {
      const change = (await prepareUnlink({ companyId, issueId, key })) as LinkDocumentChange;
      await applyDocumentChange(issueId, change);
      toast({ title: `Ticket ${key} délié.`, tone: "success" });
      refresh();
    } catch (err) {
      toast({ title: "Échec du délien", body: errorText(err), tone: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  if (loading && !data) return <Loading label="Lecture de Jira…" />;
  if (error) return <ErrorNotice>{error.message}</ErrorNotice>;
  if (!data) return null;
  if (!data.configured) return <NotConfigured errors={data.configErrors} />;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <SectionHeader>Tickets liés</SectionHeader>
        {data.linked.length === 0 && data.mentioned.length === 0 ? (
          <Muted>Aucun ticket lié pour l'instant.</Muted>
        ) : (
          data.linked.map((view) => (
            <TicketRow key={view.key} view={view} busy={busyKey === view.key} onUnlink={() => unlink(view.key)} />
          ))
        )}
      </section>
      {data.mentioned.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeader>Cités dans la tâche</SectionHeader>
          {data.mentioned.map((view) => (
            <TicketRow key={view.key} view={view} />
          ))}
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <SectionHeader>Lier un ticket</SectionHeader>
        <LinkForm companyId={companyId} issueId={issueId} onLinked={refresh} />
      </section>
    </div>
  );
}

// ── Création d'une tâche depuis un ticket Jira ──────────────────────────

function ImportForm({
  companyId,
  existing,
  onCreated,
}: {
  companyId: string;
  /** Tâches déjà liées à chaque clé (si connu) : on le signale avant de créer un doublon. */
  existing?: Map<string, TaskLite[]>;
  onCreated?: (task: CreatedTask) => void;
}) {
  const prepareImport = usePluginAction("prepare-import");
  const myTickets = usePluginAction("my-tickets");
  const toast = usePluginToast();
  const navigation = useHostNavigation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<JiraIssue[] | null>(null);

  const linkedTasks = (issue: JiraIssue) => existing?.get(issue.key) ?? [];
  const alreadyLinked = (issue: JiraIssue) => {
    const tasks = linkedTasks(issue);
    return tasks.length === 0 ? null : (
      <span className="shrink-0 text-xs text-muted-foreground">Déjà lié : {tasks.map((t) => t.identifier ?? t.title).join(", ")}</span>
    );
  };

  async function create(value: string): Promise<boolean> {
    setBusy(value);
    setError(null);
    try {
      const draft = (await prepareImport({ companyId, input: value })) as ImportedTaskDraft;
      const task = await createTaskFromDraft(companyId, draft);
      const ref = task.identifier ?? task.id;
      toast({
        title: task.identifier ? `Tâche ${task.identifier} créée depuis ${draft.key}.` : `Tâche créée depuis ${draft.key}.`,
        tone: "success",
        action: { label: "Ouvrir", href: navigation.resolveHref(`/issues/${ref}`) },
      });
      onCreated?.(task);
      navigation.navigate(`/issues/${ref}`);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function listMine() {
    setBusy("mine");
    setError(null);
    try {
      const response = (await myTickets({ companyId })) as { results: JiraIssue[] };
      setResults(response.results);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <TicketSearchBox
            companyId={companyId}
            ariaLabel="Ticket Jira à importer"
            actionLabel={(issue) => (linkedTasks(issue).length > 0 ? "Créer quand même" : "Créer la tâche")}
            busyKey={busy}
            disabled={busy !== null}
            aside={alreadyLinked}
            onPick={create}
          />
        </div>
        <Button variant="outline" size="sm" onClick={listMine} disabled={busy !== null}>
          {busy === "mine" ? <Spinner label="Lecture de Jira…" /> : <UserRound aria-hidden="true" />}
          Mes tickets assignés
        </Button>
      </div>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {results ? (
        <section className="flex flex-col gap-2">
          <SectionHeader>Mes tickets assignés (non terminés)</SectionHeader>
          {results.length === 0 ? (
            <Muted>Aucun ticket.</Muted>
          ) : (
            results.map((issue) => {
              const already = linkedTasks(issue);
              return (
                <div key={issue.key} className="flex min-w-0 items-center gap-2 rounded-md border border-border px-3 py-2">
                  <ExternalKey href={issue.url}>{issue.key}</ExternalKey>
                  <span className="min-w-0 flex-1 truncate text-sm">{issue.summary}</span>
                  {already.length > 0 ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Déjà lié :{" "}
                      {already.map((t, i) => (
                        <span key={t.id}>
                          {i > 0 ? ", " : ""}
                          <a {...navigation.linkProps(`/issues/${t.identifier ?? t.id}`)} className="hover:text-foreground hover:underline">
                            {t.identifier ?? t.title}
                          </a>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <JiraIssueStatus issue={issue} />
                  <Button
                    variant={already.length > 0 ? "outline" : "default"}
                    size="xs"
                    onClick={() => void create(issue.key)}
                    disabled={busy !== null}
                  >
                    {busy === issue.key ? "…" : already.length > 0 ? "Créer quand même" : "Créer la tâche"}
                  </Button>
                </div>
              );
            })
          )}
        </section>
      ) : null}
    </div>
  );
}

// ── Page tâche (mode classique) : onglet ────────────────────────────────

export function JiraTab({ context }: PluginDetailTabProps) {
  return <IssueJiraPanel companyId={context.companyId ?? ""} issueId={context.entityId} />;
}

// ── Fenêtres ouvertes par les boutons « Jira » ──────────────────────────
//
// Les boutons sont des « launchers » déclarés dans le manifeste : Paperclip
// dessine lui-même le bouton (comme ses autres boutons de barre d'outils) et
// la fenêtre (en-tête, bouton Close, Échap, clic à côté). Le plugin ne fournit
// que le contenu.

/** Bouton « Jira » de la page d'une tâche (mode classique). */
export function JiraIssueLauncher() {
  const host = useHostContext();
  if (!host.companyId || !host.entityId) return <Muted>Ouvrez une tâche pour gérer ses tickets Jira.</Muted>;
  return <IssueJiraPanel companyId={host.companyId} issueId={host.entityId} />;
}

interface ResolvedTask {
  id: string;
  identifier: string | null;
  title: string;
}

/**
 * Bouton « Jira » de la barre du haut, visible quel que soit le mode. L'hôte
 * ne transmet à cet emplacement que la société : la tâche ouverte est lue dans
 * l'URL (`/<préfixe>/issues/<ID>`). Sur une tâche : tickets liés, lier,
 * délier. Ailleurs : créer une tâche depuis un ticket.
 */
export function JiraGlobalLauncher() {
  const host = useHostContext();
  const { pathname } = useHostLocation();
  const navigation = useHostNavigation();
  const companyId = host.companyId ?? "";
  const taskRef = taskRefFromPath(pathname);
  const [task, setTask] = useState<ResolvedTask | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskRef) return;
    let cancelled = false;
    setTask(null);
    setTaskError(null);
    hostJson<ResolvedTask>(`/api/issues/${encodeURIComponent(taskRef)}`)
      .then((t) => !cancelled && setTask(t))
      .catch((err) => !cancelled && setTaskError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [taskRef]);

  if (!companyId) return <Muted>Choisissez une société.</Muted>;

  return (
    <div className="flex flex-col gap-4">
      {taskRef ? (
        taskError ? (
          <ErrorNotice>Tâche introuvable : {taskError}</ErrorNotice>
        ) : task ? (
          <>
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{task.identifier ?? taskRef}</span>
              <span className="truncate">{task.title}</span>
            </p>
            <IssueJiraPanel companyId={companyId} issueId={task.id} />
          </>
        ) : (
          <Loading label="Chargement de la tâche…" />
        )
      ) : (
        <section className="flex flex-col gap-2">
          <SectionHeader>Créer une tâche depuis un ticket</SectionHeader>
          <ImportForm companyId={companyId} />
        </section>
      )}
      <div className="flex justify-end border-t border-border pt-3">
        <a {...navigation.linkProps(`/${JIRA_ROUTE}`)} className={buttonClass("ghost", "xs")}>
          Ouvrir la page Jira
        </a>
      </div>
    </div>
  );
}

// ── Barre latérale (même rendu que les entrées natives) ─────────────────

export function JiraSidebarLink(_props: PluginSidebarProps) {
  const navigation = useHostNavigation();
  const { pathname } = useHostLocation();
  const active = /^\/[^/]+\/jira(?:\/|$)/.test(pathname);
  return (
    <a
      {...navigation.linkProps(`/${JIRA_ROUTE}`)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <span data-slot="sidebar-nav-icon" className="relative shrink-0">
        <Ticket className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="flex-1 truncate">Jira</span>
    </a>
  );
}

// ── Page « Jira » ───────────────────────────────────────────────────────

type Filter = "gaps" | "open" | "all";

interface OverviewState {
  rows: OverviewRow[];
  taskCount: number;
}

async function loadOverview(companyId: string): Promise<OverviewState> {
  const cid = encodeURIComponent(companyId);
  const listed = await hostJson<TaskLite[] | { issues?: TaskLite[]; items?: TaskLite[] }>(
    `/api/companies/${cid}/issues?limit=1000`,
  );
  const tasks = Array.isArray(listed) ? listed : (listed.issues ?? listed.items ?? []);
  if (tasks.length === 0) return { rows: [], taskCount: 0 };
  const { summaries } = await hostJson<{ summaries: Record<string, { objects?: ExternalObjectLite[] }> }>(
    `/api/companies/${cid}/issues/external-object-summaries`,
    { method: "POST", body: JSON.stringify({ issueIds: tasks.map((t) => t.id) }) },
  );
  return { rows: buildOverview(tasks, summaries), taskCount: tasks.length };
}

interface TableRow {
  id: string;
  ticket: OverviewRow;
  task: OverviewRow;
  gap: OverviewRow;
  [key: string]: unknown;
}

function GapNotice({ gap }: { gap: GapKind }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
      <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <span>{GAP_LABELS[gap]}</span>
    </span>
  );
}

export function JiraPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const navigation = useHostNavigation();
  const [overview, setOverview] = useState<OverviewState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState<Filter | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setLoadError(null);
    loadOverview(companyId)
      .then((o) => !cancelled && setOverview(o))
      .catch((err) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [companyId, reloadToken]);

  const keys = useMemo(() => [...new Set((overview?.rows ?? []).map((r) => r.key))].sort(), [overview]);
  const tickets = usePluginData<TicketsData>("tickets", { companyId, keys });
  const existing = useMemo(() => tasksByKey(overview?.rows ?? []), [overview]);

  const gaps = overview?.rows.filter((r) => r.gap !== null) ?? [];
  const openRows = overview?.rows.filter((r) => r.task.status !== "done" && r.task.status !== "cancelled") ?? [];
  // Par défaut : les écarts s'il y en a, sinon les tâches ouvertes.
  const activeFilter: Filter = filter ?? (gaps.length > 0 ? "gaps" : "open");
  const visible = activeFilter === "gaps" ? gaps : activeFilter === "open" ? openRows : (overview?.rows ?? []);

  if (!companyId) return <Muted>Choisissez une société.</Muted>;
  if (tickets.data && !tickets.data.configured) return <NotConfigured errors={tickets.data.configErrors} />;

  const columns: DataTableColumn<TableRow>[] = [
    {
      key: "ticket",
      header: "Ticket Jira",
      width: "minmax(0, 1.2fr)",
      render: (_value, { ticket: row }) => {
        const live = tickets.data?.tickets[row.key];
        const url = live?.url ?? (tickets.data?.siteUrl ? `${tickets.data.siteUrl}/browse/${row.key}` : undefined);
        const summary = live?.issue?.summary ?? row.ticketTitle ?? "";
        return (
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <ExternalKey href={url}>{row.key}</ExternalKey>
              {live?.issue ? (
                <JiraIssueStatus issue={live.issue} />
              ) : (
                <TicketStatus
                  category={asExternalCategory(row.ticketCategory)}
                  label={HOST_CATEGORY_LABELS[row.ticketCategory] ?? "Inconnu"}
                />
              )}
            </div>
            <span className="truncate text-sm" title={summary}>
              {summary}
            </span>
            {live?.issue?.assignee ? <span className="text-xs text-muted-foreground">{live.issue.assignee}</span> : null}
          </div>
        );
      },
    },
    {
      key: "task",
      header: "Tâche Paperclip",
      width: "minmax(0, 1fr)",
      render: (_value, { task: row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <TaskStatusGlyph status={row.task.status} />
          <a
            {...navigation.linkProps(`/issues/${row.task.identifier ?? row.task.id}`)}
            className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {row.task.identifier ?? "Tâche"}
          </a>
          <span className="min-w-0 truncate text-sm" title={`${row.task.title} — ${taskStatusLabel(row.task.status)}`}>
            {row.task.title}
          </span>
        </div>
      ),
    },
    {
      key: "gap",
      header: "Écart",
      width: "minmax(0, 0.8fr)",
      render: (_value, { gap: row }) => (row.gap ? <GapNotice gap={row.gap} /> : <span className="text-xs text-muted-foreground">—</span>),
    },
  ];

  const tableRows: TableRow[] = visible.map((row) => ({ id: `${row.task.id}:${row.key}`, ticket: row, task: row, gap: row }));

  const emptyMessage =
    activeFilter === "gaps"
      ? "Aucun écart : les statuts des tâches et des tickets concordent."
      : overview?.rows.length === 0
        ? "Aucune tâche n'est encore liée à un ticket Jira. Collez l'URL d'un ticket dans une tâche, utilisez le bouton « Jira » en haut, ou créez une tâche ci-dessus."
        : "Aucune tâche dans ce filtre.";

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <section className="flex flex-col gap-3">
        <SectionHeader>Créer une tâche depuis un ticket</SectionHeader>
        <ImportForm companyId={companyId} existing={existing} onCreated={() => setReloadToken((n) => n + 1)} />
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader
          trailing={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setReloadToken((n) => n + 1);
                tickets.refresh();
              }}
            >
              <RefreshCw aria-hidden="true" />
              Actualiser
            </Button>
          }
        >
          Tâches liées à Jira
        </SectionHeader>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={activeFilter === "gaps"} onClick={() => setFilter("gaps")}>
            Écarts ({gaps.length})
          </FilterChip>
          <FilterChip active={activeFilter === "open"} onClick={() => setFilter("open")}>
            Tâches ouvertes ({openRows.length})
          </FilterChip>
          <FilterChip active={activeFilter === "all"} onClick={() => setFilter("all")}>
            Tout ({overview?.rows.length ?? 0})
          </FilterChip>
        </div>

        {loadError ? <ErrorNotice>{loadError}</ErrorNotice> : null}
        {!loadError ? <DataTable
            // `DataTable` n'est pas générique côté JSX : on élargit le type des lignes.
            columns={columns as unknown as DataTableColumn[]}
            rows={tableRows} loading={!overview} emptyMessage={emptyMessage} /> : null}
        {overview && overview.taskCount >= 1000 ? <Muted>Seules les 1 000 tâches les plus récentes sont analysées.</Muted> : null}
      </section>
    </div>
  );
}
