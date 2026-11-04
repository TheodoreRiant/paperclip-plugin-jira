import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

describe("launchers", () => {
  it("n'utilisent pas openPopover (l'hôte le fait déborder de l'écran)", () => {
    // Paperclip 2026.1023 place un popover à `left ≤ innerWidth − 360px`
    // quelle que soit sa largeur (28 à 64rem selon `bounds`) : près du bord
    // droit, il sort de l'écran. La modale centrée de l'hôte reste bornée.
    const launchers = manifest.ui?.launchers ?? [];
    expect(launchers.length).toBeGreaterThan(0);
    for (const launcher of launchers) {
      expect(launcher.action.type, launcher.id).toBe("openModal");
    }
  });
});
