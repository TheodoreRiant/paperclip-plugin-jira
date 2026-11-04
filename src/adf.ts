/**
 * Conversion minimale d'une description Jira Cloud (Atlassian Document Format)
 * en markdown, pour pré-remplir une tâche Paperclip. Les nœuds inconnus sont
 * réduits à leur texte : on préfère perdre la mise en forme que le contenu.
 */

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

export const MAX_DESCRIPTION_LENGTH = 20_000;

export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === "string") return doc.trim();
  if (!doc || typeof doc !== "object") return "";
  const markdown = blocks((doc as AdfNode).content ?? [], "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown.length > MAX_DESCRIPTION_LENGTH
    ? `${markdown.slice(0, MAX_DESCRIPTION_LENGTH)}\n\n_(description tronquée)_`
    : markdown;
}

function blocks(nodes: AdfNode[], indent: string): string {
  return nodes.map((node) => block(node, indent)).filter((part) => part !== "").join("\n\n");
}

function block(node: AdfNode, indent: string): string {
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return indent + inline(children).replace(/\n/g, `\n${indent}`);
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      return `${indent}${"#".repeat(level)} ${inline(children)}`;
    }
    case "bulletList":
      return list(children, indent, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.order) || 1;
      return list(children, indent, (i) => `${start + i}. `);
    }
    case "taskList":
      return list(children, indent, (_, item) => (item.attrs?.state === "DONE" ? "- [x] " : "- [ ] "));
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const code = children.map((c) => c.text ?? "").join("");
      return `${indent}\`\`\`${language}\n${code}\n${indent}\`\`\``;
    }
    case "blockquote":
      return blocks(children, "")
        .split("\n")
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join("\n");
    case "panel":
      return blocks(children, indent);
    case "rule":
      return `${indent}---`;
    case "mediaSingle":
    case "mediaGroup":
      return `${indent}_(pièce jointe Jira non reprise)_`;
    case "table":
      return table(children, indent);
    default:
      return children.length > 0 ? blocks(children, indent) : inline([node]);
  }
}

function list(items: AdfNode[], indent: string, bullet: (index: number, item: AdfNode) => string): string {
  return items
    .map((item, index) => {
      const prefix = bullet(index, item);
      const content = item.content ?? [];
      // Les tâches (taskItem) portent leur texte directement ; les listItem, des paragraphes.
      const isInline = content.every((c) => c.type === "text" || c.type === "hardBreak" || c.type === "mention");
      if (isInline) return `${indent}${prefix}${inline(content)}`;
      const [first, ...rest] = content;
      const head = first ? block(first, "").trimStart() : "";
      const nested = rest.map((child) => block(child, `${indent}  `)).filter(Boolean);
      return [`${indent}${prefix}${head}`, ...nested].join("\n");
    })
    .join("\n");
}

function table(rows: AdfNode[], indent: string): string {
  const cells = rows.map((row) =>
    (row.content ?? []).map((cell) => blocks(cell.content ?? [], "").replace(/\n+/g, " ").replace(/\|/g, "\\|")),
  );
  if (cells.length === 0) return "";
  const width = Math.max(...cells.map((r) => r.length));
  const line = (r: string[]) => `${indent}| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const [header, ...body] = cells;
  return [line(header ?? []), `${indent}|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

function inline(nodes: AdfNode[]): string {
  return nodes.map(inlineNode).join("");
}

function inlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? []);
    case "hardBreak":
      return "\n";
    case "mention":
      return String(node.attrs?.text ?? "@?");
    case "emoji":
      return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
    case "date": {
      const ts = Number(node.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "";
    }
    case "status":
      return `[${String(node.attrs?.text ?? "")}]`;
    case "inlineCard":
    case "blockCard":
      return typeof node.attrs?.url === "string" ? node.attrs.url : "";
    default:
      return node.content ? inline(node.content) : (node.text ?? "");
  }
}

function applyMarks(text: string, marks: NonNullable<AdfNode["marks"]>): string {
  let out = text;
  let href: string | null = null;
  for (const mark of marks) {
    switch (mark.type) {
      case "code":
        out = `\`${out}\``;
        break;
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `_${out}_`;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "link":
        href = typeof mark.attrs?.href === "string" ? mark.attrs.href : null;
        break;
    }
  }
  return href ? `[${out}](${href})` : out;
}
