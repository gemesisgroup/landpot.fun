"""
Caldera duels end to end, four browsers on the local stack.

    npm run dev:pot                           # validator, API, game server
    npx tsx scripts/landpot/testSigner.ts     # signs in the test wallets
    python scripts/landpot/duel_e2e.py        # this

Duels are free, so the wallets only sign in. Players 1 and 2 (2 on a phone
profile) pair through a challenge link; player 3 opens the same link after
it was taken; players 3 and 4 pair through the open queue. Both duels are
confirmed on both sides, played to the result, and then the loser asks for
a rematch. Evidence: design/shots/duel-e2e/ and result.json there.
"""

import asyncio
import json
import os
import random
import sys
import time
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).parent))
import cup_e2e  # noqa: E402
from cup_e2e import Player, http, log, spawn_box  # noqa: E402

CLIENT = "http://localhost:9000"
cup_e2e.OUT = OUT = Path("design/shots/duel-e2e")
cup_e2e.PHONE = 2


def duel_api(path):
    with urllib.request.urlopen(f"{CLIENT}/w0/api/duel{path}", timeout=20) as r:
        return json.loads(r.read())


def stats():
    with urllib.request.urlopen(f"{CLIENT}/w0/api/duel-stats", timeout=20) as r:
        return json.loads(r.read())


async def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        await page.screenshot(path=str(OUT / f"{name}.png"))
    except Exception as e:
        log("shot failed", name, e)


async def tap(p, x, y):
    if p.phone:
        await p.page.touchscreen.tap(x, y)
    else:
        await p.page.mouse.click(x, y)


