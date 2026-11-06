/**
 * Rendu des écrans du plugin avec un hôte simulé : vérifie qu'ils s'affichent
 * sans erreur et qu'aucun style propre au plugin ne subsiste (tout passe par
 * les classes et les tokens de Paperclip).
 */
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  labels: [],
  sprint: null,
};

let ISSUE_LINKS: IssueLinksData = {
  configured: true,
  configErrors: [],
  siteUrl: "https://acme.atlassian.net",
  linked: [{ key: "ABC-12", url: ISSUE.url, issue: ISSUE, error: null }],
  mentioned: [{ key: "ABC-7", url: "https://acme.atlassian.net/browse/ABC-7", issue: null, error: "Introuvable" }],
  documentRevisionId: "rev-1",
};

const TICKETS: TicketsData = { configured: true, configErrors: [], siteUrl: "https://acme.atlassian.net", tickets: {} };

let pathname = "/ABC/issues/ABC-1";
let issueLinks: IssueLinksData = ISSUE_LINKS;
const NO_TICKETS: IssueLinksData = { ...ISSUE_LINKS, linked: [], mentioned: [], documentRevisionId: null };

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
        data: key === "issue-links" ? issueLinks : TICKETS,
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
  it("onglet Jira avec un ticket : fiches et actions utiles, recherche repliée", async () => {
    issueLinks = ISSUE_LINKS;
    const html = await render("JiraTab", { context });
    expect(html).toContain("ABC-12");
    expect(html).toContain("Corriger la connexion");
    expect(html).toContain('data-external-status="running"');
    expect(html).toContain("Ouvrir dans Jira");
    expect(html).toContain('aria-label="Délier ABC-12"');
    // Ticket cité dans la description : on l'ouvre, mais on ne le « délie » pas.
    expect(html).toContain("Cité dans la description de la tâche");
    expect(html).not.toContain('aria-label="Délier ABC-7"');
    // Déjà un ticket : pas de champ de recherche d'emblée.
    expect(html).not.toContain('data-slot="command-input"');
    expect(html).toContain("Lier un autre ticket");
    expect(ownStyles(html)).toEqual([]);
  });

  it("onglet Jira sans ticket : la recherche est l'action principale", async () => {
    issueLinks = NO_TICKETS;
    const html = await render("JiraTab", { context });
    expect(html).toContain('data-slot="command-input"');
    expect(html).not.toContain("Lier un autre ticket");
    expect(ownStyles(html)).toEqual([]);
    issueLinks = ISSUE_LINKS;
  });

  it("bouton de la barre du haut sans ticket : « Jira »", async () => {
    const html = await render("JiraToolbarTrigger", { tickets: [], onOpen: () => {} });
    expect(html).toContain(">Jira</button>");
    expect(html).toContain("h-8");
    expect(html).not.toContain("h-9");
    expect(html).not.toContain("<a ");
    expect(ownStyles(html)).toEqual([]);
  });

  it("bouton de la barre du haut avec un ticket : ouvre le ticket dans Jira", async () => {
    const ui = (await import("../src/ui/index.js")) as unknown as { taskTickets: (d: IssueLinksData) => unknown[] };
    const tickets = ui.taskTickets(ISSUE_LINKS);
    const html = await render("JiraToolbarTrigger", { tickets, onOpen: () => {} });
    expect(html).toContain(`href="${ISSUE.url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("ABC-12");
    expect(html).toContain("+1");
    expect(html).toContain('aria-label="Tickets Jira de la tâche"');
    expect(html).not.toContain(">Jira</button>");
    expect(ownStyles(html)).toEqual([]);
  });

  it("fenêtre du bouton, hors tâche : création de tâche", async () => {
    const html = await render("JiraDialogBody", { companyId: "company-1", taskRef: null, task: null, taskError: null, links: {} });
    expect(html).toContain("Mes tickets assignés");
    expect(html).toContain('href="/ABC/jira"');
    expect(ownStyles(html)).toEqual([]);
  });

  it("fiche de création : agent, projet du sprint, objectif, parent, priorité, libellés", async () => {
    const draft = {
      key: "ABC-12",
      url: ISSUE.url,
      title: "[ABC-12] Corriger la connexion",
      description: "",
      priority: "high",
      labels: ["Bug", "front"],
      sprint: { name: "Sprint 30", state: "active", startDate: null, endDate: "2026-11-20", goal: null },
      parentKey: "ABC-100",
      parentTaskIds: ["t-parent"],
      preferences: { agentId: "a-1", goalId: null },
    };
    const preloaded = {
      agents: [{ id: "a-1", name: "Flitwick", status: "idle", role: "engineer" }],
      projects: [{ id: "p-21", name: "Sprint 21" }],
      goals: [{ id: "g-1", title: "Confort et productivité" }],
      parent: { id: "t-parent", identifier: "ABC-90", title: "Refonte", status: "todo" },
    };
    const html = await render("ImportSheet", { companyId: "company-1", draft, knownParentTasks: [], onCancel: () => {}, onCreated: () => {}, preloaded });
    expect(html).toContain("Flitwick");
    expect(html).toContain("Nouveau projet « Sprint 30 »");
    expect(html).toContain("ABC-90 Refonte");
    expect(html).toContain("Haute");
    expect(html).toContain("Bug, front");
    expect(html).toContain("Créer et assigner à Flitwick");
    expect(ownStyles(html)).toEqual([]);
  });

  it("fenêtre du bouton, sur une tâche liée", async () => {
    const html = await render("JiraDialogBody", {
      companyId: "company-1",
      taskRef: "ABC-1",
      task: { id: "issue-1", identifier: "ABC-1", title: "Ma tâche" },
      taskError: null,
      links: { data: ISSUE_LINKS, loading: false, error: null, refresh: () => {} },
    });
    expect(html).toContain("Ma tâche");
    expect(html).toContain("Ouvrir dans Jira");
    expect(html).not.toContain('data-slot="command-input"');
    expect(ownStyles(html)).toEqual([]);
  });

  it("fenêtre du bouton, tâche en cours de chargement", async () => {
    const html = await render("JiraDialogBody", { companyId: "company-1", taskRef: "ABC-1", task: null, taskError: null, links: {} });
    expect(html).toContain("Chargement de la tâche");
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

describe("création des libellés demandés par le worker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ne crée que les libellés absents (casse ignorée), puis transmet tous ceux de la société", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const payload = method === "GET" ? [{ id: "l1", name: "story", color: "#000" }] : { id: "l2", ...body };
      return new Response(JSON.stringify(payload), { status: method === "GET" ? 200 : 201 });
    });
    const ui = (await import("../src/ui/index.js")) as unknown as {
      provisionLabels: (c: string, w: Array<{ name: string; color: string }>, r: (l: unknown[]) => Promise<unknown>) => Promise<void>;
    };
    let registered: unknown[] = [];
    await ui.provisionLabels(
      "company-1",
      [
        { name: "Story", color: "#111111" },
        { name: "Jira : En cours", color: "#f97316" },
      ],
      async (labels) => {
        registered = labels;
      },
    );
    expect(calls).toEqual([
      { method: "GET", url: "/api/companies/company-1/labels", body: undefined },
      { method: "POST", url: "/api/companies/company-1/labels", body: { name: "Jira : En cours", color: "#f97316" } },
    ]);
    expect(registered).toEqual([
      { id: "l1", name: "story" },
      { id: "l2", name: "Jira : En cours" },
    ]);
  });
});
