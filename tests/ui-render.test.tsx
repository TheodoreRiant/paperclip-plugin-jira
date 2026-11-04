/**
 * Rendu des écrans du plugin avec un hôte simulé : vérifie qu'ils s'affichent
 * sans erreur et qu'aucun style propre au plugin ne subsiste (tout passe par
 * les classes et les tokens de Paperclip).
 */
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { IssueLinksData, TicketsData } from "../src/worker.js";

const ISSUE = {
  id: "10012",
  key: "ABC-12",
  summary: "Corriger la connexion",
  statusName: "En cours",
  statusCategoryKey: "indeterminate",
  issueType: "Bug",
  priority: "High",
  assignee: "Alice",
  updated: "2026-11-01T10:00:00.000Z",
  url: "https://acme.atlassian.net/browse/ABC-12",
};

const ISSUE_LINKS: IssueLinksData = {
  configured: true,
  configErrors: [],
  siteUrl: "https://acme.atlassian.net",
  linked: [{ key: "ABC-12", url: ISSUE.url, issue: ISSUE, error: null }],
  mentioned: [{ key: "ABC-7", url: "https://acme.atlassian.net/browse/ABC-7", issue: null, error: "Introuvable" }],
  documentRevisionId: "rev-1",
};

const TICKETS: TicketsData = { configured: true, configErrors: [], siteUrl: "https://acme.atlassian.net", tickets: {} };

let pathname = "/ABC/issues/ABC-1";

function DataTableStub({ columns, rows }: { columns: Array<{ key: string; render?: (v: unknown, r: unknown) => ReactNode }>; rows: Array<Record<string, unknown>> }) {
  return createElement(
    "div",
    null,
    rows.map((row) =>
      createElement(
        Fragment,
        { key: String(row.id) },
        columns.map((c) => createElement(Fragment, { key: c.key }, c.render ? c.render(row[c.key], row) : String(row[c.key]))),
      ),
    ),
  );
}

beforeAll(async () => {
  const react = await import("react");
  (globalThis as Record<string, unknown>).__paperclipPluginBridge__ = {
    react,
    sdkUi: {
      usePluginData: (key: string) => ({
        data: key === "issue-links" ? ISSUE_LINKS : TICKETS,
        loading: false,
        error: null,
        refresh: () => {},
      }),
      usePluginAction: () => async () => ({ recent: true, results: [ISSUE] }),
      usePluginToast: () => () => {},
      useHostContext: () => ({ companyId: "company-1", companyPrefix: "ABC", entityId: "issue-1", entityType: "issue" }),
      useHostLocation: () => ({ pathname, search: "", hash: "", state: null }),
      useHostNavigation: () => ({
        navigate: () => {},
        resolveHref: (to: string) => `/ABC${to}`,
        linkProps: (to: string) => ({ href: `/ABC${to}`, onClick: () => {} }),
      }),
      Spinner: ({ label }: { label?: string }) => createElement("span", { role: "status", "aria-label": label }),
      DataTable: DataTableStub,
    },
  };
});

async function render(name: string, props: Record<string, unknown> = {}): Promise<string> {
  const ui = (await import("../src/ui/index.js")) as unknown as Record<string, (p: unknown) => ReactNode>;
  return renderToStaticMarkup(createElement(ui[name]!, props));
}

/** Seuls styles en ligne admis : la couleur des glyphes de statut, tirée des tokens de l'hôte. */
function ownStyles(html: string): string[] {
  return [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!).filter((s) => !/^color:var\(--status-task-icon-[a-z_]+\)$/.test(s));
}

const context = { companyId: "company-1", companyPrefix: "ABC", entityId: "issue-1", entityType: "issue" };

describe("écrans du plugin", () => {
  it("onglet Jira : tickets liés, cités, champ de recherche", async () => {
    const html = await render("JiraTab", { context });
    expect(html).toContain("ABC-12");
    expect(html).toContain("Corriger la connexion");
    expect(html).toContain('data-external-status="running"');
    expect(html).toContain('aria-label="Délier ABC-12"');
    expect(html).toContain("Cités dans la tâche");
    expect(html).toContain('data-slot="command-input"');
    expect(ownStyles(html)).toEqual([]);
  });

  it("fenêtre du bouton Jira d'une tâche", async () => {
    const html = await render("JiraIssueLauncher");
    expect(html).toContain("Tickets liés");
    expect(ownStyles(html)).toEqual([]);
  });

  it("fenêtre du bouton Jira de la barre du haut, hors tâche : création de tâche", async () => {
    pathname = "/ABC/dashboard";
    const html = await render("JiraGlobalLauncher");
    expect(html).toContain("Créer une tâche depuis un ticket");
    expect(html).toContain("Mes tickets assignés");
    expect(html).toContain('href="/ABC/jira"');
    expect(ownStyles(html)).toEqual([]);
  });

  it("fenêtre du bouton Jira de la barre du haut, sur une tâche", async () => {
    pathname = "/ABC/issues/ABC-1";
    const html = await render("JiraGlobalLauncher");
    expect(html).toContain("Chargement de la tâche");
    expect(ownStyles(html)).toEqual([]);
  });

  it("entrée de la barre latérale, avec le rendu des entrées natives", async () => {
    pathname = "/ABC/jira";
    const html = await render("JiraSidebarLink", { context });
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("bg-sidebar-accent");
    expect(ownStyles(html)).toEqual([]);
  });

  it("page Jira", async () => {
    const html = await render("JiraPage", { context });
    expect(html).toContain("Tâches liées à Jira");
    expect(html).toContain("Écarts (0)");
    expect(ownStyles(html)).toEqual([]);
  });
});
