import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

describe("manifeste", () => {
  it("bouton « Jira » de la barre du haut : slot dessiné par le plugin, pas launcher", () => {
    // Un launcher a un libellé fixe ; le bouton doit devenir « ABC-123 ↗ »
    // quand la tâche a un ticket. Et l'hôte (2026.1023) fait déborder les
    // launchers `openPopover` de l'écran : aucun launcher n'est déclaré.
    const slot = manifest.ui?.slots?.find((s) => s.type === "globalToolbarButton");
    expect(slot?.exportName).toBe("JiraToolbarButton");
    expect(manifest.ui?.launchers ?? []).toEqual([]);
  });
});
