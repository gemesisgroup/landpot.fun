import { afterEach, expect, it, vi } from "vitest";
import { PaidMatch } from "../../src/client/components/PaidMatch";
import {
  acceptInvite,
  cupPrize,
  nextCupStart,
  nominatePartner,
  paidLobbies,
  payEntry,
  potConfig,
  readInvite,
} from "../../src/client/Pot";

vi.mock("../../src/client/Pot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Pot")>()),
  potConfig: vi.fn(),
  paidLobbies: vi.fn(),
  potClaims: async () => [],
  nominatePartner: vi.fn(),
  payEntry: vi.fn(),
  readInvite: vi.fn(),
  acceptInvite: vi.fn(),
  createInvite: vi.fn(),
}));

const config = {
  enabled: true as const,
  cluster: "localnet",
  program: "p",
  stake: "10000",
  burnBps: 200,
  treasuryBps: 300,
  reviewDelay: 86_400,
  minPlayers: 8,
  maxPlayers: 16,
  cupHourUTC: 161,
  token: { address: "t", decimals: 0, symbol: "LANDPOT" },
};

const lobby = {
  cup: true,
  gameId: "CupGame1",
  roundId: "0x00" as const,
  stake: "10000",
  burnBps: 200,
  treasuryBps: 300,
  minPlayers: 8,
  maxPlayers: 8,
  deposited: 3,
  pairs: 2,
  joined: false,
  fundingEnds: 2_000_000_000,
};

function signIn(address: string | null) {
  document.dispatchEvent(
    new CustomEvent("userMeResponse", {
      detail: address ? { user: { wallet: { address } } } : false,
    }),
  );
}

let card: PaidMatch | null = null;
afterEach(() => {
  card?.remove();
  card = null;
  signIn(null);
  history.replaceState(null, "", "/");
});

function mount(): PaidMatch {
  card = new PaidMatch();
  document.body.append(card);
  return card;
}

const digits = (el: Element) => el.textContent!.replace(/,/g, "");

it("shows the full picture before paying: 38,000 per winner, +28,000 net", async () => {
  vi.mocked(potConfig).mockResolvedValue(config);
  vi.mocked(paidLobbies).mockResolvedValue([lobby]);
  const c = mount();
  signIn("mine");
  await vi.waitFor(() =>
    expect(c.querySelector("[data-testid=cup-panel]")).toBeTruthy(),
  );
  const panel = c.querySelector("[data-testid=cup-panel]")!;
  expect(digits(panel)).toContain("38000 LANDPOT");
  expect(digits(panel)).toContain("+28000");
  expect(panel.textContent).toContain("2 / 4");
  expect(panel.textContent).toContain("3 / 8");
  // What happens on an incomplete roster, a tie and the review hold.
  expect(panel.textContent).toContain("cup.if_incomplete");
  expect(panel.textContent).toContain("cup.if_tie");
  expect(panel.textContent).toContain("cup.if_review");
  // No partner yet: paying waits for a pair.
  const pay = [...c.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("cup.pair_first"),
  )!;
  expect(pay.disabled).toBe(true);
});

it("keeps an open round's numbers when the next round's settings change", async () => {
  vi.mocked(potConfig).mockResolvedValue({
    ...config,
    stake: "50000",
    burnBps: 1000,
    treasuryBps: 1000,
  });
  vi.mocked(paidLobbies).mockResolvedValue([lobby]);
  const c = mount();
  signIn("mine");
  await vi.waitFor(() =>
    expect(c.querySelector("[data-testid=cup-panel]")).toBeTruthy(),
  );
  const panel = c.querySelector("[data-testid=cup-panel]")!;
  expect(digits(panel)).toContain("38000 LANDPOT");
  expect(digits(panel)).toContain("10000 LANDPOT");
});

it("shows the partner and whether each of you has paid", async () => {
  vi.mocked(potConfig).mockResolvedValue(config);
  vi.mocked(paidLobbies).mockResolvedValue([
    { ...lobby, partner: "PartnerWallet111", partnerPaid: true },
  ]);
  const c = mount();
  signIn("mine");
  await vi.waitFor(() =>
    expect(c.querySelector("[data-testid=cup-partner]")).toBeTruthy(),
  );
  const line = c.querySelector("[data-testid=cup-partner]")!.textContent!;
  expect(line).toContain("Part…t111");
  expect(line).toContain("cup.partner_paid");
  expect(line).toContain("cup.you_unpaid");
});

