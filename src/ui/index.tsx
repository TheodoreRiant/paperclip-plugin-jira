import { useState, type CSSProperties, type FormEvent } from "react";
import {
  Spinner,
  StatusBadge,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginDetailTabProps,
  type StatusBadgeVariant,
} from "@paperclipai/plugin-sdk/ui";
import type { IssueLinksData, LinkDocumentChange, TicketView } from "../worker.js";

/**
 * Le worker valide le ticket et calcule le contenu du document `jira` ;
 * l'UI l'écrit via l'API HTTP de Paperclip avec la session de l'utilisateur.
 * C'est cette écriture par la route standard qui déclenche l'analyse des
 * liens par l'hôte, donc l'apparition de la pastille de statut native.
 * (Une écriture faite par le worker via `ctx.issues.documents.upsert` ne
 * déclenche pas cette analyse dans la version actuelle de l'hôte.)
 */
async function applyDocumentChange(issueId: string, change: LinkDocumentChange): Promise<void> {
  const url = `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(change.documentKey)}`;
  const response =
    change.documentBody === null
      ? await fetch(url, { method: "DELETE", credentials: "include" })
      : await fetch(url, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: change.documentTitle,
            format: "markdown",
            body: change.documentBody,
            changeSummary: `Lien Jira : ${change.key}`,
            baseRevisionId: change.baseRevisionId,
          }),
        });
  if (!response.ok && response.status !== 404) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      detail = body.error ?? body.message ?? "";
    } catch {
      /* corps non JSON */
    }
    if (response.status === 409) {
      throw new Error("Le document Jira a été modifié entre-temps. Rechargez puis réessayez.");
    }
    throw new Error(`Écriture du lien refusée (${response.status})${detail ? ` : ${detail}` : ""}`);
  }
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

const styles = {
  stack: { display: "flex", flexDirection: "column", gap: 12 } as CSSProperties,
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } as CSSProperties,
  card: {
    border: "1px solid var(--border, rgba(127,127,127,0.25))",
    borderRadius: 8,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } as CSSProperties,
  muted: { opacity: 0.7, fontSize: 13 } as CSSProperties,
  input: {
    flex: 1,
    minWidth: 200,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--border, rgba(127,127,127,0.35))",
    background: "transparent",
    color: "inherit",
  } as CSSProperties,
  button: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, rgba(127,127,127,0.35))",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  } as CSSProperties,
  heading: { fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.75 } as CSSProperties,
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

function LinkForm({ companyId, issueId, onLinked }: { companyId: string; issueId: string; onLinked: () => void }) {
  const prepareLink = usePluginAction("prepare-link");
  const search = usePluginAction("search");
  const toast = usePluginToast();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TicketView["issue"][] | null>(null);

  async function link(value: string) {
    setBusy(true);
    setError(null);
    try {
      const change = (await prepareLink({ companyId, issueId, input: value })) as LinkDocumentChange;
      if (change.alreadyLinked) {
        toast({ title: `${change.key} est déjà lié à cette tâche.`, tone: "info" });
      } else {
        await applyDocumentChange(issueId, change);
        toast({ title: `Ticket ${change.key} lié.`, tone: "success" });
      }
      setInput("");
      setResults(null);
      onLinked();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    // Clé ou URL : on lie directement. Sinon : recherche plein texte.
    if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value) || /^https?:\/\//i.test(value)) {
      await link(value);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = (await search({ companyId, text: value })) as { results: TicketView["issue"][] };
      setResults(response.results);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={styles.stack}>
      <div style={styles.row}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Clé (ABC-123), URL du ticket ou texte à chercher"
          aria-label="Ticket Jira"
          disabled={busy}
        />
        <button type="submit" style={styles.button} disabled={busy || !input.trim()}>
          {busy ? "…" : "Lier / chercher"}
        </button>
      </div>
      {error ? <div style={{ color: "var(--destructive, #c0392b)", fontSize: 13 }}>{error}</div> : null}
      {results ? (
        results.length === 0 ? (
          <div style={styles.muted}>Aucun ticket trouvé.</div>
        ) : (
          <div style={styles.stack}>
            {results.map((issue) =>
              issue ? (
                <div key={issue.key} style={styles.row}>
                  <button type="button" style={styles.button} onClick={() => link(issue.key)} disabled={busy}>
                    Lier
                  </button>
                  <strong>{issue.key}</strong>
                  <span>{issue.summary}</span>
                  <span style={styles.muted}>({issue.statusName})</span>
                </div>
              ) : null,
            )}
          </div>
        )
      ) : null}
    </form>
  );
}

function useIssueLinks(companyId: string | null, issueId: string) {
  return usePluginData<IssueLinksData>("issue-links", { companyId, issueId });
}

export function JiraTab({ context }: PluginDetailTabProps) {
  const companyId = context.companyId ?? "";
  const issueId = context.entityId;
  const { data, loading, error, refresh } = useIssueLinks(companyId, issueId);
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
  if (error) return <div style={{ color: "var(--destructive, #c0392b)" }}>Erreur : {error.message}</div>;
  if (!data) return null;

  if (!data.configured) {
    return (
      <div style={styles.stack}>
        <strong>Plugin Jira non configuré</strong>
        <ul>
          {data.configErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <div style={styles.muted}>Réglages → Plugins → Jira link.</div>
      </div>
    );
  }

  return (
    <div style={styles.stack}>
      <div style={styles.heading}>Lier un ticket</div>
      <LinkForm companyId={companyId} issueId={issueId} onLinked={refresh} />

      <div style={styles.heading}>Tickets liés</div>
      {data.linked.length === 0 ? (
        <div style={styles.muted}>Aucun ticket lié.</div>
      ) : (
        data.linked.map((view) => (
          <TicketCard key={view.key} view={view} busy={busyKey === view.key} onUnlink={() => unlink(view.key)} />
        ))
      )}

      {data.mentioned.length > 0 ? (
        <>
          <div style={styles.heading}>Cités dans la tâche</div>
          {data.mentioned.map((view) => (
            <TicketCard key={view.key} view={view} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/** Bouton de barre d'outils : ouvre une petite fenêtre avec le formulaire de liaison. */
export function JiraToolbarButton({ context }: PluginDetailTabProps) {
  const [open, setOpen] = useState(false);
  const companyId = context.companyId ?? "";
  const issueId = context.entityId;

  return (
    <>
      <button type="button" style={styles.button} onClick={() => setOpen(true)}>
        Lier à Jira
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Lier à Jira"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "15vh",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "var(--background, #fff)",
              color: "var(--foreground, inherit)",
              borderRadius: 10,
              padding: 16,
              width: "min(560px, 92vw)",
              ...styles.stack,
            }}
          >
            <div style={styles.row}>
              <strong>Lier à un ticket Jira</strong>
              <button type="button" style={{ ...styles.button, marginLeft: "auto" }} onClick={() => setOpen(false)}>
                Fermer
              </button>
            </div>
            <LinkForm companyId={companyId} issueId={issueId} onLinked={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
