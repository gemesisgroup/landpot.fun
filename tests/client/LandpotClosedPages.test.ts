import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initNavigation,
  LANDPOT_CLOSED_PAGES,
} from "../../src/client/Navigation";
import { CONNECT_WALLET_EVENT } from "../../src/client/Wallet";

describe("Landpot closed pages", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="page-play"></div>
      <div id="page-clan" class="page-content hidden"></div>
      <div id="page-account" class="page-content hidden"></div>
      <div id="page-settings" class="page-content hidden"></div>`;
    initNavigation();
  });

  it("sends every closed page home", () => {
    for (const page of LANDPOT_CLOSED_PAGES) {
      window.showPage?.(page);
      expect(window.currentPageId).toBe("page-play");
    }
    expect(document.getElementById("page-clan")!.classList).toContain("hidden");
    expect(document.getElementById("page-play")!.classList).not.toContain(
      "hidden",
    );
  });

  it("turns OpenFront's sign-in page into the wallet picker", () => {
    const asked = vi.fn();
    window.addEventListener(CONNECT_WALLET_EVENT, asked);
    window.showPage?.("page-account");
    window.removeEventListener(CONNECT_WALLET_EVENT, asked);
    expect(asked).toHaveBeenCalledOnce();
    expect(window.currentPageId).toBe("page-play");
    expect(document.getElementById("page-account")!.classList).toContain(
      "hidden",
    );
  });

  it("still opens pages Landpot serves", () => {
    window.showPage?.("page-settings");
    expect(window.currentPageId).toBe("page-settings");
    expect(document.getElementById("page-settings")!.classList).not.toContain(
      "hidden",
    );
  });
});