it("still pairs by address when entered by hand", async () => {
  vi.mocked(potConfig).mockResolvedValue(config);
  vi.mocked(paidLobbies).mockResolvedValue([lobby]);
  const c = mount();
  signIn("mine");
  await vi.waitFor(() => expect(c.querySelector("details input")).toBeTruthy());
  const input = c.querySelector<HTMLInputElement>("details input")!;
  input.value = "my-partner";
  input.dispatchEvent(new Event("input"));
  vi.mocked(paidLobbies).mockResolvedValue([
    { ...lobby, partner: "my-partner" },
  ]);
  c.querySelector<HTMLButtonElement>("details button")!.click();
  await vi.waitFor(() =>
    expect(c.querySelector("[data-testid=cup-partner]")).toBeTruthy(),
  );
  expect(nominatePartner).toHaveBeenCalledWith("CupGame1", "my-partner");
  expect(payEntry).not.toHaveBeenCalled();
});

it("opens an invite link without confirming anything until the button", async () => {
  vi.mocked(potConfig).mockResolvedValue(config);
  vi.mocked(paidLobbies).mockResolvedValue([lobby]);
  vi.mocked(readInvite).mockResolvedValue({
    gameId: "CupGame1",
    inviter: "InviterWallet999",
    stake: "10000",
    burnBps: 200,
    treasuryBps: 300,
    fundingEnds: 2_000_000_000,
    pairs: 2,
    state: "open",
  });
  vi.mocked(acceptInvite).mockResolvedValue("ok");
  history.replaceState(null, "", "/?cup_invite=tok123");
  const c = mount();
  signIn("friend");
  await vi.waitFor(() =>
    expect(c.querySelector("[data-testid=cup-invite]")).toBeTruthy(),
  );
  const panel = c.querySelector("[data-testid=cup-invite]")!;
  expect(panel.textContent).toContain("InviterWallet999");
  expect(digits(panel)).toContain("38000 LANDPOT");
  expect(acceptInvite).not.toHaveBeenCalled();
  [...panel.querySelectorAll("button")]
    .find((b) => b.textContent?.includes("cup.confirm"))!
    .click();
  await vi.waitFor(() => expect(acceptInvite).toHaveBeenCalledWith("tok123"));
  await vi.waitFor(() =>
    expect(panel.textContent).toContain("cup.invite_state.accepted"),
  );
});

it("explains an expired or taken invite", async () => {
  vi.mocked(potConfig).mockResolvedValue(config);
  vi.mocked(paidLobbies).mockResolvedValue([]);
  for (const [state, text] of [
    ["expired", "cup.invite_state.expired"],
    ["taken", "cup.invite_state.taken"],
    ["you_paired", "cup.invite_state.you_paired"],
  ] as const) {
    vi.mocked(readInvite).mockResolvedValue({
      gameId: "CupGame1",
      inviter: "InviterWallet999",
      stake: "10000",
      burnBps: 200,
      treasuryBps: 300,
      fundingEnds: 2_000_000_000,
      pairs: 4,
      state,
    });
    history.replaceState(null, "", "/?cup_invite=tok123");
    const c = mount();
    signIn("friend");
    await vi.waitFor(() =>
      expect(
        c.querySelector("[data-testid=cup-invite]")?.textContent,
      ).toContain(text),
    );
    expect(
      [...c.querySelectorAll("[data-testid=cup-invite] button")].some((b) =>
        b.textContent?.includes("cup.confirm"),
      ),
    ).toBe(false);
    card!.remove();
    card = null;
    signIn(null);
  }
});

it("computes the prize and the next Cup in UTC", () => {
  expect(cupPrize("10000", { burnBps: 200, treasuryBps: 300 })).toEqual({
    perWinner: 38_000n,
    profit: 28_000n,
  });
  // Saturday 17:00 UTC (hour 161), asked on a Wednesday.
  const wed = Date.UTC(2026, 10, 18, 12);
  expect(nextCupStart(161, wed).toISOString()).toBe("2026-11-21T17:00:00.000Z");
  // During the Cup hour it is still this week's Cup; after it, next week's.
  expect(nextCupStart(161, Date.UTC(2026, 10, 21, 17, 30)).toISOString()).toBe(
    "2026-11-21T17:00:00.000Z",
  );
  expect(nextCupStart(161, Date.UTC(2026, 10, 21, 18, 1)).toISOString()).toBe(
    "2026-11-28T17:00:00.000Z",
  );
});
