import { describe, expect, it } from "vitest";
import { adfToMarkdown, MAX_DESCRIPTION_LENGTH } from "../src/adf.js";
import { draftTaskFromTicket, MAX_TITLE_LENGTH } from "../src/import.js";
import { buildOverview, gapFor, taskRefFromPath, tasksByKey, type ExternalObjectLite, type TaskLite } from "../src/overview.js";
import type { JiraIssueSummary } from "../src/jira-client.js";

const text = (t: string, marks?: unknown[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const para = (...content: unknown[]) => ({ type: "paragraph", content });

describe("adfToMarkdown", () => {
  it("convertit titres, paragraphes, marques et liens", () => {
    const md = adfToMarkdown({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("Contexte")] },
        para(text("gras", [{ type: "strong" }]), text(" et "), text("lien", [{ type: "link", attrs: { href: "https://x.io" } }])),
        para(text("code", [{ type: "code" }]), { type: "hardBreak" }, text("ligne 2")),
      ],
    });
    expect(md).toBe("## Contexte\n\n**gras** et [lien](https://x.io)\n\n`code`\nligne 2");
  });

  it("convertit listes imbriquées, tâches, code et citations", () => {
    const md = adfToMarkdown({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [para(text("un")), { type: "orderedList", content: [{ type: "listItem", content: [para(text("un.a"))] }] }],
            },
            { type: "listItem", content: [para(text("deux"))] },
          ],
        },
        { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("fait")] }] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;")] },
        { type: "blockquote", content: [para(text("cité"))] },
      ],
    });
    expect(md).toBe(
      ["- un\n  1. un.a\n- deux", "- [x] fait", "```ts\nconst a = 1;\n```", "> cité"].join("\n\n"),
    );
  });

  it("tableaux, mentions et nœuds inconnus réduits à leur texte", () => {
    const md = adfToMarkdown({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [para(text("A"))] }, { type: "tableHeader", content: [para(text("B"))] }] },
            { type: "tableRow", content: [{ type: "tableCell", content: [para(text("1|2"))] }, { type: "tableCell", content: [para({ type: "mention", attrs: { text: "@Alice" } })] }] },
          ],
        },
        { type: "nouveauNoeud", content: [para(text("conservé"))] },
      ],
    });
    expect(md).toBe("| A | B |\n| --- | --- |\n| 1\\|2 | @Alice |\n\nconservé");
  });

  it("vide ou invalide → chaîne vide ; texte brut conservé ; très long → tronqué", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(42)).toBe("");
    expect(adfToMarkdown("  brut ")).toBe("brut");
    const long = adfToMarkdown({ type: "doc", content: [para(text("x".repeat(MAX_DESCRIPTION_LENGTH + 10)))] });
    expect(long).toMatch(/_\(description tronquée\)_$/);
  });
});

describe("draftTaskFromTicket", () => {
  const issue: JiraIssueSummary = {
    id: "1",
    key: "ABC-1",
    url: "https://acme.atlassian.net/browse/ABC-1",
    summary: "  Écran\nde connexion ",
    issueType: "Bug",
    statusName: "À faire",
    statusCategoryKey: "new",
    assignee: null,
    priority: "High",
    updated: null,
    labels: [],
    sprint: null,
  };

  it("titre préfixé par la clé ; instruction, lien, propriétés puis description", () => {
    const draft = draftTaskFromTicket(issue, "Détails", undefined, "/ticket");
    expect(draft.title).toBe("[ABC-1] Écran de connexion");
    expect(draft.description).toBe(
      [
        "Lance `/ticket ABC-1` sur ce ticket.",
        "Ticket Jira : [ABC-1](https://acme.atlassian.net/browse/ABC-1)",
        "| Propriété Jira | Valeur |\n|---|---|\n| Type | Bug |\n| Statut | À faire |\n| Priorité | High |",
        "---",
        "Détails\n",
      ].join("\n\n"),
    );
    expect(draft.priority).toBe("high");
    expect(draft.labels).toEqual(["Bug"]);
  });

  it("sans description, pas de séparateur ; titre borné", () => {
    const draft = draftTaskFromTicket({ ...issue, summary: "y".repeat(500) }, "  ");
    expect(draft.description).not.toContain("\n\n---\n\n");
    expect(draft.title.length).toBe(MAX_TITLE_LENGTH);
  });
});

describe("écarts de statut", () => {
  const fresh = { liveness: "fresh" };
  it("ticket terminé, tâche ouverte", () => {
    expect(gapFor("in_progress", { ...fresh, statusCategory: "closed", isTerminal: true })).toBe("ticket_done_task_open");
    expect(gapFor("cancelled", { ...fresh, statusCategory: "closed", isTerminal: true })).toBeNull();
  });
  it("tâche terminée, ticket ouvert", () => {
    expect(gapFor("done", { ...fresh, statusCategory: "running", isTerminal: false })).toBe("task_done_ticket_open");
    expect(gapFor("cancelled", { ...fresh, statusCategory: "running", isTerminal: false })).toBeNull();
  });
  it("statut Jira illisible → pas d'écart signalé", () => {
    expect(gapFor("done", { liveness: "auth_required", statusCategory: "auth_required", isTerminal: false })).toBeNull();
    expect(gapFor("done", { ...fresh, statusCategory: "unknown", isTerminal: false })).toBeNull();
  });
});

describe("buildOverview", () => {
  const task = (id: string, status: string): TaskLite => ({ id, identifier: `PAP-${id}`, title: `Tâche ${id}`, status });
  const obj = (key: string, statusCategory: string, isTerminal = false, providerKey = "jira"): ExternalObjectLite => ({
    providerKey,
    displayKey: key,
    displayTitle: `Ticket ${key}`,
    statusCategory,
    liveness: "fresh",
    isTerminal,
  });

  it("ne garde que les objets Jira, sans doublon, écarts d'abord puis tâches ouvertes", () => {
    const rows = buildOverview([task("1", "done"), task("2", "todo"), task("3", "in_progress"), task("4", "todo")], {
      "1": { objects: [obj("ABC-10", "closed", true)] },
      "2": { objects: [obj("ABC-2", "open"), obj("abc-2", "open"), obj("PR-1", "open", false, "github")] },
      "3": { objects: [obj("ABC-3", "closed", true)] },
    });
    expect(rows.map((r) => [r.task.id, r.key, r.gap])).toEqual([
      ["3", "ABC-3", "ticket_done_task_open"],
      ["2", "ABC-2", null],
      ["1", "ABC-10", null],
    ]);
    expect(tasksByKey(rows).get("ABC-2")?.map((t) => t.id)).toEqual(["2"]);
  });
});

describe("taskRefFromPath", () => {
  it("lit l'identifiant de la tâche dans l'URL de l'interface", () => {
    expect(taskRefFromPath("/ISA/issues/ISA-168")).toBe("ISA-168");
    expect(taskRefFromPath("/ISA/issues/ISA-168/activity")).toBe("ISA-168");
    expect(taskRefFromPath("/ISA/issues")).toBeNull();
    expect(taskRefFromPath("/ISA/issues/new")).toBeNull();
    expect(taskRefFromPath("/ISA/jira")).toBeNull();
  });
});
