/**
 * Chaque classe utilitaire de l'interface du plugin doit exister dans la
 * feuille de style de Paperclip : Tailwind n'y compile que les classes que
 * l'hôte emploie lui-même, une classe inconnue n'aurait donc aucun effet.
 *
 * La feuille est lue dans l'installation locale de Paperclip
 * (`PAPERCLIP_UI_DIST`, sinon `~/.paperclip/cli/current/…/ui-dist`). Sans
 * installation (CI), le test est ignoré.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const UI_DIR = join(import.meta.dirname, "..", "src", "ui");
const hostUiDist = (home: string) => join(home, ".paperclip", "cli", "current", "node_modules", "@paperclipai", "server", "ui-dist");
const ASSETS =
  [process.env.PAPERCLIP_UI_DIST, hostUiDist(homedir()), hostUiDist(userInfo().homedir)]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => join(dir, "assets"))
    .find((dir) => existsSync(dir)) ?? "";

/** Constantes qui ne contiennent que des classes. */
const CLASS_CONSTANT = /(CLASS|BUTTON_BASE|BUTTON_VARIANTS|BUTTON_SIZES|EXTERNAL_TONE)$/;

function collectClassStrings(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];

  const collectLiterals = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // Dans un objet, seules les valeurs sont des classes, pas les clés.
      if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
      // `x === "in_progress" && "…"` : la comparaison n'est pas une classe.
      if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return;
      found.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      found.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
      node.templateSpans.forEach((s) => collectLiterals(s.expression));
      return;
    } else if (ts.isCallExpression(node) && node.expression.getText(source) !== "cn") {
      // `buttonClass("ghost", "xs")` : des noms de variantes, pas des classes
      // (les recettes elles-mêmes sont relevées dans leurs constantes).
      return;
    }
    ts.forEachChild(node, collectLiterals);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "className" && node.initializer) {
      collectLiterals(node.initializer);
    } else if (ts.isCallExpression(node) && node.expression.getText(source) === "cn") {
      node.arguments.forEach(collectLiterals);
    } else if (ts.isVariableDeclaration(node) && CLASS_CONSTANT.test(node.name.getText(source)) && node.initializer) {
      collectLiterals(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Échappement des sélecteurs produit par Tailwind (`hover:x` → `.hover\:x`). */
function selectorFor(className: string): string {
  return "." + className.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function hostCss(): string | null {
  if (!ASSETS) return null;
  const files = readdirSync(ASSETS).filter((f) => f.endsWith(".css"));
  return files.length === 0 ? null : files.map((f) => readFileSync(join(ASSETS, f), "utf8")).join("\n");
}

const css = hostCss();

describe.skipIf(css === null)("classes de l'interface", () => {
  const files = readdirSync(UI_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(UI_DIR, f));
  const classes = [...new Set(files.flatMap(collectClassStrings).flatMap((s) => s.split(/\s+/)).filter(Boolean))].sort();

  it("relève bien les classes du plugin", () => {
    expect(classes.length).toBeGreaterThan(50);
    expect(classes).toContain("text-muted-foreground");
  });

  const isCompiled = (c: string) => {
    const selector = selectorFor(c);
    for (let i = css!.indexOf(selector); i !== -1; i = css!.indexOf(selector, i + 1)) {
      const next = css![i + selector.length];
      if (next === undefined || !/[a-zA-Z0-9_\\-]/.test(next)) return true;
    }
    return false;
  };

  it("reconnaît une classe compilée et rejette une classe inconnue", () => {
    expect(isCompiled("hover:bg-accent")).toBe(true);
    expect(isCompiled("[&_svg:not([class*='size-'])]:size-4")).toBe(true);
    expect(isCompiled("bg-accent-plugin-inexistant")).toBe(false);
    expect(isCompiled("text-[17.5px]")).toBe(false);
  });

  it("n'utilise que des classes compilées par Paperclip", () => {
    expect(classes.filter((c) => !isCompiled(c))).toEqual([]);
  });
});
