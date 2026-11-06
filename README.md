# paperclip-plugin-jira

Plugin [Paperclip](https://github.com/paperclipai/paperclip) qui lie une tâche à un ou plusieurs tickets **Jira Cloud** et affiche leur statut. Le plugin ne fait que lire Jira : il n'y écrit jamais.

## Fonctionnalités

| Quoi | Comment |
|---|---|
| **Pastille de statut native** | Une URL de ticket (`https://<site>.atlassian.net/browse/ABC-123`) collée dans le titre, la description, un commentaire ou un document d'une tâche est reconnue par Paperclip. L'hôte affiche alors la pastille de statut : ouvert, en cours ou terminé. Le plugin s'appuie sur le mécanisme natif `objectReferences`, sans stockage ni rendu maison. |
| **Bouton « Jira » dans la barre du haut** | Toujours visible, quel que soit l'affichage des tâches (chat ou classique). Il suit la tâche affichée : **tâche liée** → le bouton devient `ABC-123 ↗` et ouvre le ticket dans Jira, le bouton **⋯** à côté ouvre ses tickets (statut, résumé, assigné, **Ouvrir dans Jira**, **Délier**, et *Lier un autre ticket*, replié) ; **tâche sans ticket** → **Jira** ouvre directement la recherche (clé `ABC-123`, URL ou texte) ; **hors tâche** → **Jira** propose de créer une tâche depuis un ticket. Un ticket cité dans la description compte comme lié. |
| **Page « Jira »** (barre latérale) | Toutes les tâches liées à un ticket, avec les deux statuts côte à côte. Le filtre **Écarts** fait ressortir un ticket terminé dont la tâche est encore ouverte, ou une tâche terminée dont le ticket est encore ouvert. Elle s'appuie sur les liens détectés par Paperclip : URL collée dans une tâche, un commentaire ou le document `jira`. |
| **Créer une tâche depuis un ticket** | Depuis la page Jira ou le bouton du haut : une clé, une URL, une recherche, ou **Mes tickets assignés** (non terminés). La tâche reprend les propriétés du ticket : titre `[ABC-123] résumé`, **priorité** (Highest/Blocker → critique, High/Major → haute, Medium → moyenne, Low/Minor → basse), **libellés** (type du ticket et libellés Jira : réutilisés par nom, créés sinon). Sa description commence par l'**instruction** `Lance \`/ticket ABC-123\` sur ce ticket.` (réglable), puis le lien du ticket (la pastille de statut apparaît aussitôt), un tableau des propriétés Jira (type, statut, assigné, rapporteur, parent, composants, versions, échéance…) et la description convertie en markdown. Un ticket déjà lié à une tâche est signalé avant de créer un doublon. Avant création, une **fiche préremplie** permet de tout ajuster : **agent assigné** (le dernier choisi ; la tâche part alors en `todo` et l'agent la prend en charge), **projet du sprint** (projet du même nom, ou du même numéro « BO Sprint 22 » ↔ « Sprint 22 » ; s'il n'existe pas, il est créé avec l'objectif et la date de fin du sprint), **objectif** (celui du projet, sinon le dernier choisi), **tâche parente** (la tâche du ticket parent, épopée comprise, si elle existe), **priorité**. Entrée crée la tâche. |
| **Ligne « External objects »** | Dans le panneau Propriétés d'une tâche, la ligne du ticket affiche `résumé - statut · sprint · assigné` (par exemple `Écran de connexion - En cours · Sprint 42 · Marie Dupont`). Le texte complet est dans l'infobulle si la ligne est coupée. Le sprint (actif, sinon le prochain, sinon le dernier) est trouvé sans configuration : le plugin cherche le champ Sprint de Jira Software du site. |
| **Libellés tenus à jour** | Chaque tâche liée porte l'**état** de son ticket (`Jira : En cours`, couleur selon la catégorie), son **type** (`Story`, `Bug`…) et ses **libellés Jira**. Ils suivent le ticket : quand son statut change dans Jira, `Jira : À faire` est remplacé par `Jira : En cours` (au rythme de la relecture du ticket par Paperclip, 5 min environ). Délier le ticket retire ses libellés. Seuls les libellés posés par le plugin sont retirés : ceux ajoutés à la main restent, et un libellé retiré à la main n'est remis qu'au prochain changement du ticket. On peut ainsi filtrer la liste des tâches par état Jira. Désactivable dans la configuration. |
| **Mode classique** | L'onglet **Jira** reste disponible quand l'interface classique des tâches est activée ; le bouton du haut sert dans les deux modes. |
| **Outil agent `get_issue`** | Un agent lit un ticket par sa clé, ou tous les tickets d'une tâche par l'`issueId` de celle-ci. Il n'a besoin d'aucun accès direct à Jira. |
| **Fraîcheur** | Le statut est mis en cache 5 min (1 h pour un ticket terminé) et considéré comme périmé après 30 min. Le rafraîchissement se fait par lot, avec une seule requête JQL `key in (...)` pour 50 tickets. |

### Où sont stockés les liens

Un lien explicite est écrit dans un **document de la tâche, de clé `jira`** (« Tickets Jira liés »), sous forme d'une simple liste d'URL. Ce choix présente trois avantages :

- une seule source de vérité, lisible par les humains comme par les agents, avec l'historique des révisions de Paperclip ;
- la pastille native apparaît aussi pour ces liens, puisque Paperclip analyse les URL des documents ;
- désinstaller le plugin ne fait rien perdre : le document reste.

Le worker valide le ticket et calcule le contenu du document. L'UI l'écrit ensuite via l'API HTTP standard de Paperclip, avec la session de l'utilisateur (`PUT/DELETE /api/issues/:id/documents/jira`), et c'est cette route qui déclenche l'analyse des liens. Dans la version actuelle de l'hôte (2026.1023), une écriture faite par le worker (`ctx.issues.documents.upsert`) ne déclencherait pas cette analyse.

### Statuts

| Catégorie Jira | Paperclip | Couleur |
|---|---|---|
| `new` (À faire) | `open` | neutre |
| `indeterminate` (En cours) | `running` | info |
| `done` (Terminé) | `closed` (terminal) | succès |
| Ticket supprimé ou invisible pour le compte | `unknown`, libellé « Introuvable » | grisé |
| 401 / 403 | `auth_required` | — |
| Jira injoignable, 429, 5xx | `unreachable` (avec `retryAfter`) | — |

Le statut affiché est le nom réel du statut dans votre workflow (« En revue », « QA »…). Seule la catégorie est normalisée.

## Installation

Prérequis : Node ≥ 24.11 et une instance Paperclip ≥ 2026.1023.

```bash
git clone https://github.com/TheodoreRiant/paperclip-plugin-jira.git
cd paperclip-plugin-jira
npm install
npm run check          # typecheck + tests + build
paperclipai plugin install --local "$PWD"
```

Le chemin du dossier est obligatoire (sinon : `error: missing required argument 'package'`). Lancez la commande avec un compte qui a l'accès board : un agent reçoit `403 Board access required`.

### Mettre à jour

Quand une nouvelle version ajoute des capacités, l'hôte (2026.1023) refuse la mise à jour en place. Désinstallez sans `--force`, ce qui **conserve la configuration**, puis réinstallez :

```bash
npm run check
paperclipai plugin uninstall theodoreriant.jira-link
paperclipai plugin install --local "$PWD"
```

Rechargez ensuite la page de Paperclip dans le navigateur.

## Configuration

1. Créez un jeton d'API Atlassian sur [id.atlassian.com → Sécurité → Jetons d'API](https://id.atlassian.com/manage-profile/security/api-tokens). De préférence, utilisez un compte de service qui ne peut que *parcourir* les projets concernés : le plugin ne voit que ce que ce compte voit.
2. Dans Paperclip, enregistrez le jeton comme **secret**.
3. Ouvrez Réglages → Plugins → **Jira link** et renseignez :
   - **Site Jira Cloud**, par exemple `https://acme.atlassian.net` ;
   - **E-mail du compte Atlassian** ;
   - **Jeton d'API** : choisissez le secret créé à l'étape 2. Le jeton n'apparaît jamais en clair dans la configuration ;
   - **Instruction des tâches créées depuis un ticket** (facultatif, `/ticket` par défaut) : commande placée en tête de la tâche, suivie de la clé. Laissez vide pour ne mettre aucune instruction ;
   - **Tenir les libellés à jour depuis Jira** (activé par défaut).
4. Cliquez sur **Tester la connexion**. Le plugin appelle `/rest/api/3/myself` et affiche le nom du compte connecté.

La configuration se fait par société : chaque société Paperclip peut pointer vers son propre site Jira.

## Capacités demandées

`external.objects.detect`, `external.objects.read`, `external.objects.refresh`, `http.outbound`, `secrets.read-ref`, `issues.read`, `issues.update`, `issue.documents.read`, `plugin.state.read`, `plugin.state.write`, `agent.tools.register`, `ui.detailTab.register`, `ui.action.register`, `ui.page.register`, `ui.sidebar.register`.

Seule écriture du worker : les **libellés** des tâches liées (`issues.update`, champ `labelIds` uniquement), pour les tenir à jour depuis Jira. Chaque changement ajoute une ligne à l'activité de la tâche. L'état du plugin (`plugin.state.*`) garde l'index ticket → tâches et les libellés posés par le plugin. L'écriture du document `jira`, la création de tâche et la **création des libellés** passent par la session de l'utilisateur, avec ses propres droits. La page Jira lit les liens via l'API de Paperclip (`GET /api/companies/:id/issues`, `POST /api/companies/:id/issues/external-object-summaries`), avec les mêmes droits.

### Comment les libellés sont tenus à jour

Paperclip relit chaque ticket environ toutes les 5 minutes (`onResolveExternalObject`), sans dire à quelles tâches il appartient. Le plugin tient donc un index ticket → tâches, alimenté par la détection d'un lien, l'affichage d'une tâche (bouton du haut) et la page Jira (qui transmet tous les liens connus). À chaque relecture, il compare les libellés voulus à ceux qu'il a déjà posés et n'écrit que s'ils diffèrent.

Un worker ne peut pas créer de libellé dans cette version de l'hôte. Les libellés manquants sont donc demandés à l'interface : le bouton « Jira » de la barre du haut, présent sur toutes les pages, les crée avec votre session (couleurs de la palette Paperclip), puis le worker les pose. Tant que Paperclip n'est ouvert dans aucun navigateur, un nouvel état Jira attend donc sa création.

## Développement

```bash
npm test               # vitest : harnais du SDK + faux Jira
npm run typecheck
npm run build          # dist/manifest.js, dist/worker.js, dist/ui/index.js
```

```
src/
  manifest.ts      manifeste (provider `jira`, outil, emplacements d'UI)
  worker.ts        détection, résolution, rafraîchissement, actions UI, outil agent
  jira-client.ts   client REST Jira Cloud v3 (lecture seule)
  jira-url.ts      reconnaissance des clés et URL de tickets
  links.ts         lecture/écriture du document `jira`
  status.ts        correspondance statuts Jira → Paperclip
  adf.ts           description Jira (Atlassian Document Format) → markdown
  import.ts        tâche créée depuis un ticket : contenu, sprint ↔ projet, choix par défaut
  label-sync.ts    libellés voulus sur une tâche et calcul des changements
  overview.ts      page Jira : rapprochement tâches ↔ tickets, écarts de statut
  ui/index.tsx     contenu des fenêtres Jira, page et lien latéral, onglet classique
  ui/primitives.tsx  briques d'interface reprises de Paperclip (Button, Input, Command…)
tests/
```

## Interface

L'interface suit le design system de Paperclip (shadcn/ui, Tailwind CSS v4, icônes Lucide) :

- le bouton **« Jira »** est un slot `globalToolbarButton` (un *launcher* aurait un libellé fixe) : il reprend la recette des boutons de cette barre (`Button` outline, `h-8`), et sa fenêtre reprend la coque des fenêtres de launcher de l'hôte (voile, en-tête, *Close*, Échap, clic à côté) ;
- le contenu reprend mot pour mot les recettes des composants de l'hôte (`Button`, `Input`, `Command`, filtres rapides, statuts des objets externes et des tâches) et ses tokens (`bg-background`, `text-muted-foreground`, `--status-task-icon-*`…), et utilise les composants partagés du SDK (`DataTable`, `Spinner`) ;
- aucune couleur, taille ou police propre au plugin : le thème clair/sombre de Paperclip s'applique tel quel.

Tailwind ne compile que les classes que Paperclip emploie lui-même. `tests/ui-classes.test.ts` vérifie donc que chaque classe du plugin existe dans la feuille de style de l'instance installée (`PAPERCLIP_UI_DIST` pour pointer ailleurs ; test ignoré sans installation). `tests/ui-render.test.tsx` affiche chaque écran avec un hôte simulé et refuse tout style en ligne propre au plugin.

## Limites connues

- **Jira Cloud uniquement** : pas de Data Center ou Server (PAT, API v2).
- **Lecture seule côté Jira** : pas de transition de statut, pas de commentaires croisés, pas de création de ticket depuis une tâche.
- La page Jira analyse les 1 000 tâches les plus récentes de la société.
- Les pièces jointes d'un ticket ne sont pas reprises dans la tâche créée.
- Le bouton du haut lit la tâche ouverte dans l'URL (`/<préfixe>/issues/<ID>`) : l'hôte ne transmet pas la tâche courante à cet emplacement.
- L'identifiant stable d'un ticket est sa **clé**. Un ticket déplacé dans un autre projet change de clé : il apparaîtra « Introuvable » jusqu'à ce que le lien soit mis à jour.
- Paperclip ne relit plus un ticket **terminé** : s'il est rouvert dans Jira, sa pastille reste « terminé ». Son libellé d'état, lui, est corrigé dès que la tâche est affichée ou que la page Jira est ouverte.
- Les libellés suivent les tickets liés par le plugin ou cités dans le titre ou la description, pas ceux seulement cités dans un commentaire.
- L'authentification se fait par e-mail et jeton d'API, pas encore en OAuth 3LO.

## Licence

MIT
