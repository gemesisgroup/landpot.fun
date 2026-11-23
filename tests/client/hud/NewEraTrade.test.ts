import {
  CONTRACT_MAX_PRICE,
  CONTRACT_MAX_RATE,
} from "@openfront/engine-lib/game/NewEra";
import { render } from "lit";
import {
  NewEraContractRow,
  NewEraStore,
} from "../../../src/client/hud/layers/lib/NewEraStore";
import {
  DEFAULT_DRAFT,
  TradeContext,
  clampDraft,
  contractRole,
  goldPerMinute,
  renderTrade,
} from "../../../src/client/hud/layers/NewEraTrade";
import { translateText } from "../../../src/client/Utils";

describe("New Era trade view", () => {
  it("tells the viewer's side of a contract", () => {
    expect(contractRole({ buyer: 1, seller: 2 }, 1)).toBe("buying");
    expect(contractRole({ buyer: 1, seller: 2 }, 2)).toBe("selling");
    expect(contractRole({ buyer: 1, seller: 2 }, 3)).toBeNull();
  });

  it("keeps a draft inside what an offer may say", () => {
    expect(clampDraft({ ...DEFAULT_DRAFT, rate: 0, price: -5 })).toMatchObject({
      rate: 1,
      price: 0,
    });
    expect(
      clampDraft({ ...DEFAULT_DRAFT, rate: 99.7, price: 5e9 }),
    ).toMatchObject({ rate: CONTRACT_MAX_RATE, price: CONTRACT_MAX_PRICE });
    expect(clampDraft({ ...DEFAULT_DRAFT, rate: NaN }).rate).toBe(1);
    expect(clampDraft({ ...DEFAULT_DRAFT, rate: 7.9 }).rate).toBe(7);
  });

  it("prices a minute of full delivery", () => {
    expect(goldPerMinute(4, 2_000)).toBe(8_000);
  });
});

describe("New Era trade tab, rendered", () => {
  const row = (over: Partial<NewEraContractRow>): NewEraContractRow => ({
    id: 1,
    buyer: 2,
    seller: 1,
    kind: "oil",
    rate: 4,
    price: 2_000,
    state: "offered",
    expires: 600,
    pile: 0,
    inFlight: false,
    via: -1,
    supply: 1000,
    delivered: 0,
    paid: 0,
    hasPorts: true,
    options: [],
    ...over,
  });

  function setup() {
    const store = new NewEraStore();
    store.contracts = [
      // Someone offers to buy from me…
      row({ id: 7, buyer: 2, seller: 1 }),
      // …and I'm buying iron from them, with two ways to sail.
      row({
        id: 9,
        buyer: 1,
        seller: 2,
        kind: "iron",
        state: "active",
        delivered: 12 * 600,
        paid: 24_000,
        options: [
          { via: -1, ticks: 300, zones: [0], losses: [600] },
          { via: 1, ticks: 500, zones: [1], losses: [0] },
        ],
      }),
    ];
    const calls: string[] = [];
    const ctx: TradeContext = {
      store,
      me: 1,
      zoneNames: ["Central Strait", "Northern Passage"],
      ticks: 100,
      nameOf: (id) => (id === 2 ? "Coalport" : "Me"),
      partners: [{ id: 2, name: "Coalport" }],
      draft: { ...DEFAULT_DRAFT },
      onDraft: () => calls.push("draft"),
      onOffer: () => calls.push("offer"),
      onAnswer: (id, accept) => calls.push(`answer:${id}:${accept}`),
      onEnd: (id) => calls.push(`end:${id}`),
      onRoute: (id, via) => calls.push(`route:${id}:${via}`),
    };
    const root = document.createElement("div");
    render(renderTrade(ctx), root);
    const button = (text: string) =>
      [...root.querySelectorAll("button")].find((b) =>
        b.textContent!.includes(text),
      )!;
    return { root, calls, button };
  }

  it("answers an incoming offer", () => {
    const { root, calls, button } = setup();
    expect(root.textContent).toContain("Coalport");
    button(translateText("landpot.newera.accept")).click();
    button(translateText("landpot.newera.decline")).click();
    expect(calls).toEqual(["answer:7:true", "answer:7:false"]);
  });

  it("shows a running deal's routes, totals and end", () => {
    const { root, calls } = setup();
    const routes = root.querySelectorAll<HTMLButtonElement>(".lp-ne-route");
    expect(routes).toHaveLength(2);
    // The direct way loses 60%: 2.4 of a 6 batch; the way round all of it.
    expect(routes[0].textContent).toContain("2.4/6.0");
    expect(routes[1].textContent).toContain("6.0/6.0");
    routes[1].click();
    expect(root.textContent).toContain(
      translateText("landpot.newera.paid", { gold: "24K" }),
    );
    const end = [...root.querySelectorAll("button")].find(
      (b) =>
        b.textContent!.trim() === translateText("landpot.newera.end_contract"),
    )!;
    end.click();
    expect(calls).toEqual(["route:9:1", "end:9"]);
  });

  it("sends an offer only once a seller is picked", () => {
    const { calls, button } = setup();
    const send = button(translateText("landpot.newera.send_offer"));
    expect(send.disabled).toBe(true);
    send.click();
    expect(calls).toEqual([]);
  });
});
