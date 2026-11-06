import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { JiraError, pickSprint, sprintName, type JiraIssueSummary, type JiraSprint } from "../src/jira-client.js";
import { issueKeyFromInput, issueKeyFromUrl, normalizeIssueKey } from "../src/jira-url.js";
import { issueKeysInText, parseLinksDocument, renderLinksDocument } from "../src/links.js";
import { resultFromError, snapshotFromIssue, statusLabelFor } from "../src/status.js";
import { desiredLabels, mergeRequests, planLabels, registryFrom, statusLabelName } from "../src/label-sync.js";
import {
  HOST_LABEL_COLORS,
  asPreferences,
  defaultImportChoices,
  goalForProject,
  importInstruction,
  labelColor,
  labelNames,
  matchLabels,
  priorityFromJira,
  projectBodyForSprint,
  projectForSprint,
} from "../src/import.js";

const HOST = "acme.atlassian.net";
const SITE = `https://${HOST}`;

function issue(overrides: Partial<JiraIssueSummary> = {}): JiraIssueSummary {
  return {
    id: "10001",
    key: "ABC-1",
    url: `${SITE}/browse/ABC-1`,
    summary: "Résumé",
    issueType: "Bug",
    statusName: "En cours",
    statusCategoryKey: "indeterminate",
    assignee: "Alice",
    priority: "High",
    updated: "2026-11-01T10:00:00.000+0100",
    labels: [],
    sprint: null,
    ...overrides,
  };
}

describe("jira-url", () => {
  it.each([
    [`${SITE}/browse/ABC-123`, "ABC-123"],
    [`${SITE}/browse/abc-123/`, "ABC-123"],
    [`${SITE}/jira/software/projects/ABC/issues/ABC-9`, "ABC-9"],
    [`${SITE}/jira/software/c/projects/ABC/issues/ABC-9`, "ABC-9"],
    [`${SITE}/jira/servicedesk/projects/SD/issues/SD-4`, "SD-4"],
    [`https://ACME.atlassian.net/browse/AB_2-7`, "AB_2-7"],
  ])("reconnaît %s", (url, key) => {
    expect(issueKeyFromUrl(url, HOST)).toBe(key);
  });

  it.each([
    "https://other.atlassian.net/browse/ABC-1",
    `${SITE}/jira/software/projects/ABC/boards/12`,
    `${SITE}/browse/ABC`,
    `${SITE}/browse/ABC-0`,
    `${SITE}/browse/1ABC-3`,
    "ftp://acme.atlassian.net/browse/ABC-1",
    "pas une url",
  ])("ignore %s", (url) => {
    expect(issueKeyFromUrl(url, HOST)).toBeNull();
  });

  it("interprète clé ou URL saisie, sinon null", () => {
    expect(issueKeyFromInput("  abc-42 ", HOST)).toBe("ABC-42");
    expect(issueKeyFromInput(`${SITE}/browse/ABC-42`, HOST)).toBe("ABC-42");
    expect(issueKeyFromInput("bug de connexion", HOST)).toBeNull();
    expect(normalizeIssueKey("ABC-12a")).toBeNull();
  });
});

