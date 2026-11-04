import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "theodoreriant.jira-link";
export const PROVIDER_KEY = "jira";
export const OBJECT_TYPE = "issue";
export const TOOL_GET_ISSUE = "get_issue";
export const JIRA_PAGE_ROUTE = "jira";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.6.0",
  displayName: "Jira link",
  description:
    "Lie une tâche Paperclip à un ticket Jira Cloud : pastille de statut, bouton « Jira » dans la barre du haut, page Jira (liens, écarts de statut, création de tâche depuis un ticket) libellés d'état et d'étiquettes tenus à jour, et outil de lecture pour les agents. Lecture seule côté Jira.",
  author: "Théodore Riant",
  categories: ["connector"],
  capabilities: [
    "external.objects.detect",
    "external.objects.read",
    "external.objects.refresh",
    "http.outbound",
    "secrets.read-ref",
    "issues.read",
    "issues.update",
    "issue.documents.read",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "ui.detailTab.register",
    "ui.action.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["siteUrl", "email", "apiToken"],
    properties: {
      siteUrl: {
        type: "string",
        title: "Site Jira Cloud",
        description: "Ex. https://acme.atlassian.net",
        format: "uri",
      },
      email: {
        type: "string",
        title: "E-mail du compte Atlassian",
        description: "Compte propriétaire du jeton d'API (de préférence un compte de service en lecture seule).",
      },
      apiToken: {
        title: "Jeton d'API Atlassian",
        description: "Créé sur id.atlassian.com → Sécurité → Jetons d'API. Stocké comme secret Paperclip.",
        format: "secret-ref",
      },
      importCommand: {
        type: "string",
        title: "Instruction des tâches créées depuis un ticket",
        description:
          "Commande à lancer, placée en tête de la tâche et suivie de la clé du ticket (ex. « /ticket » → « Lance `/ticket ABC-123` sur ce ticket. »). Laisser vide pour ne mettre aucune instruction.",
        default: "/ticket",
      },
      syncLabels: {
        type: "boolean",
        title: "Tenir les libellés à jour depuis Jira",
        description:
          "Pose sur chaque tâche liée l'état du ticket (« Jira : En cours »), son type et ses libellés Jira, et les met à jour quand le ticket change. Seuls les libellés posés par le plugin sont retirés.",
        default: true,
      },
    },
  },
  objectReferences: [
    {
      providerKey: PROVIDER_KEY,
      displayName: "Jira",
      objectTypes: [OBJECT_TYPE],
      urlPatterns: [
        "https://<site>.atlassian.net/browse/:key",
        "https://<site>.atlassian.net/jira/software/projects/:project/issues/:key",
      ],
      refreshPolicy: { defaultTtlSeconds: 300, staleAfterSeconds: 1800 },
    },
  ],
  tools: [
    {
      name: TOOL_GET_ISSUE,
      displayName: "Lire un ticket Jira",
      description:
        "Lit un ticket Jira (statut, résumé, type, assigné, priorité). Passer `key` (ex. ABC-123) pour un ticket précis, ou `issueId` (UUID de la tâche Paperclip) pour lire les tickets liés à cette tâche.",
      parametersSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Clé du ticket Jira, ex. ABC-123." },
          issueId: { type: "string", description: "UUID de la tâche Paperclip dont on veut les tickets liés." },
        },
        additionalProperties: false,
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "jira-tab",
        displayName: "Jira",
        exportName: "JiraTab",
        entityTypes: ["issue"],
      },
      {
        type: "sidebar",
        id: "jira-sidebar",
        displayName: "Jira",
        exportName: "JiraSidebarLink",
      },
      {
        type: "page",
        id: "jira-page",
        displayName: "Jira",
        exportName: "JiraPage",
        routePath: JIRA_PAGE_ROUTE,
      },
      {
        // Bouton « Jira » de la barre du haut, visible quel que soit le mode
        // d'affichage des tâches. Slot et non launcher : un launcher a un
        // libellé fixe, alors que ce bouton devient « ABC-123 ↗ » (ouvrir dans
        // Jira) quand la tâche affichée a un ticket. Il remplace aussi l'ancien
        // bouton de la page d'une tâche, qui faisait doublon.
        type: "globalToolbarButton",
        id: "jira-toolbar",
        displayName: "Jira",
        exportName: "JiraToolbarButton",
      },
    ],
  },
};

export default manifest;
