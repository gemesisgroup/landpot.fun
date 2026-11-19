import { EventBus } from "@openfront/shared/EventBus";
import { describe, expect, it, vi } from "vitest";
import "../../src/client/hud/layers/TutorialPanel";
import type { TutorialPanel } from "../../src/client/hud/layers/TutorialPanel";
import type { UserSettings } from "../../src/client/UserSettings";
import type { GameView } from "../../src/client/view";

function firstTick(
  resumedFromSave: boolean,
  opts: { dismissed?: boolean; paid?: boolean } = {},
) {
  const myPlayer = vi.fn(() => null);
  const panel = document.createElement("tutorial-panel") as TutorialPanel;
  panel.game = {
    config: () => ({
      isReplay: () => false,
      gameConfig: () =>
        opts.paid
          ? {
              maxTimerValue: 12,
              caldera: {
                craterPermille: 200,
                craterWeight: 3,
                eruptionSeconds: 180,
                eruptionPermille: 250,
              },
            }
          : {},
    }),
    myPlayer,
    resumedFromSave: () => resumedFromSave,
    setOwnSpawnRing: vi.fn(),
    setMarkedPlayers: vi.fn(),
  } as unknown as GameView;
  panel.eventBus = new EventBus();
  panel.userSettings = {
    tutorialDismissed: () => opts.dismissed ?? false,
  } as unknown as UserSettings;
  panel.tick();
  return { myPlayer };
}

describe("TutorialPanel", () => {
  it("runs for a player who hasn't dismissed it", () => {
    expect(firstTick(false).myPlayer).toHaveBeenCalled();
  });

  // Its first steps would hold the spawn ring on the player's territory
  // until they next attack.
  it("stays off in a game resumed from a save", () => {
    expect(firstTick(true).myPlayer).not.toHaveBeenCalled();
  });

  it("stays off for a player who dismissed it", () => {
    expect(
      firstTick(false, { dismissed: true }).myPlayer,
    ).not.toHaveBeenCalled();
  });

  // Three short steps on how the pot is won, even for OpenFront veterans.
  it("runs the paid match steps even when the full tour was dismissed", () => {
    expect(
      firstTick(false, { dismissed: true, paid: true }).myPlayer,
    ).toHaveBeenCalled();
  });
});
