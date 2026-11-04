import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Spinner,
  StatusBadge,
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginSidebarProps,
  type StatusBadgeVariant,
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

// ── Styles (variables CSS de l'hôte, valeurs de repli neutres) ──────────

const border = "1px solid var(--border, rgba(127,127,127,0.25))";
const styles = {
  stack: { display: "flex", flexDirection: "column", gap: 12 } as CSSProperties,
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } as CSSProperties,
  card: { border, borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 } as CSSProperties,
  muted: { opacity: 0.7, fontSize: 13 } as CSSProperties,
  error: { color: "var(--destructive, #c0392b)", fontSize: 13 } as CSSProperties,
  input: {
    flex: 1,
    minWidth: 200,
    padding: "6px 8px",
    borderRadius: 6,
    border,
    background: "transparent",
    color: "inherit",
  } as CSSProperties,
  button: { padding: "6px 10px", borderRadius: 6, border, background: "transparent", color: "inherit", cursor: "pointer" } as CSSProperties,
  primary: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid transparent",
    background: "var(--primary, #2563eb)",
    color: "var(--primary-foreground, #fff)",
    cursor: "pointer",
  } as CSSProperties,
  heading: { fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.75 } as CSSProperties,
  chip: (active: boolean): CSSProperties => ({
    padding: "4px 10px",
    borderRadius: 999,
    border,
    background: active ? "var(--accent, rgba(127,127,127,0.18))" : "transparent",
    color: "inherit",
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
  }),
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 } as CSSProperties,
  th: { textAlign: "left", padding: "6px 8px", borderBottom: border, fontWeight: 600, opacity: 0.75, fontSize: 12 } as CSSProperties,
  td: { padding: "8px", borderBottom: border, verticalAlign: "top" } as CSSProperties,
};

function badgeVariant(categoryKey: string | undefined): StatusBadgeVariant {
  switch (categoryKey) {
    case "done":
      return "ok";
    case "indeterminate":
      return "info";
    case "new":
      return "pending";
    default:
      return "warning";
  }
}

/** Catégorie normalisée de l'hôte (quand Jira n'a pas encore été relu). */
function hostCategoryBadge(category: string): { label: string; status: StatusBadgeVariant } {
  switch (category) {
    case "closed":
    case "succeeded":
      return { label: "Terminé", status: "ok" };
    case "running":
      return { label: "En cours", status: "info" };
    case "open":
    case "waiting":
      return { label: "À faire", status: "pending" };
    case "auth_required":
      return { label: "Accès Jira refusé", status: "error" };
    case "unreachable":
      return { label: "Jira injoignable", status: "warning" };
    default:
      return { label: "Inconnu", status: "warning" };
  }
}

const TASK_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "À faire",
  in_progress: "En cours",
  in_review: "En revue",
  blocked: "Bloquée",
  done: "Terminée",
  cancelled: "Annulée",
};

function taskBadge(status: string): { label: string; status: StatusBadgeVariant } {
  const label = TASK_STATUS_LABELS[status] ?? status;
  if (status === "done") return { label, status: "ok" };
  if (status === "cancelled" || status === "backlog") return { label, status: "pending" };
  if (status === "blocked") return { label, status: "error" };
  return { label, status: "info" };
}

const GAP_LABELS: Record<GapKind, string> = {
  ticket_done_task_open: "Ticket terminé, tâche encore ouverte",
  task_done_ticket_open: "Tâche terminée, ticket encore ouvert",
};

