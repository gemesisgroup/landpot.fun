import { IRON, mineOutput } from "@openfront/engine-lib/game/NewEra";
import { render } from "lit";
import {
  ExtractorRow,
  LandContext,
  extractorYield,
  renderLand,
  resourceState,
} from "../../../src/client/hud/layers/NewEraLand";
import { signedNet } from "../../../src/client/hud/layers/NewEraPanel";
import { translateText } from "../../../src/client/Utils";

const mine = (over: Partial<ExtractorRow> = {}): ExtractorRow => ({
  id: 1,
  well: false,
  kind: "iron",
  richness: 12,
  offshore: false,
  level: 1,
  cap: 3,
  building: false,
  shelf: 1000,
  ...over,
});

function land(over: Partial<LandContext> = {}) {
  const root = document.createElement("div");
  render(
    renderLand({
      row: undefined,
      extractors: [],
      factories: [],
      folded: new Set(),
      roman: String,
      onFold: () => {},
      onGoTo: () => {},
      onSpec: () => {},
      onUpgrade: () => {},
      ...over,
    }),
    root,
  );
  return root;
}

describe("New Era land tab", () => {
  it("reads how a resource stands", () => {
    const f = { stock: 0, made: 0, used: 0, util: 1000 };
    expect(resourceState(f).key).toBe("idle");
    expect(resourceState({ ...f, made: 4 }).key).toBe("growing");
    expect(resourceState({ ...f, made: 4, used: 4 }).key).toBe("steady");
    expect(resourceState({ ...f, stock: 60 * IRON, used: 6, made: 2 })).toEqual(
      { tone: "warn", key: "empty", seconds: 900 },
    );
    expect(resourceState({ ...f, made: 2, used: 6, util: 333 })).toEqual({
      tone: "warn",
      key: "short",
      pct: 33,
      missing: 4,
    });
  });

  it("counts an extractor's yield as the engine does", () => {
    expect(extractorYield(mine())?.perMin).toBe(mineOutput(1, 12));
    expect(extractorYield(mine({ kind: null }))).toBeNull();
    expect(extractorYield(mine({ building: true }))?.perMin).toBe(0);
    // An offshore platform keeps its share of the field.
    expect(
      extractorYield(
        mine({ well: true, kind: "oil", offshore: true, shelf: 500 }),
      )?.perMin,
    ).toBe(2);
    // A gold vein pays gold a minute (10 a tick a point).
    expect(extractorYield(mine({ kind: "gold", richness: 4 }))).toEqual({
      res: "gold",
      perMin: 4 * 10 * 600,
    });
  });

  it("shows first steps until there is a mine, a working factory and a well", () => {
    expect(land().querySelector(".lp-ne-start")).not.toBeNull();
    expect(land().textContent).toContain(
      translateText("landpot.newera.start_mine"),
    );
    const done = land({
      extractors: [mine(), mine({ id: 2, well: true, kind: "oil" })],
      factories: [
        { id: 3, level: 1, bonus: 0, spec: "logistics", building: false },
      ],
    });
    expect(done.querySelector(".lp-ne-start")).toBeNull();
  });

  it("marks a capped extractor MAX and one without a deposit", () => {
    const root = land({
      extractors: [
        mine({ id: 4, level: 3 }),
        mine({ id: 5, kind: null, cap: 1 }),
      ],
    });
    const lvls = [...root.querySelectorAll(".lp-ne-lvl")];
    expect(lvls[0].textContent?.trim()).toBe(
      translateText("landpot.newera.max"),
    );
    expect(lvls[1].classList.contains("is-max")).toBe(false);
    expect(root.textContent).toContain(
      translateText("landpot.newera.no_deposit"),
    );
  });

  it("folds a section and sends picks", () => {
    const folds: string[] = [];
    const specs: string[] = [];
    const root = land({
      factories: [{ id: 7, level: 2, bonus: 0, spec: "none", building: false }],
      onFold: (s) => folds.push(s),
      onSpec: (id, s) => specs.push(`${id}:${s}`),
    });
    root.querySelector<HTMLButtonElement>("button.lp-ne-section")!.click();
    expect(folds).toEqual(["resources"]);
    root.querySelectorAll<HTMLButtonElement>(".lp-ne-spec")[2].click();
    expect(specs).toEqual(["7:metallurgy"]);
    const folded = land({ folded: new Set(["resources"]) });
    expect(folded.querySelector(".lp-ne-res")).toBeNull();
  });

  it("signs the strip's net", () => {
    expect(signedNet(6, 4)).toBe("+2");
    expect(signedNet(1, 4)).toBe("−3");
    expect(signedNet(0, 0)).toBe("±0");
  });
});