describe("links", () => {
  it("relève les tickets cités dans un texte, sans doublon ni ponctuation finale", () => {
    const text = `Voir ${SITE}/browse/ABC-1, et (${SITE}/browse/ABC-2). Re ${SITE}/browse/ABC-1 ; autre https://x.atlassian.net/browse/X-1`;
    expect(issueKeysInText(text, HOST)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("le document rendu se relit à l'identique", () => {
    const body = renderLinksDocument(SITE, [
      { key: "ABC-1", summary: "Premier\nsur deux lignes" },
      { key: "ABC-2", summary: null },
    ]);
    expect(body).toContain(`- [ABC-1](${SITE}/browse/ABC-1) — Premier sur deux lignes`);
    expect(parseLinksDocument(body, HOST)).toEqual([
      { key: "ABC-1", summary: "Premier sur deux lignes" },
      { key: "ABC-2", summary: null },
    ]);
  });
});

describe("config", () => {
  it("normalise une config valide", () => {
    const parsed = parseConfig({
      siteUrl: "https://Acme.atlassian.net/",
      email: " me@acme.io ",
      apiToken: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
    });
    expect(parsed).toMatchObject({ ok: true, config: { siteUrl: SITE, siteHost: HOST, email: "me@acme.io" } });
  });

  it("liste toutes les erreurs", () => {
    const parsed = parseConfig({ siteUrl: "http://acme.atlassian.net", apiToken: "" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toHaveLength(3);
  });
});

describe("status", () => {
  it.each([
    ["new", "open", "neutral", false],
    ["indeterminate", "running", "info", false],
    ["done", "closed", "success", true],
    ["undefined", "unknown", "muted", false],
  ] as const)("catégorie Jira %s → %s", (jiraKey, category, tone, terminal) => {
    const snapshot = snapshotFromIssue(issue({ statusCategoryKey: jiraKey }));
    expect(snapshot).toMatchObject({ statusCategory: category, statusTone: tone, isTerminal: terminal });
  });

  it("les données exposées au board se limitent aux champs choisis", () => {
    expect(Object.keys(snapshotFromIssue(issue()).data ?? {}).sort()).toEqual(
      ["assignee", "issueType", "key", "labels", "priority", "sprint", "status", "summary", "updated", "url"].sort(),
    );
  });

  it("erreurs Jira → états de l'hôte", () => {
    expect(resultFromError(new JiraError("auth", "x", 401), "ABC-1")).toMatchObject({ ok: false, liveness: "auth_required" });
    expect(resultFromError(new JiraError("unreachable", "x", 503), "ABC-1")).toMatchObject({ ok: false, liveness: "unreachable" });
    expect(resultFromError(new JiraError("rate_limited", "x", 429, 30), "ABC-1")).toMatchObject({
      ok: false,
      retryAfterSeconds: 30,
    });
    expect(resultFromError(new JiraError("not_found", "x", 404), "ABC-1")).toMatchObject({
      ok: true,
      snapshot: { statusLabel: "Introuvable", statusCategory: "unknown" },
    });
  });
});

describe("import : propriétés reprises dans la tâche", () => {
  it("convertit les priorités Jira, ancien schéma compris", () => {
    expect(priorityFromJira("Highest")).toBe("critical");
    expect(priorityFromJira("Blocker")).toBe("critical");
    expect(priorityFromJira("High")).toBe("high");
    expect(priorityFromJira("Major")).toBe("high");
    expect(priorityFromJira(" medium ")).toBe("medium");
    expect(priorityFromJira("Minor")).toBe("low");
    expect(priorityFromJira("Lowest")).toBe("low");
    expect(priorityFromJira("P2 maison")).toBeNull();
    expect(priorityFromJira(null)).toBeNull();
  });

  it("normalise les libellés : espaces, longueur maximale, doublons sans tenir compte de la casse", () => {
    expect(labelNames(["Bug", null, " bug ", "a  b", "x".repeat(60)])).toEqual(["Bug", "a b", "x".repeat(48)]);
  });

  it("réutilise les libellés existants par nom et liste ceux à créer", () => {
    const existing = [
      { id: "l1", name: "bug" },
      { id: "l2", name: "Front " },
    ];
    expect(matchLabels(["Bug", "front", "Story"], existing)).toEqual({ ids: ["l1", "l2"], missing: ["Story"] });
  });

  it("donne une couleur stable, prise dans la palette de Paperclip", () => {
    expect(HOST_LABEL_COLORS).toContain(labelColor("Story"));
    expect(labelColor("Story")).toBe(labelColor("story"));
  });

  it("formule l'instruction, ou rien si la commande est vide", () => {
    expect(importInstruction("/ticket", "ABC-1")).toBe("Lance `/ticket ABC-1` sur ce ticket.");
    expect(importInstruction("  ", "ABC-1")).toBeNull();
  });
});

describe("ligne « External objects » : statut · sprint · assigné", () => {
  it("assemble les informations présentes, dans cet ordre", () => {
    expect(statusLabelFor({ statusName: "En cours", sprint: "Sprint 42", assignee: "Marie Dupont" })).toBe(
      "En cours · Sprint 42 · Marie Dupont",
    );
    expect(statusLabelFor({ statusName: "À faire", sprint: null, assignee: null })).toBe("À faire");
    expect(snapshotFromIssue(issue({ sprint: "Sprint 42" })).statusLabel).toBe("En cours · Sprint 42 · Alice");
  });

  it("garde le sprint actif, sinon le prochain, sinon le dernier", () => {
    expect(sprintName([{ name: "S1", state: "closed" }, { name: "S2", state: "active" }, { name: "S3", state: "future" }])).toBe("S2");
    expect(sprintName([{ name: "S1", state: "closed" }, { name: "S3", state: "future" }])).toBe("S3");
    expect(sprintName([{ name: "S1", state: "closed" }, { name: "S2", state: "closed" }])).toBe("S2");
    expect(sprintName(null)).toBeNull();
    expect(sprintName([])).toBeNull();
  });
});

describe("libellés tenus à jour depuis Jira", () => {
  const ticket = { statusName: "En cours", statusCategoryKey: "indeterminate", issueType: "Story", labels: ["front", "Story"] };

  it("veut l'état, le type et les libellés Jira, sans doublon", () => {
    expect(desiredLabels([ticket]).map((l) => l.name)).toEqual(["Jira : En cours", "Story", "front"]);
    expect(desiredLabels([ticket])[0]?.color).toBe("#f97316");
    expect(statusLabelName("  En   revue ")).toBe("Jira : En revue");
  });

  it("première fois : ajoute sans toucher aux libellés posés à la main", () => {
    const plan = planLabels({
      currentIds: ["manuel"],
      previous: null,
      desired: desiredLabels([ticket]),
      registry: registryFrom([
        { id: "s1", name: "Jira : En cours" },
        { id: "t1", name: "story" },
        { id: "f1", name: "Front" },
      ]),
    });
    expect(plan).toMatchObject({ changed: true, labelIds: ["manuel", "s1", "t1", "f1"], missing: [] });
    expect(plan.next).toEqual({ appliedNames: ["Jira : En cours", "Story", "front"], managedIds: ["s1", "t1", "f1"] });
  });

  it("le ticket change : remplace ce que le plugin avait posé, demande les libellés manquants", () => {
    const plan = planLabels({
      currentIds: ["manuel", "s1", "t1"],
      previous: { appliedNames: ["Jira : En cours", "Story"], managedIds: ["s1", "t1"] },
      desired: desiredLabels([{ ...ticket, statusName: "Terminé", statusCategoryKey: "done", labels: [] }]),
      registry: { "jira : en cours": "s1", story: "t1" },
    });
    expect(plan.labelIds).toEqual(["manuel", "t1"]);
    expect(plan.missing).toEqual([{ name: "Jira : Terminé", color: "#22c55e" }]);
    expect(plan.next).toEqual({ appliedNames: ["Story"], managedIds: ["t1"] });
  });

  it("rien ne change tant que le ticket ne change pas, même si un libellé a été retiré à la main", () => {
    const previous = { appliedNames: ["Jira : En cours"], managedIds: ["s1"] };
    const plan = planLabels({
      currentIds: ["manuel"],
      previous,
      desired: desiredLabels([{ ...ticket, issueType: null, labels: [] }]),
      registry: { "jira : en cours": "s1" },
    });
    expect(plan).toMatchObject({ changed: false, labelIds: ["manuel"], next: previous });
  });

  it("plus de ticket : retire tout ce que le plugin avait posé", () => {
    const plan = planLabels({
      currentIds: ["manuel", "s1"],
      previous: { appliedNames: ["Jira : En cours"], managedIds: ["s1"] },
      desired: [],
      registry: {},
    });
    expect(plan).toMatchObject({ changed: true, labelIds: ["manuel"], next: { appliedNames: [], managedIds: [] } });
  });

  it("fusionne les demandes de création sans doublon", () => {
    expect(mergeRequests([{ name: "Story", color: "a" }], [{ name: "story", color: "b" }, { name: "Bug", color: "c" }])).toEqual([
      { name: "Story", color: "a" },
      { name: "Bug", color: "c" },
    ]);
  });
});

describe("fiche de création : sprint, projet, agent, objectif", () => {
  const SPRINT: JiraSprint = { name: "BO Sprint 22", state: "active", startDate: "2026-11-02", endDate: "2026-11-13", goal: "Livrer la connexion" };
  const PROJECTS = [
    { id: "p-app", name: "Application" },
    { id: "p-21", name: "Sprint 21", goalIds: [] },
    { id: "p-22", name: "Sprint 22", goalIds: ["g-1"] },
    { id: "p-old", name: "BO Sprint 22", archivedAt: "2026-10-01T00:00:00Z" },
  ];
  const GOALS = [
    { id: "g-1", title: "Confort et productivité" },
    { id: "g-2", title: "Économie de tokens" },
  ];
  const AGENTS = [
    { id: "a-1", name: "Flitwick", status: "idle" },
    { id: "a-2", name: "Ancien", status: "terminated" },
  ];

  it("retient l'actif, sinon le prochain, sinon le dernier sprint, avec dates et objectif", () => {
    const raw = [
      { name: "Sprint 21", state: "closed", endDate: "2026-10-30T17:00:00.000Z" },
      { name: " Sprint 22 ", state: "active", startDate: "2026-11-02T08:00:00.000Z", endDate: "2026-11-13T17:00:00.000Z", goal: " Livrer " },
    ];
    expect(pickSprint(raw)).toEqual({ name: "Sprint 22", state: "active", startDate: "2026-11-02", endDate: "2026-11-13", goal: "Livrer" });
    expect(pickSprint([{ name: "Sprint 21", state: "closed" }, { name: "Sprint 23", state: "future" }])?.name).toBe("Sprint 23");
    expect(pickSprint([{ name: "S", state: "bizarre", endDate: "pas une date" }])).toEqual({
      name: "S",
      state: null,
      startDate: null,
      endDate: null,
      goal: null,
    });
    expect(pickSprint(null)).toBeNull();
    expect(sprintName(raw)).toBe("Sprint 22");
  });

  it("trouve le projet du sprint : même nom, sinon même numéro s'il est unique ; ignore les archivés", () => {
    expect(projectForSprint("sprint 21", PROJECTS)?.id).toBe("p-21");
    expect(projectForSprint("BO Sprint 22", PROJECTS)?.id).toBe("p-22");
    expect(projectForSprint("Sprint 23", PROJECTS)).toBeNull();
    expect(projectForSprint("Itération 4", PROJECTS)).toBeNull();
    expect(projectForSprint("BO Sprint 21", [...PROJECTS, { id: "x", name: "Équipe B sprint 21" }])).toBeNull();
    expect(projectForSprint(null, PROJECTS)).toBeNull();
  });

  it("décrit le projet à créer pour un sprint", () => {
    expect(projectBodyForSprint(SPRINT)).toEqual({
      name: "BO Sprint 22",
      status: "in_progress",
      icon: "rocket",
      color: labelColor("BO Sprint 22"),
      targetDate: "2026-11-13",
      description: "Livrer la connexion\n\nSprint Jira du 2026-11-02 au 2026-11-13.",
    });
    expect(projectBodyForSprint({ name: "S", state: "future", startDate: null, endDate: null, goal: null })).toEqual({
      name: "S",
      status: "planned",
      icon: "rocket",
      color: labelColor("S"),
    });
    expect(projectBodyForSprint({ ...SPRINT, state: "closed" }).status).toBe("completed");
  });

  it("propose le dernier agent, le projet du sprint et son objectif, la tâche parente", () => {
    const choices = defaultImportChoices({
      draft: { sprint: SPRINT, preferences: { agentId: "a-1", goalId: "g-2" } },
      agents: AGENTS,
      projects: PROJECTS,
      goals: GOALS,
      parentTaskId: "t-parent",
    });
    expect(choices).toEqual({ agentId: "a-1", project: { kind: "existing", id: "p-22" }, goalId: "g-1", parentId: "t-parent" });
  });

  it("sans projet pour le sprint : en propose un nouveau ; sans sprint : aucun projet", () => {
    const base = { agents: AGENTS, projects: PROJECTS, goals: GOALS, parentTaskId: null };
    const newSprint = defaultImportChoices({ ...base, draft: { sprint: { ...SPRINT, name: "Sprint 30" }, preferences: { agentId: null, goalId: "g-2" } } });
    expect(newSprint).toMatchObject({ project: { kind: "sprint" }, goalId: "g-2", agentId: null });
    const noSprint = defaultImportChoices({ ...base, draft: { sprint: null, preferences: { agentId: null, goalId: null } } });
    expect(noSprint.project).toEqual({ kind: "none" });
  });

  it("n'assigne pas un agent supprimé ni un objectif disparu", () => {
    const choices = defaultImportChoices({
      draft: { sprint: null, preferences: { agentId: "a-2", goalId: "g-x" } },
      agents: AGENTS,
      projects: PROJECTS,
      goals: GOALS,
      parentTaskId: null,
    });
    expect(choices).toMatchObject({ agentId: null, goalId: null });
    expect(goalForProject({ id: "p", name: "p", goalIds: ["g-x"] }, GOALS, "g-2")).toBe("g-2");
  });

  it("lit des préférences stockées en ignorant ce qui est invalide", () => {
    expect(asPreferences({ agentId: " a-1 ", goalId: 3 })).toEqual({ agentId: "a-1", goalId: null });
    expect(asPreferences(null)).toEqual({ agentId: null, goalId: null });
  });
});
