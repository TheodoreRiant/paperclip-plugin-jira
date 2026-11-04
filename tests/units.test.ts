import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { JiraError, sprintName, type JiraIssueSummary } from "../src/jira-client.js";
import { issueKeyFromInput, issueKeyFromUrl, normalizeIssueKey } from "../src/jira-url.js";
import { issueKeysInText, parseLinksDocument, renderLinksDocument } from "../src/links.js";
import { resultFromError, snapshotFromIssue, statusLabelFor } from "../src/status.js";
import { desiredLabels, mergeRequests, planLabels, registryFrom, statusLabelName } from "../src/label-sync.js";
import { HOST_LABEL_COLORS, importInstruction, labelColor, labelNames, matchLabels, priorityFromJira } from "../src/import.js";

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