// ── Briques communes ────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "var(--background, #fff)",
          color: "var(--foreground, inherit)",
          border,
          borderRadius: 10,
          padding: 16,
          width: wide ? "min(720px, 94vw)" : "min(560px, 92vw)",
          maxHeight: "80vh",
          overflowY: "auto",
          ...styles.stack,
        }}
      >
        <div style={styles.row}>
          <strong>{title}</strong>
          <button type="button" style={{ ...styles.button, marginLeft: "auto" }} onClick={onClose}>
            Fermer
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TicketCard({ view, onUnlink, busy }: { view: TicketView; onUnlink?: () => void; busy?: boolean }) {
  const issue = view.issue;
  return (
    <div style={styles.card}>
      <div style={styles.row}>
        <a href={view.url} target="_blank" rel="noreferrer noopener">
          <strong>{view.key}</strong>
        </a>
        {issue ? (
          <StatusBadge label={issue.statusName} status={badgeVariant(issue.statusCategoryKey)} />
        ) : (
          <StatusBadge label={view.error ?? "Introuvable"} status="warning" />
        )}
        {onUnlink ? (
          <button type="button" style={{ ...styles.button, marginLeft: "auto" }} onClick={onUnlink} disabled={busy}>
            Délier
          </button>
        ) : null}
      </div>
      {issue ? (
        <>
          <div>{issue.summary}</div>
          <div style={styles.muted}>
            {[issue.issueType, issue.priority && `Priorité ${issue.priority}`, `Assigné : ${issue.assignee ?? "personne"}`]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </>
      ) : null}
    </div>
  );
}

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

  const showList = open && (focused || busyKey !== null);

  return (
    <div style={styles.stack}>
      <div style={{ ...styles.row, flexWrap: "nowrap" }}>
        <input
          style={styles.input}
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
          placeholder="Tapez une clé (ABC-12…), quelques mots ou collez une URL"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={showList}
          role="combobox"
          disabled={disabled}
          autoFocus={autoFocus}
        />
        <span style={{ width: 16, display: "inline-flex" }}>{loading ? <Spinner size="sm" /> : null}</span>
      </div>
      {error ? <div style={styles.error}>{error}</div> : null}
      {showList && response ? (
        <div role="listbox" aria-label={ariaLabel} style={{ ...styles.stack, gap: 2 }}>
          {response.recent && results.length > 0 ? <div style={styles.muted}>Consultés récemment dans Jira</div> : null}
          {results.length === 0 && !loading ? (
            <div style={styles.muted}>{query ? "Aucun ticket ne correspond." : "Commencez à taper pour chercher un ticket."}</div>
          ) : null}
          {results.map((issue, index) => (
            <div
              key={issue.key}
              role="option"
              aria-selected={index === highlight}
              // mousedown : choisir avant que le champ ne perde le focus.
              onMouseDown={(e) => {
                e.preventDefault();
                if (!disabled) void pick(issue.key);
              }}
              onMouseEnter={() => setHighlight(index)}
              style={{
                ...styles.row,
                flexWrap: "nowrap",
                padding: "6px 8px",
                borderRadius: 6,
                cursor: disabled ? "default" : "pointer",
                background: index === highlight ? "var(--accent, rgba(127,127,127,0.15))" : "transparent",
              }}
            >
              <strong style={{ whiteSpace: "nowrap" }}>{issue.key}</strong>
              <StatusBadge label={issue.statusName} status={badgeVariant(issue.statusCategoryKey)} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {issue.summary}
              </span>
              {aside?.(issue)}
              <span style={{ ...styles.muted, whiteSpace: "nowrap" }}>
                {busyKey === issue.key ? "…" : index === highlight ? `${actionLabel(issue)} ↵` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
    <div style={styles.stack}>
      <TicketSearchBox
        companyId={companyId}
        ariaLabel="Ticket Jira à lier"
        actionLabel={() => "Lier"}
        busyKey={busyKey}
        disabled={busyKey !== null}
        autoFocus
        onPick={link}
      />
      {error ? <div style={styles.error}>{error}</div> : null}
    </div>
  );
}

function NotConfigured({ errors }: { errors: string[] }) {
  return (
    <div style={styles.stack}>
      <strong>Plugin Jira non configuré</strong>
      <ul>
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      <div style={styles.muted}>Réglages → Plugins → Jira link.</div>
    </div>
  );
}

/** Tickets liés à une tâche + formulaire de liaison. Utilisé par l'onglet et par le bouton du haut. */
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

  if (loading && !data) return <Spinner label="Lecture de Jira…" />;
  if (error) return <div style={styles.error}>Erreur : {error.message}</div>;
  if (!data) return null;
  if (!data.configured) return <NotConfigured errors={data.configErrors} />;

  return (
    <div style={styles.stack}>
      <div style={styles.heading}>Tickets liés</div>
      {data.linked.length === 0 && data.mentioned.length === 0 ? (
        <div style={styles.muted}>Aucun ticket lié pour l'instant.</div>
      ) : (
        data.linked.map((view) => (
          <TicketCard key={view.key} view={view} busy={busyKey === view.key} onUnlink={() => unlink(view.key)} />
        ))
      )}
      {data.mentioned.length > 0 ? (
        <>
          {data.linked.length > 0 ? <div style={styles.heading}>Cités dans la tâche</div> : null}
          {data.mentioned.map((view) => (
            <TicketCard key={view.key} view={view} />
          ))}
        </>
      ) : null}

      <div style={styles.heading}>Lier un ticket</div>
      <LinkForm companyId={companyId} issueId={issueId} onLinked={refresh} />
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
  const [results, setResults] = useState<{ title: string; issues: JiraIssue[] } | null>(null);

  const alreadyLinked = (issue: JiraIssue) => {
    const tasks = existing?.get(issue.key) ?? [];
    return tasks.length === 0 ? null : (
      <span style={{ ...styles.muted, whiteSpace: "nowrap" }}>Déjà lié : {tasks.map((t) => t.identifier ?? t.title).join(", ")}</span>
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
      setResults({ title: "Mes tickets assignés (non terminés)", issues: response.results });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={styles.stack}>
      <div style={{ ...styles.row, alignItems: "flex-start", flexWrap: "nowrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TicketSearchBox
            companyId={companyId}
            ariaLabel="Ticket Jira à importer"
            actionLabel={(issue) => ((existing?.get(issue.key)?.length ?? 0) > 0 ? "Créer quand même" : "Créer la tâche")}
            busyKey={busy}
            disabled={busy !== null}
            aside={alreadyLinked}
            onPick={create}
          />
        </div>
        <button type="button" style={{ ...styles.button, whiteSpace: "nowrap" }} onClick={listMine} disabled={busy !== null}>
          {busy === "mine" ? "…" : "Mes tickets assignés"}
        </button>
      </div>
      {error ? <div style={styles.error}>{error}</div> : null}
      {results ? (
        <div style={styles.stack}>
          <div style={styles.muted}>{results.title}</div>
          {results.issues.length === 0 ? (
            <div style={styles.muted}>Aucun ticket.</div>
          ) : (
            results.issues.map((issue) => {
              const already = existing?.get(issue.key) ?? [];
              return (
                <div key={issue.key} style={{ ...styles.row, ...styles.card, flexDirection: "row" }}>
                  <a href={issue.url} target="_blank" rel="noreferrer noopener">
                    <strong>{issue.key}</strong>
                  </a>
                  <StatusBadge label={issue.statusName} status={badgeVariant(issue.statusCategoryKey)} />
                  <span style={{ flex: 1, minWidth: 160 }}>{issue.summary}</span>
                  {already.length > 0 ? (
                    <span style={styles.muted}>
                      Déjà lié :{" "}
                      {already.map((t, i) => (
                        <span key={t.id}>
                          {i > 0 ? ", " : ""}
                          <a {...navigation.linkProps(`/issues/${t.identifier ?? t.id}`)}>{t.identifier ?? t.title}</a>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    style={already.length > 0 ? styles.button : styles.primary}
                    onClick={() => create(issue.key)}
                    disabled={busy !== null}
                  >
                    {busy === issue.key ? "…" : already.length > 0 ? "Créer quand même" : "Créer la tâche"}
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Mode classique : onglet et bouton de la page tâche ──────────────────

export function JiraTab({ context }: PluginDetailTabProps) {
  return <IssueJiraPanel companyId={context.companyId ?? ""} issueId={context.entityId} />;
}

/** Bouton de barre d'outils de la page tâche (mode classique). */
export function JiraToolbarButton({ context }: PluginDetailTabProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" style={styles.button} onClick={() => setOpen(true)}>
        Lier à Jira
      </button>
      {open ? (
        <Modal title="Jira" onClose={close}>
          <IssueJiraPanel companyId={context.companyId ?? ""} issueId={context.entityId} />
        </Modal>
      ) : null}
    </>
  );
}

// ── Barre du haut : visible partout, quel que soit le mode ──────────────

interface ResolvedTask {
  id: string;
  identifier: string | null;
  title: string;
}

function JiraLogo({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        fill="currentColor"
        d="M11.53 2 3.3 10.23a1.1 1.1 0 0 0 0 1.54L11.53 20l2.4-2.4-6.6-6.6 6.6-6.6zm.94 4.4L10.07 8.8l3.2 3.2-3.2 3.2 2.4 2.4 5.6-5.6z"
      />
    </svg>
  );
}

/**
 * Bouton « Jira » de la barre du haut. L'hôte ne transmet à cet emplacement
 * que la société : la tâche ouverte est lue dans l'URL (`/<préfixe>/issues/<ID>`).
 * Sur une tâche : tickets liés, lier, délier. Ailleurs : créer une tâche
 * depuis un ticket, et accès à la page Jira.
 */
export function JiraGlobalButton() {
  const host = useHostContext();
  const { pathname } = useHostLocation();
  const navigation = useHostNavigation();
  const companyId = host.companyId ?? "";
  const taskRef = taskRefFromPath(pathname);
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState<ResolvedTask | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);

  // On ferme la fenêtre quand on change de page.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open || !taskRef) return;
    let cancelled = false;
    setTask(null);
    setTaskError(null);
    hostJson<ResolvedTask>(`/api/issues/${encodeURIComponent(taskRef)}`)
      .then((t) => !cancelled && setTask(t))
      .catch((err) => !cancelled && setTaskError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [open, taskRef]);

  if (!companyId) return null;

  return (
    <>
      <button
        type="button"
        style={{ ...styles.button, display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 10px" }}
        onClick={() => setOpen(true)}
        title={taskRef ? `Tickets Jira de ${taskRef}` : "Jira"}
      >
        <JiraLogo />
        Jira
      </button>
      {open ? (
        <Modal title={taskRef ? `Jira — ${taskRef}` : "Jira"} onClose={close} wide={!taskRef}>
          {taskRef ? (
            taskError ? (
              <div style={styles.error}>Tâche introuvable : {taskError}</div>
            ) : task ? (
              <IssueJiraPanel companyId={companyId} issueId={task.id} />
            ) : (
              <Spinner label="Chargement de la tâche…" />
            )
          ) : (
            <>
              <div style={styles.heading}>Créer une tâche depuis un ticket</div>
              <ImportForm companyId={companyId} onCreated={close} />
            </>
          )}
          <div style={{ ...styles.row, justifyContent: "flex-end" }}>
            <a {...navigation.linkProps(`/${JIRA_ROUTE}`)}>Ouvrir la page Jira →</a>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// ── Barre latérale ──────────────────────────────────────────────────────

export function JiraSidebarLink(_props: PluginSidebarProps) {
  const navigation = useHostNavigation();
  const { pathname } = useHostLocation();
  const active = /^\/[^/]+\/jira(?:\/|$)/.test(pathname);
  return (
    <a
      {...navigation.linkProps(`/${JIRA_ROUTE}`)}
      aria-current={active ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 32,
        padding: "0 12px",
        borderRadius: 6,
        color: "inherit",
        textDecoration: "none",
        fontWeight: active ? 600 : 500,
        background: active ? "var(--accent, rgba(127,127,127,0.15))" : "transparent",
      }}
    >
      <JiraLogo size={16} />
      Jira
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

  if (!companyId) return <div style={styles.muted}>Choisissez une société.</div>;
  if (tickets.data && !tickets.data.configured) return <NotConfigured errors={tickets.data.configErrors} />;

  return (
    <div style={{ ...styles.stack, gap: 20, padding: "16px 24px", maxWidth: 1200 }}>
      <div style={styles.row}>
        <JiraLogo size={20} />
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Jira</h1>
        <button
          type="button"
          style={{ ...styles.button, marginLeft: "auto" }}
          onClick={() => {
            setReloadToken((n) => n + 1);
            tickets.refresh();
          }}
        >
          Actualiser
        </button>
      </div>

      <section style={styles.stack}>
        <div style={styles.heading}>Créer une tâche depuis un ticket</div>
        <ImportForm companyId={companyId} existing={existing} onCreated={() => setReloadToken((n) => n + 1)} />
      </section>

      <section style={styles.stack}>
        <div style={styles.row}>
          <div style={styles.heading}>Tâches liées à Jira</div>
          <div style={{ ...styles.row, marginLeft: "auto" }}>
            <button type="button" style={styles.chip(activeFilter === "gaps")} onClick={() => setFilter("gaps")}>
              Écarts ({gaps.length})
            </button>
            <button type="button" style={styles.chip(activeFilter === "open")} onClick={() => setFilter("open")}>
              Tâches ouvertes ({openRows.length})
            </button>
            <button type="button" style={styles.chip(activeFilter === "all")} onClick={() => setFilter("all")}>
              Tout ({overview?.rows.length ?? 0})
            </button>
          </div>
        </div>

        {loadError ? <div style={styles.error}>{loadError}</div> : null}
        {!overview && !loadError ? <Spinner label="Chargement des liens…" /> : null}
        {overview && visible.length === 0 ? (
          <div style={styles.muted}>
            {activeFilter === "gaps"
              ? "Aucun écart : les statuts des tâches et des tickets concordent."
              : overview.rows.length === 0
                ? "Aucune tâche n'est encore liée à un ticket Jira. Collez l'URL d'un ticket dans une tâche, utilisez le bouton « Jira » en haut, ou créez une tâche ci-dessus."
                : "Aucune tâche dans ce filtre."}
          </div>
        ) : null}
        {overview && visible.length > 0 ? (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Ticket Jira</th>
                <th style={styles.th}>Tâche Paperclip</th>
                <th style={styles.th}>Écart</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const live = tickets.data?.tickets[row.key];
                const fallback = hostCategoryBadge(row.ticketCategory);
                const tBadge = taskBadge(row.task.status);
                const url = live?.url ?? (tickets.data?.siteUrl ? `${tickets.data.siteUrl}/browse/${row.key}` : undefined);
                return (
                  <tr key={`${row.task.id}:${row.key}`}>
                    <td style={styles.td}>
                      <div style={styles.row}>
                        <a href={url} target="_blank" rel="noreferrer noopener">
                          <strong>{row.key}</strong>
                        </a>
                        {live?.issue ? (
                          <StatusBadge label={live.issue.statusName} status={badgeVariant(live.issue.statusCategoryKey)} />
                        ) : (
                          <StatusBadge label={fallback.label} status={fallback.status} />
                        )}
                      </div>
                      <div style={styles.muted}>
                        {live?.issue?.summary ?? row.ticketTitle ?? ""}
                        {live?.issue?.assignee ? ` · ${live.issue.assignee}` : ""}
                      </div>
                    </td>
                    <td style={styles.td}>
                      <div style={styles.row}>
                        <a {...navigation.linkProps(`/issues/${row.task.identifier ?? row.task.id}`)}>
                          <strong>{row.task.identifier ?? "Tâche"}</strong>
                        </a>
                        <StatusBadge label={tBadge.label} status={tBadge.status} />
                      </div>
                      <div style={styles.muted}>{row.task.title}</div>
                    </td>
                    <td style={styles.td}>
                      {row.gap ? <StatusBadge label={GAP_LABELS[row.gap]} status="warning" /> : <span style={styles.muted}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {overview && overview.taskCount >= 1000 ? (
          <div style={styles.muted}>Seules les 1 000 tâches les plus récentes sont analysées.</div>
        ) : null}
      </section>
    </div>
  );
}