async def main():
    started = time.time()
    result = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "steps": []}

    def step(name, **kw):
        kw["t"] = round(time.time() - started, 1)
        result["steps"].append({"step": name, **kw})
        log(name, kw)

    _, infos = http("GET", "/players", base=cup_e2e.SIGNER)
    players = [Player(i["player"], i) for i in infos[:4]]
    p1, p2, p3, p4 = players

    async with async_playwright() as pw:
        exe = os.environ.get("CUP_E2E_CHROME")
        browser = await pw.chromium.launch(headless=True, executable_path=exe or None, args=[
            "--use-angle=d3d11", "--enable-gpu", "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist", "--mute-audio"])
        for p in players:
            await p.open(browser, pw)
            await p.sign_in()
            await p.page.wait_for_selector("[data-testid=duel-card]", timeout=60_000)
        step("4 wallets signed in")
        await shot(p1.page, "01-card")
        await shot(p2.page, "01-card-phone")

        # ── by link: 1 challenges 2 ──
        await p1.page.click("[data-testid=duel-challenge]")
        link = await p1.page.input_value("[data-testid=duel-link-value]", timeout=15_000)
        duel_id = link.split("duel=")[1]
        await shot(p1.page, "02-link-out")
        await p2.page.goto(link)
        await p2.page.wait_for_selector("[data-testid=duel-link][data-state=open]", timeout=30_000)
        await shot(p2.page, "03-link-open-phone")
        # Opening the link confirmed nothing.
        assert duel_api(f"/invite/{duel_id}")["state"] == "open"
        step("link opened, still open", link=link)
        await p2.page.click("[data-testid=duel-accept]")
        await p2.page.wait_for_selector("[data-testid=duel-confirm]", timeout=30_000)
        await p1.page.wait_for_selector("[data-testid=duel-confirm]", timeout=30_000)
        await shot(p1.page, "04-confirm-desktop")
        await shot(p2.page, "04-confirm-phone")
        terms = await p2.page.inner_text("[data-testid=duel-confirm]")
        step("both see opponent and terms", phone=terms)

        # A third player opens the taken link.
        await p3.page.goto(link)
        await p3.page.wait_for_selector("[data-testid=duel-link][data-state=taken]", timeout=30_000)
        await shot(p3.page, "05-link-taken")
        step("taken link explained", text=await p3.page.inner_text("[data-testid=duel-link]"))
        await p3.page.goto(CLIENT)
        await p3.page.wait_for_selector("[data-testid=duel-card]", timeout=60_000)

        # ── by queue: 3 and 4 ──
        await p3.page.click("[data-testid=duel-find]")
        await p3.page.wait_for_selector("[data-testid=duel-searching]", timeout=15_000)
        await shot(p3.page, "06-searching")
        await asyncio.sleep(4)
        await p4.page.click("[data-testid=duel-find]")
        for p in (p3, p4):
            await p.page.wait_for_selector("[data-testid=duel-confirm]", timeout=30_000)
        step("queue matched 3 and 4")

        # Everyone confirms; the game opens on its own.
        t_confirm = time.time()
        for p in players:
            await p.page.click("[data-testid=duel-confirm-btn]")
            await asyncio.sleep(1)
        for _ in range(90):
            in_game = await asyncio.gather(*(p.page.evaluate(
                "() => !!document.querySelector('canvas') && location.pathname.includes('/game/')") for p in players))
            if all(in_game):
                break
            await asyncio.sleep(2)
        step("both duels started", seconds=round(time.time() - t_confirm, 1), inGame=in_game)
        await asyncio.sleep(4)
        await shot(p1.page, "07-spawn")
        await shot(p2.page, "07-spawn-phone")

        async def spawn(p):
            box = None
            for _ in range(60):
                box = await spawn_box(p.page)
                if box:
                    break
                await asyncio.sleep(1)
            if not box:
                p.errors.append("no spawn box found")
                return None
            x0, y0, x1, y1 = box
            p.home = ((x0 + x1) / 2, (y0 + y1) / 2)
            await tap(p, *p.home)
            return [round(v) for v in box]
        boxes = await asyncio.gather(*(spawn(p) for p in players))
        step("spawned in mirrored boxes", boxes=boxes)

        # Play: player 1 and 3 push toward the crater (screen centre), 2 and
        # 4 hold their own corner, so the run shows centre against edge.
        t_play = time.time()
        n = 0
        while time.time() - t_play < 9 * 60:
            done = await asyncio.gather(*(p.page.query_selector("[data-testid=duel-result]") for p in players))
            if all(done):
                break
            async def poke(p):
                hx, hy = getattr(p, "home", (640, 430))
                vw = p.page.viewport_size
                frac = min(1, (time.time() - t_play) / 240)
                if p.n in (1, 3):
                    tx = hx + (vw["width"] / 2 - hx) * frac
                    ty = hy + (vw["height"] / 2 - hy) * frac
                else:
                    tx, ty = hx, hy
                reach = 40 + 120 * frac
                try:
                    await tap(p, tx + random.uniform(-reach, reach), ty + random.uniform(-reach, reach))
                except Exception:
                    pass
            await asyncio.gather(*(poke(p) for p, finished in zip(players, done) if not finished))
            n += 1
            if n % 20 == 0:
                await shot(p1.page, f"08-play-{n:03d}")
                await shot(p2.page, f"08-play-{n:03d}-phone")
            await asyncio.sleep(2)
        step("played", seconds=round(time.time() - t_play))
        outcome = {}
        for p in players:
            el = await p.page.query_selector("[data-testid=duel-result]")
            outcome[p.n] = el and await el.get_attribute("data-result")
            await shot(p.page, f"09-result-{p.n}{'-phone' if p.phone else ''}")
        step("results", outcome=outcome)

        # Rematch: losers ask first, winners answer.
        async def ask(p):
            btn = await p.page.query_selector("[data-testid=duel-rematch]")
            if btn:
                await btn.click()
        for p in sorted(players, key=lambda p: outcome.get(p.n) != "loss"):
            await ask(p)
            await asyncio.sleep(1)
        await asyncio.sleep(5)
        for p in players:
            await shot(p.page, f"10-rematch-{p.n}{'-phone' if p.phone else ''}")
        result["stats"] = stats()
        step("stats", stats=result["stats"])
        result["errors"] = {p.n: p.errors[:10] for p in players}
        await browser.close()

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8", newline="\n")
    log("done", round(time.time() - started), "s")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        CLIENT = sys.argv[1]
    asyncio.run(main())
