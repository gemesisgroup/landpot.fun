import { expect, it, vi } from "vitest";
import { PaidMatch } from "../../src/client/components/PaidMatch";
import { nominatePartner, paidLobbies, payEntry } from "../../src/client/Pot";

vi.mock("../../src/client/Pot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Pot")>()),
  potConfig: async () => ({
    enabled: true,
    stake: "10000",
    burnBps: 200,
    treasuryBps: 300,
    token: { decimals: 0, symbol: "LANDPOT" },
  }),
  paidLobbies: vi.fn(),
  potClaims: async () => [],
  nominatePartner: vi.fn(),
  payEntry: vi.fn(),
}));

it("confirms the partner before offering payment and shows the net prize per wallet", async () => {
  const lobby = {
    cup: true,
    gameId: "CupGame1",
    roundId: "0x00" as const,
    stake: "10000",
    minPlayers: 8,
    maxPlayers: 8,
    deposited: 0,
    joined: false,
    fundingEnds: 2_000_000_000,
  };
  vi.mocked(paidLobbies).mockResolvedValue([lobby]);
  const card = new PaidMatch();
  document.body.append(card);
  try {
    document.dispatchEvent(
      new CustomEvent("userMeResponse", {
        detail: { user: { wallet: { address: "mine" } } },
      }),
    );
    await vi.waitFor(() => expect(card.querySelector("input")).toBeTruthy());
    const input = card.querySelector("input")!;
    input.value = "my-partner";
    input.dispatchEvent(new Event("input"));
    vi.mocked(paidLobbies).mockResolvedValue([
      { ...lobby, partner: "my-partner" },
    ]);
    card.querySelector("button")!.click();
    await vi.waitFor(() => expect(card.querySelector("input")).toBeNull());
    expect(nominatePartner).toHaveBeenCalledWith("CupGame1", "my-partner");
    expect(payEntry).not.toHaveBeenCalled();
    expect(card.textContent).toContain("my-partner");
    expect(card.textContent?.replace(/,/g, "")).toContain("38000 LANDPOT");
  } finally {
    card.remove();
    document.dispatchEvent(
      new CustomEvent("userMeResponse", { detail: false }),
    );
  }
});
