import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/plugin-sdk";
import type { PluginExternalObjectRecordSnapshot, PluginExternalObjectUrlCandidate } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin, {
  resetSprintFieldCache,
  type LabelRequestsData,
  type ImportedTaskDraft,
  type IssueLinksData,
  type LinkDocumentChange,
  type TicketsData,
} from "../src/worker.js";
import { LINKS_DOCUMENT_KEY, renderLinksDocument } from "../src/links.js";

const COMPANY = "company-1";
const ISSUE_ID = "issue-1";
const HOST = "acme.atlassian.net";
const SITE = `https://${HOST}`;
const CONFIG = {
  siteUrl: SITE,
  email: "bot@acme.io",
  apiToken: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
};

// ── Faux Jira ────────────────────────────────────────────────────────────
interface FakeJiraIssue {
  key: string;
  summary: string;
  status: string;
  category: "new" | "indeterminate" | "done";
  assignedToMe?: boolean;
  description?: unknown;
  /** Champs Jira supplémentaires renvoyés quand ils sont demandés (import). */
  extra?: Record<string, unknown>;
  labels?: string[];
  /** Valeur brute du champ Sprint (liste de sprints Jira Software). */
  sprints?: Array<{ name: string; state: string }>;
}

export const SPRINT_FIELD = "customfield_10020";

class FakeJira {
  issues = new Map<string, FakeJiraIssue>();
  authStatus: number | null = null;
  /** Comme le vrai Jira : JQL `key in (...)` → 400 si une clé n'existe pas. */
  rejectUnknownKeysInJql = false;
  calls: string[] = [];
  /** Tickets « consultés récemment » renvoyés par le picker pour une requête vide. */
  recent: string[] = [];
  lastAuthorization: string | null = null;
  /** Le site a-t-il Jira Software (champ Sprint) ? */
  hasSprintField = false;

  add(key: string, summary: string, status = "À faire", category: FakeJiraIssue["category"] = "new") {
    this.issues.set(key, { key, summary, status, category });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    this.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    this.lastAuthorization = new Headers(init?.headers).get("authorization");
    if (url.host !== HOST) return json(404, {});
    if (this.authStatus) return json(this.authStatus, { errorMessages: ["Unauthorized"] });

    if (url.pathname === "/rest/api/3/myself") return json(200, { displayName: "Bot", accountId: "a1" });

    if (url.pathname === "/rest/api/3/field") {
      const fields: unknown[] = [{ id: "summary", schema: { type: "string", system: "summary" } }];
      if (this.hasSprintField) fields.push({ id: SPRINT_FIELD, schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" } });
      return json(200, fields);
    }

    // Comme Jira : vide → historique ; sinon début de clé ou début de mot du résumé.
    if (url.pathname === "/rest/api/3/issue/picker") {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const all = [...this.issues.values()];
      const hits = q
        ? all.filter((i) => i.key.toLowerCase().startsWith(q) || i.summary.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
        : all.filter((i) => this.recent.includes(i.key));
      const issues = hits.map((i) => ({ key: i.key, summaryText: i.summary, summary: `<b>${i.summary}</b>` }));
      return json(200, { sections: [{ id: q ? "cs" : "hs", issues }] });
    }

    const single = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(url.pathname);
    if (single?.[1]) {
      const issue = this.issues.get(decodeURIComponent(single[1]));
      if (!issue) return json(404, { errorMessages: ["Issue does not exist"] });
      const body = this.toJson(issue);
      const fields = url.searchParams.get("fields")?.split(",") ?? [];
      if (fields.includes("description")) Object.assign(body.fields, { description: issue.description ?? null });
      for (const [name, value] of Object.entries(issue.extra ?? {})) {
        if (fields.includes(name)) Object.assign(body.fields, { [name]: value });
      }
      if (!fields.includes(SPRINT_FIELD)) delete (body.fields as Record<string, unknown>)[SPRINT_FIELD];
      return json(200, body);
    }

    if (url.pathname === "/rest/api/3/search/jql" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { jql: string };
      const keyList = /^key in \(([^)]*)\)$/.exec(body.jql);
      if (keyList?.[1] !== undefined) {
        const keys = keyList[1].split(",").map((k) => k.trim());
        if (this.rejectUnknownKeysInJql && keys.some((k) => !this.issues.has(k))) {
          return json(400, { errorMessages: ["The value does not exist for the field 'key'."] });
        }
        return json(200, { issues: keys.flatMap((k) => (this.issues.has(k) ? [this.toJson(this.issues.get(k)!)] : [])) });
      }
      if (body.jql.startsWith("assignee = currentUser()")) {
        const mine = [...this.issues.values()].filter((i) => i.assignedToMe && i.category !== "done");
        return json(200, { issues: mine.map((i) => this.toJson(i)) });
      }
      const text = (/^text ~ "(.*)" ORDER BY updated DESC$/.exec(body.jql)?.[1] ?? "").replace(/\*$/, "");
      const matches = [...this.issues.values()].filter((i) => i.summary.toLowerCase().includes(text.toLowerCase()));
      return json(200, { issues: matches.map((i) => this.toJson(i)) });
    }
    return json(404, {});
  };

  private toJson(issue: FakeJiraIssue) {
    return {
      id: String(10000 + [...this.issues.keys()].indexOf(issue.key)),
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: { name: issue.status, statusCategory: { key: issue.category } },
        issuetype: { name: "Story" },
        assignee: { displayName: "Alice" },
        priority: { name: "Medium" },
        updated: "2026-11-01T10:00:00.000+0100",
        labels: issue.labels ?? [],
        ...(this.hasSprintField ? { [SPRINT_FIELD]: issue.sprints ?? null } : {}),
      },
    };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function candidate(url: string): PluginExternalObjectUrlCandidate {
  return {
    sanitizedCanonicalUrl: url,
    sanitizedDisplayUrl: url,
    canonicalIdentityHash: `hash:${url}`,
    canonicalIdentity: {},
    redactedMatchedText: url,
  };
}

function objectRecord(id: string, key: string): PluginExternalObjectRecordSnapshot {
  return {
    id,
    companyId: COMPANY,
    providerKey: "jira",
    objectType: "issue",
    externalId: key,
    sanitizedCanonicalUrl: `${SITE}/browse/${key}`,
    canonicalIdentityHash: null,
    displayKey: key,
    iconKey: null,
    displayTitle: null,
    statusKey: null,
    statusLabel: null,
    statusIconKey: null,
    statusCategory: "unknown",
    statusTone: "neutral",
    liveness: "unknown",
    isTerminal: false,
    data: {},
    remoteVersion: null,
    etag: null,
  };
}

// ── Mise en place ────────────────────────────────────────────────────────
let jira: FakeJira;
let harness: TestHarness;
const def = plugin.definition;

async function setupHarness(config: Record<string, unknown> = CONFIG) {
  harness = createTestHarness({
    manifest,
    config,
    // Écriture de documents uniquement pour préparer les données de test :
    // le plugin lui-même ne la demande pas.
    capabilities: [...manifest.capabilities, "issue.documents.write"],
  });
  harness.seed({
    issues: [
      {
        id: ISSUE_ID,
        companyId: COMPANY,
        title: "Corriger la connexion",
        description: `Contexte : ${SITE}/browse/ABC-7 et un tableau ${SITE}/jira/software/projects/ABC/boards/1`,
      } as unknown as Issue,
    ],
  });
  await def.setup(harness.ctx);
}

async function writeLinksDocument(keys: string[]) {
  await harness.ctx.issues.documents.upsert({
    issueId: ISSUE_ID,
    companyId: COMPANY,
    key: LINKS_DOCUMENT_KEY,
    body: renderLinksDocument(SITE, keys.map((key) => ({ key }))),
  });
}

beforeEach(async () => {
  jira = new FakeJira();
  jira.add("ABC-1", "Écran de connexion", "En cours", "indeterminate");
  jira.add("ABC-2", "Export comptable", "Terminé", "done");
  jira.add("ABC-7", "Erreur 500 à la connexion");
  vi.stubGlobal("fetch", jira.fetch);
  resetSprintFieldCache();
  await setupHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────
describe("détection des URL (pastille native)", () => {
  it("ne retient que les tickets du site configuré", async () => {
    const result = await def.onDetectExternalObjects!({
      companyId: COMPANY,
      sourceContext: {
        companyId: COMPANY,
        sourceIssueId: ISSUE_ID,
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
      urls: [
        candidate(`${SITE}/browse/ABC-1`),
        candidate("https://other.atlassian.net/browse/ABC-1"),
        candidate(`${SITE}/jira/software/projects/ABC/boards/1`),
      ],
    });
    expect(result.detections).toEqual([
      {
        urlIdentityHash: `hash:${SITE}/browse/ABC-1`,
        providerKey: "jira",
        objectType: "issue",
        externalId: "ABC-1",
        displayKey: "ABC-1",
        iconKey: "jira",
        confidence: "exact",
      },
    ]);
  });

  it("ne détecte rien tant que le plugin n'est pas configuré", async () => {
    await setupHarness({});
    const result = await def.onDetectExternalObjects!({
      companyId: COMPANY,
      sourceContext: {} as never,
      urls: [candidate(`${SITE}/browse/ABC-1`)],
    });
    expect(result.detections).toEqual([]);
  });
});

describe("résolution du statut", () => {
  it("lit le ticket et normalise son statut, avec authentification Basic", async () => {
    const result = await def.onResolveExternalObject!({
      companyId: COMPANY,
      providerKey: "jira",
      objectType: "issue",
      externalId: "ABC-1",
      object: objectRecord("o1", "ABC-1"),
    });
    expect(result).toMatchObject({
      ok: true,
      snapshot: { statusLabel: "En cours · Alice", statusCategory: "running", displayTitle: "Écran de connexion" },
    });
    expect(jira.lastAuthorization).toMatch(/^Basic /);
  });

  it("401 → auth_required", async () => {
    jira.authStatus = 401;
    const result = await def.onResolveExternalObject!({
      companyId: COMPANY,
      providerKey: "jira",
      objectType: "issue",
      externalId: "ABC-1",
      object: objectRecord("o1", "ABC-1"),
    });
    expect(result).toMatchObject({ ok: false, liveness: "auth_required", errorCode: "jira_auth" });
  });

  it("ticket inexistant → pastille « Introuvable », pas une panne", async () => {
    const result = await def.onResolveExternalObject!({
      companyId: COMPANY,
      providerKey: "jira",
      objectType: "issue",
      externalId: "ABC-404",
      object: objectRecord("o1", "ABC-404"),
    });
    expect(result).toMatchObject({ ok: true, snapshot: { statusLabel: "Introuvable" } });
  });

  it("plugin non configuré → auth_required", async () => {
    await setupHarness({});
    const result = await def.onResolveExternalObject!({
      companyId: COMPANY,
      providerKey: "jira",
      objectType: "issue",
      externalId: "ABC-1",
      object: objectRecord("o1", "ABC-1"),
    });
    expect(result).toMatchObject({ ok: false, liveness: "auth_required", errorCode: "jira_not_configured" });
  });

  it("rafraîchit par lot en une seule recherche JQL", async () => {
    const result = await def.onRefreshExternalObjects!({
      companyId: COMPANY,
      objects: [objectRecord("o1", "ABC-1"), objectRecord("o2", "ABC-2"), objectRecord("o3", "ABC-404")],
    });
    // La recherche du champ Sprint, faite une seule fois par site, mise à part.
    expect(jira.calls.filter((c) => c !== "GET /rest/api/3/field")).toEqual(["POST /rest/api/3/search/jql"]);
    expect(result.results).toMatchObject([
      { objectId: "o1", result: { ok: true, snapshot: { statusCategory: "running" } } },
      { objectId: "o2", result: { ok: true, snapshot: { statusCategory: "closed", isTerminal: true } } },
      { objectId: "o3", result: { ok: true, snapshot: { statusLabel: "Introuvable" } } },
    ]);
  });

  it("si Jira rejette le lot (clé inconnue), retombe sur des lectures unitaires", async () => {
    jira.rejectUnknownKeysInJql = true;
    const result = await def.onRefreshExternalObjects!({
      companyId: COMPANY,
      objects: [objectRecord("o1", "ABC-1"), objectRecord("o3", "ZZ-1")],
    });
    expect(result.results).toMatchObject([
      { objectId: "o1", result: { ok: true, snapshot: { statusCategory: "running" } } },
      { objectId: "o3", result: { ok: true, snapshot: { statusLabel: "Introuvable" } } },
    ]);
  });

  it("rafraîchissement en échec d'authentification → tous les objets en auth_required", async () => {
    jira.authStatus = 403;
    const result = await def.onRefreshExternalObjects!({
      companyId: COMPANY,
      objects: [objectRecord("o1", "ABC-1"), objectRecord("o2", "ABC-2")],
    });
    expect(result.results.map((r) => r.result)).toMatchObject([
      { ok: false, liveness: "auth_required" },
      { ok: false, liveness: "auth_required" },
    ]);
  });
});

describe("lier / délier", () => {
  it("prépare le document `jira` avec le ticket validé auprès de Jira", async () => {
    const change = await harness.performAction<LinkDocumentChange>(
      "prepare-link",
      { issueId: ISSUE_ID, input: `${SITE}/browse/abc-1` },
      { companyId: COMPANY },
    );
    expect(change).toMatchObject({ key: "ABC-1", alreadyLinked: false, documentKey: "jira", baseRevisionId: null });
    expect(change.documentBody).toContain(`- [ABC-1](${SITE}/browse/ABC-1) — Écran de connexion`);
  });

  it("ajoute au document existant et signale un ticket déjà lié", async () => {
    await writeLinksDocument(["ABC-2"]);
    const added = await harness.performAction<LinkDocumentChange>(
      "prepare-link",
      { issueId: ISSUE_ID, input: "ABC-1" },
      { companyId: COMPANY },
    );
    expect(added.baseRevisionId).not.toBeNull();
    expect(added.documentBody?.match(/^- \[/gm)).toHaveLength(2);

    const again = await harness.performAction<LinkDocumentChange>(
      "prepare-link",
      { issueId: ISSUE_ID, input: "ABC-2" },
      { companyId: COMPANY },
    );
    expect(again).toMatchObject({ alreadyLinked: true, documentBody: null });
  });

  it("refuse un ticket inexistant ou une saisie invalide", async () => {
    await expect(
      harness.performAction("prepare-link", { issueId: ISSUE_ID, input: "ABC-404" }, { companyId: COMPANY }),
    ).rejects.toThrow(/introuvable/i);
    await expect(
      harness.performAction(
        "prepare-link",
        { issueId: ISSUE_ID, input: "https://other.atlassian.net/browse/ABC-1" },
        { companyId: COMPANY },
      ),
    ).rejects.toThrow(/ni une clé Jira/);
  });

  it("délier le dernier ticket demande la suppression du document", async () => {
    await writeLinksDocument(["ABC-1", "ABC-2"]);
    const partial = await harness.performAction<LinkDocumentChange>(
      "prepare-unlink",
      { issueId: ISSUE_ID, key: "abc-1" },
      { companyId: COMPANY },
    );
    expect(partial.documentBody).not.toContain("ABC-1]");
    expect(partial.documentBody).toContain("ABC-2]");

    await writeLinksDocument(["ABC-2"]);
    const last = await harness.performAction<LinkDocumentChange>(
      "prepare-unlink",
      { issueId: ISSUE_ID, key: "ABC-2" },
      { companyId: COMPANY },
    );
    expect(last.documentBody).toBeNull();
  });

  it("recherche : une clé lit le ticket, un texte lance une recherche", async () => {
    const byKey = await harness.performAction<{ results: unknown[] }>("search", { text: "ABC-2" }, { companyId: COMPANY });
    expect(byKey.results).toMatchObject([{ key: "ABC-2" }]);
    const byText = await harness.performAction<{ results: unknown[] }>("search", { text: "connexion" }, { companyId: COMPANY });
    expect(byText.results).toMatchObject([{ key: "ABC-1" }, { key: "ABC-7" }]);
  });

  describe("suggestions pendant la frappe", () => {
    type Suggest = { recent: boolean; results: { key: string; statusName: string; summary: string }[] };
    const suggest = (query: string) => harness.performAction<Suggest>("suggest", { query }, { companyId: COMPANY });

    it("propose les tickets dès un début de mot, avec leur statut", async () => {
      const r = await suggest("conn");
      expect(r.recent).toBe(false);
      expect(r.results.map((i) => i.key).sort()).toEqual(["ABC-1", "ABC-7"]);
      expect(r.results.every((i) => i.statusName !== "Inconnu")).toBe(true);
    });

    it("propose les tickets d'une clé partielle", async () => {
      jira.add("ABC-21", "Autre ticket");
      const r = await suggest("abc-2");
      expect(r.results.map((i) => i.key)).toEqual(["ABC-2", "ABC-21"]);
    });

    it("met le ticket exact en tête pour une clé complète, une seule fois", async () => {
      jira.add("ABC-21", "Autre ticket");
      const r = await suggest("ABC-2");
      expect(r.results.map((i) => i.key)).toEqual(["ABC-2", "ABC-21"]);
    });

    it("une URL donne uniquement son ticket", async () => {
      const r = await suggest(`${SITE}/browse/ABC-7`);
      expect(r.results.map((i) => i.key)).toEqual(["ABC-7"]);
    });

    it("champ vide : tickets consultés récemment", async () => {
      jira.recent = ["ABC-7"];
      const r = await suggest("");
      expect(r).toMatchObject({ recent: true, results: [{ key: "ABC-7" }] });
    });

    it("se rabat sur la recherche plein texte quand Jira ne suggère rien", async () => {
      const r = await suggest("onnex");
      expect(r.results.map((i) => i.key).sort()).toEqual(["ABC-1", "ABC-7"]);
      expect(jira.calls).toContain("GET /rest/api/3/issue/picker");
    });

    it("rien du tout : liste vide, sans erreur", async () => {
      expect((await suggest("zzzz")).results).toEqual([]);
    });
  });
});

describe("onglet Jira", () => {
  it("liste les tickets liés et ceux cités dans la description", async () => {
    await writeLinksDocument(["ABC-1"]);
    const data = await harness.getData<IssueLinksData>("issue-links", { companyId: COMPANY, issueId: ISSUE_ID });
    expect(data.configured).toBe(true);
    expect(data.linked).toMatchObject([{ key: "ABC-1", issue: { statusName: "En cours" } }]);
    expect(data.mentioned).toMatchObject([{ key: "ABC-7", issue: { summary: "Erreur 500 à la connexion" } }]);
  });

  it("sans tâche (bouton de la barre du haut hors tâche) : aucun ticket, sans erreur", async () => {
    const data = await harness.getData<IssueLinksData>("issue-links", { companyId: COMPANY });
    expect(data).toMatchObject({ configured: true, linked: [], mentioned: [] });
  });

  it("explique la configuration manquante", async () => {
    await setupHarness({ siteUrl: SITE });
    const data = await harness.getData<IssueLinksData>("issue-links", { companyId: COMPANY, issueId: ISSUE_ID });
    expect(data.configured).toBe(false);
    expect(data.configErrors.length).toBeGreaterThan(0);
  });
});

describe("outil agent get_issue", () => {
  const runCtx = { agentId: "agent-1", runId: "run-1", companyId: COMPANY, projectId: "p1" };

  it("lit un ticket par clé", async () => {
    const result = await harness.executeTool<{ content?: string }>("get_issue", { key: "ABC-2" }, runCtx);
    expect(result.content).toContain("ABC-2 — Export comptable");
    expect(result.content).toContain("Statut : Terminé");
  });

  it("lit les tickets liés et cités d'une tâche", async () => {
    await writeLinksDocument(["ABC-1"]);
    const result = await harness.executeTool<{ data: { tickets: Array<{ key: string }> } }>(
      "get_issue",
      { issueId: ISSUE_ID },
      runCtx,
    );
    expect(result.data.tickets.map((t) => t.key)).toEqual(["ABC-1", "ABC-7"]);
  });

  it("renvoie une erreur lisible plutôt que de lever", async () => {
    jira.authStatus = 401;
    const result = await harness.executeTool<{ error?: string }>("get_issue", { key: "ABC-1" }, runCtx);
    expect(result.error).toMatch(/refuse l'accès \(401\)/);
  });
});

describe("tester la connexion", () => {
  it("valide les identifiants via /myself", async () => {
    const result = await def.onValidateConfig!(CONFIG);
    expect(result).toMatchObject({ ok: true, warnings: ["Connecté à Jira en tant que Bot."] });
  });

  it("signale des identifiants refusés", async () => {
    jira.authStatus = 401;
    const result = await def.onValidateConfig!(CONFIG);
    expect(result.ok).toBe(false);
  });
});

describe("page Jira", () => {
  it("relit le statut détaillé des tickets listés, clés normalisées et dédoublonnées", async () => {
    const data = await harness.getData<TicketsData>("tickets", { companyId: COMPANY, keys: ["abc-1", "ABC-1", "ABC-2", "pas une clé"] });
    expect(data.configured).toBe(true);
    expect(Object.keys(data.tickets).sort()).toEqual(["ABC-1", "ABC-2"]);
    expect(data.tickets["ABC-2"]).toMatchObject({ issue: { statusName: "Terminé" } });
    expect(jira.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("ne contacte pas Jira quand la liste est vide", async () => {
    const data = await harness.getData<TicketsData>("tickets", { companyId: COMPANY, keys: [] });
    expect(data.tickets).toEqual({});
    expect(jira.calls).toEqual([]);
  });

  it("signale une configuration manquante", async () => {
    await setupHarness({ siteUrl: SITE });
    const data = await harness.getData<TicketsData>("tickets", { companyId: COMPANY, keys: ["ABC-1"] });
    expect(data.configured).toBe(false);
  });
});

describe("créer une tâche depuis un ticket", () => {
  it("liste mes tickets assignés non terminés", async () => {
    jira.issues.get("ABC-1")!.assignedToMe = true;
    jira.issues.get("ABC-2")!.assignedToMe = true; // terminé : exclu
    const mine = await harness.performAction<{ results: Array<{ key: string }> }>("my-tickets", {}, { companyId: COMPANY });
    expect(mine.results.map((r) => r.key)).toEqual(["ABC-1"]);
  });

  it("prépare titre et description, avec l'URL du ticket en tête", async () => {
    jira.issues.get("ABC-1")!.description = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Le bouton ne répond pas." }] }],
    };
    const draft = await harness.performAction<ImportedTaskDraft>(
      "prepare-import",
      { input: `${SITE}/browse/abc-1` },
      { companyId: COMPANY },
    );
    expect(draft.key).toBe("ABC-1");
    expect(draft.title).toBe("[ABC-1] Écran de connexion");
    expect(draft.description.startsWith("Lance `/ticket ABC-1` sur ce ticket.\n\n")).toBe(true);
    expect(draft.description).toContain(`Ticket Jira : [ABC-1](${SITE}/browse/ABC-1)`);
    expect(draft.description).toContain("Le bouton ne répond pas.");
  });

  it("reprend toutes les propriétés du ticket : priorité, libellés, tableau des propriétés", async () => {
    Object.assign(jira.issues.get("ABC-1")!, {
      extra: {
        priority: { name: "Highest" },
        reporter: { displayName: "Bob" },
        labels: ["front", "Story", "connexion"],
        components: [{ name: "Web" }, { name: "Auth" }],
        fixVersions: [{ name: "2026.12" }],
        parent: { key: "ABC-100", fields: { summary: "Refonte | connexion" } },
        duedate: "2026-12-01",
        created: "2026-10-01T09:00:00.000+0200",
      },
    });
    const draft = await harness.performAction<ImportedTaskDraft>("prepare-import", { input: "ABC-1" }, { companyId: COMPANY });
    expect(draft.priority).toBe("critical");
    expect(draft.labels).toEqual(["Story", "front", "connexion"]);
    for (const row of [
      "| Type | Story |",
      "| Statut | En cours |",
      "| Priorité | Highest |",
      "| Assigné | Alice |",
      "| Rapporteur | Bob |",
      `| Parent | [ABC-100](${SITE}/browse/ABC-100) Refonte \\| connexion |`,
      "| Composants | Web, Auth |",
      "| Versions | 2026.12 |",
      "| Échéance | 2026-12-01 |",
      "| Créé le | 2026-10-01 |",
    ]) {
      expect(draft.description).toContain(row);
    }
    const call = jira.calls.at(-1)!;
    expect(call).toBe("GET /rest/api/3/issue/ABC-1");
  });

  it("suit la commande configurée, ou n'en met aucune", async () => {
    await setupHarness({ ...CONFIG, importCommand: "/traite" });
    let draft = await harness.performAction<ImportedTaskDraft>("prepare-import", { input: "ABC-1" }, { companyId: COMPANY });
    expect(draft.description.startsWith("Lance `/traite ABC-1` sur ce ticket.")).toBe(true);

    await setupHarness({ ...CONFIG, importCommand: "  " });
    draft = await harness.performAction<ImportedTaskDraft>("prepare-import", { input: "ABC-1" }, { companyId: COMPANY });
    expect(draft.description.startsWith("Ticket Jira : ")).toBe(true);
    expect(draft.priority).toBe("medium");
  });

  it("transmet le sprint, la tâche du ticket parent et les derniers choix", async () => {
    jira.hasSprintField = true;
    Object.assign(jira.issues.get("ABC-1")!, {
      sprints: [{ name: "Sprint 22", state: "active", startDate: "2026-11-02T08:00:00.000Z", endDate: "2026-11-13T17:00:00.000Z", goal: "Connexion" }],
      extra: { parent: { key: "ABC-100", fields: { summary: "Refonte" } } },
    });
    await harness.performAction("index-created-task", { key: "abc-100", issueId: "task-parent" }, { companyId: COMPANY });
    await harness.performAction("remember-import-choices", { agentId: "agent-1", goalId: "goal-1" }, { companyId: COMPANY });

    const draft = await harness.performAction<ImportedTaskDraft>("prepare-import", { input: "ABC-1" }, { companyId: COMPANY });
    expect(draft.sprint).toEqual({ name: "Sprint 22", state: "active", startDate: "2026-11-02", endDate: "2026-11-13", goal: "Connexion" });
    expect(draft.parentKey).toBe("ABC-100");
    expect(draft.parentTaskIds).toEqual(["task-parent"]);
    expect(draft.preferences).toEqual({ agentId: "agent-1", goalId: "goal-1" });
  });

  it("sans choix mémorisé ni parent : rien n'est proposé", async () => {
    const draft = await harness.performAction<ImportedTaskDraft>("prepare-import", { input: "ABC-1" }, { companyId: COMPANY });
    expect(draft).toMatchObject({ sprint: null, parentKey: null, parentTaskIds: [], preferences: { agentId: null, goalId: null } });
  });

  it("refuse une saisie invalide ou un ticket inexistant", async () => {
    await expect(harness.performAction("prepare-import", { input: "bonjour" }, { companyId: COMPANY })).rejects.toThrow(
      /ni une clé Jira/,
    );
    await expect(harness.performAction("prepare-import", { input: "ABC-999" }, { companyId: COMPANY })).rejects.toThrow(
      /introuvable/,
    );
  });
});

describe("ligne « External objects » enrichie", () => {
  it("ajoute le sprint actif, trouvé sans configuration", async () => {
    jira.hasSprintField = true;
    jira.issues.get("ABC-1")!.sprints = [
      { name: "Sprint 41", state: "closed" },
      { name: "Sprint 42", state: "active" },
    ];
    const result = await def.onResolveExternalObject!({
      companyId: COMPANY,
      providerKey: "jira",
      objectType: "issue",
      externalId: "ABC-1",
      object: objectRecord("o1", "ABC-1"),
    });
    expect(result).toMatchObject({ ok: true, snapshot: { statusLabel: "En cours · Sprint 42 · Alice", data: { sprint: "Sprint 42" } } });
  });

  it("sans Jira Software : pas de sprint, le reste marche", async () => {
    const result = await def.onResolveExternalObject!({
      companyId: COMPANY,
      providerKey: "jira",
      objectType: "issue",
      externalId: "ABC-1",
      object: objectRecord("o1", "ABC-1"),
    });
    expect(result).toMatchObject({ ok: true, snapshot: { statusLabel: "En cours · Alice" } });
    // Le champ Sprint n'est cherché qu'une fois.
    await def.onResolveExternalObject!({ companyId: COMPANY, providerKey: "jira", objectType: "issue", externalId: "ABC-1", object: objectRecord("o1", "ABC-1") });
    expect(jira.calls.filter((c) => c === "GET /rest/api/3/field")).toHaveLength(1);
  });
});

describe("libellés tenus à jour", () => {
  const labelIdsOf = async () => ((await harness.ctx.issues.get(ISSUE_ID, COMPANY)) as unknown as { labelIds?: string[] }).labelIds ?? [];
  const registerAll = (labels: Array<{ id: string; name: string }>) =>
    harness.performAction("register-labels", { companyId: COMPANY, labels });
  const resolve = (key: string) =>
    def.onResolveExternalObject!({ companyId: COMPANY, providerKey: "jira", objectType: "issue", externalId: key, object: objectRecord("o", key) });

  beforeEach(async () => {
    jira.issues.get("ABC-7")!.labels = ["front"];
    await harness.ctx.issues.update(ISSUE_ID, { labelIds: ["manuel"] }, COMPANY);
  });

  it("affiche une tâche : pose l'état, le type et les libellés Jira du ticket, garde les autres", async () => {
    await registerAll([
      { id: "s-todo", name: "Jira : À faire" },
      { id: "t-story", name: "story" },
      { id: "l-front", name: "Front" },
    ]);
    await harness.getData<IssueLinksData>("issue-links", { companyId: COMPANY, issueId: ISSUE_ID });
    expect(await labelIdsOf()).toEqual(["manuel", "s-todo", "t-story", "l-front"]);
  });

  it("le ticket change d'état : l'interface crée le libellé manquant, puis la tâche est mise à jour", async () => {
    await registerAll([
      { id: "s-todo", name: "Jira : À faire" },
      { id: "t-story", name: "Story" },
      { id: "l-front", name: "front" },
    ]);
    await harness.getData("issue-links", { companyId: COMPANY, issueId: ISSUE_ID });

    const ticket = jira.issues.get("ABC-7")!;
    ticket.status = "En cours";
    ticket.category = "indeterminate";
    await resolve("ABC-7");
    // Le libellé « Jira : En cours » n'existe pas encore : l'ancien état est retiré, le nouveau demandé.
    expect(await labelIdsOf()).toEqual(["manuel", "t-story", "l-front"]);
    const requests = await harness.getData<LabelRequestsData>("label-requests", { companyId: COMPANY });
    expect(requests).toEqual({ enabled: true, registryKnown: true, requests: [{ name: "Jira : En cours", color: "#f97316" }] });

    await registerAll([
      { id: "s-todo", name: "Jira : À faire" },
      { id: "s-doing", name: "Jira : En cours" },
      { id: "t-story", name: "Story" },
      { id: "l-front", name: "front" },
    ]);
    expect((await labelIdsOf()).sort()).toEqual(["l-front", "manuel", "s-doing", "t-story"]);
    expect((await harness.getData<LabelRequestsData>("label-requests", { companyId: COMPANY })).requests).toEqual([]);
  });

  it("le ticket ne change pas : aucune écriture sur la tâche", async () => {
    await registerAll([{ id: "s-todo", name: "Jira : À faire" }, { id: "t-story", name: "Story" }, { id: "l-front", name: "front" }]);
    await harness.getData("issue-links", { companyId: COMPANY, issueId: ISSUE_ID });
    const update = vi.spyOn(harness.ctx.issues, "update");
    await resolve("ABC-7");
    await harness.getData("issue-links", { companyId: COMPANY, issueId: ISSUE_ID });
    expect(update).not.toHaveBeenCalled();
  });

  it("un ticket délié : ses libellés sont retirés", async () => {
    await registerAll([
      { id: "s-todo", name: "Jira : À faire" },
      { id: "s-doing", name: "Jira : En cours" },
      { id: "t-story", name: "Story" },
      { id: "l-front", name: "front" },
    ]);
    await harness.ctx.issues.update(ISSUE_ID, { description: "Plus de ticket" }, COMPANY);
    await writeLinksDocument(["ABC-1"]);
    await harness.performAction("sync-issue-labels", { companyId: COMPANY, issueId: ISSUE_ID });
    expect(await labelIdsOf()).toEqual(["manuel", "s-doing", "t-story"]);

    await harness.ctx.issues.documents.delete(ISSUE_ID, LINKS_DOCUMENT_KEY, COMPANY);
    await harness.performAction("sync-issue-labels", { companyId: COMPANY, issueId: ISSUE_ID });
    expect(await labelIdsOf()).toEqual(["manuel"]);
  });

  it("la page Jira transmet les liens : les tâches sont synchronisées en un seul appel Jira", async () => {
    await registerAll([{ id: "s-todo", name: "Jira : À faire" }, { id: "t-story", name: "Story" }, { id: "l-front", name: "front" }]);
    jira.calls = [];
    const result = await harness.performAction<{ synced: number }>("index-links", {
      companyId: COMPANY,
      links: [{ issueId: ISSUE_ID, key: "abc-7" }],
    });
    expect(result.synced).toBe(1);
    expect(await labelIdsOf()).toEqual(["manuel", "s-todo", "t-story", "l-front"]);
    expect(jira.calls.filter((c) => c.includes("/search/jql"))).toHaveLength(1);
  });

  it("avant que l'interface ait transmis les libellés : tout est demandé", async () => {
    await harness.getData("issue-links", { companyId: COMPANY, issueId: ISSUE_ID });
    const requests = await harness.getData<LabelRequestsData>("label-requests", { companyId: COMPANY });
    expect(requests.registryKnown).toBe(false);
    expect(requests.requests.map((r) => r.name)).toEqual(["Jira : À faire", "Story", "front"]);
    expect(await labelIdsOf()).toEqual(["manuel"]);
  });

  it("désactivé dans la configuration : rien n'est touché", async () => {
    await setupHarness({ ...CONFIG, syncLabels: false });
    await harness.ctx.issues.update(ISSUE_ID, { labelIds: ["manuel"] }, COMPANY);
    await registerAll([{ id: "s-todo", name: "Jira : À faire" }]);
    await harness.getData("issue-links", { companyId: COMPANY, issueId: ISSUE_ID });
    expect(await labelIdsOf()).toEqual(["manuel"]);
    expect(await harness.getData<LabelRequestsData>("label-requests", { companyId: COMPANY })).toMatchObject({ enabled: false });
  });
});
