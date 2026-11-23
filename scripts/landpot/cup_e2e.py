"""
Caldera Cup end to end, eight browsers on the local validator.

    npm run dev:pot -- --cup                  # validator, API, game server
    npx tsx scripts/landpot/testSigner.ts     # signs for the test wallets
    python scripts/landpot/cup_e2e.py         # this

Each browser context is one player with its own cookies and an injected
Wallet Standard wallet ("Landpot Test Wallet") whose keys stay in
testSigner (dev player-1..8, localnet only). The run goes through the real
UI: sign in, invite links (player 8 is a phone), pay, join, spawn, play to
the time limit, then archive, server replay, settlement and two claims.
Evidence goes to design/shots/cup-e2e/ and design/shots/cup-e2e/result.json.
"""

import asyncio
import json
import os
import random
import sqlite3
import sys
import time
import io
import urllib.request
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

CLIENT = "http://localhost:9000"
API = "http://127.0.0.1:8787"
SIGNER = "http://127.0.0.1:8790"
KEY = "WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION"
OUT = Path("design/shots/cup-e2e")
PLAYERS = 8
PHONE = 8  # this player uses a phone profile

WALLET_JS = r"""
(() => {
  const PLAYER = __PLAYER__, SIGNER = "__SIGNER__";
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const call = async (path, body) => {
    const r = await fetch(SIGNER + path, body ? {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)} : undefined);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "signer " + r.status);
    return j;
  };
  const me = { address: "__ADDRESS__", publicKey: unb64("__PUBKEY__") };
  const chains = ["solana:localnet"];
  const account = { address: me.address, publicKey: me.publicKey, chains,
    features: ["solana:signMessage", "solana:signAndSendTransaction"] };
  const wallet = {
    version: "1.0.0",
    name: "Landpot Test Wallet",
    icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#c6ff3d"/></svg>'),
    chains,
    accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => {
        wallet.accounts = [account]; return { accounts: [account] }; } },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs) =>
        Promise.all(inputs.map(async ({ message }) => {
          const { signature } = await call("/sign-message", { player: PLAYER, message: b64(message) });
          return { signedMessage: message, signature: unb64(signature) };
        })) },
      "solana:signAndSendTransaction": { version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs) =>
          Promise.all(inputs.map(async ({ transaction }) => {
            const { signature } = await call("/sign-send", { player: PLAYER, transaction: b64(transaction) });
            window.__lastTx = signature;
            return { signature: unb64(signature) };
          })) },
    },
  };
  const register = ({ register }) => register(wallet);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  } catch (e) { console.error(e); }
  window.addEventListener("wallet-standard:app-ready", ({ detail }) => register(detail));
})();
"""


def http(method, path, body=None, key=False, base=API):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("x-api-key", KEY)
        req.add_header("Authorization", f"Bearer {KEY}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


def settlement(game_id):
    """The API's own record of the replay and split (dev DB, read only)."""
    db = sqlite3.connect("file:.data/api-pot/landpot.sqlite?mode=ro", uri=True)
    try:
        row = db.execute("SELECT status, detail FROM pot_settlements WHERE game_id=?",
                         (game_id,)).fetchone()
        rnd = db.execute("SELECT state, result_ends FROM pot_rounds WHERE game_id=?",
                         (game_id,)).fetchone()
    finally:
        db.close()
    return {"status": row[0], "detail": json.loads(row[1])} if row else None, rnd


def all_claims(players, game_id):
    out = {}
    for p in players:
        _, c = http("GET", f"/public/pot/claims/{p.address}")
        out[p.n] = [x for x in (c or {}).get("claims", []) if x["gameId"] == game_id]
    return out


def b58(b64sig):
    """Wallets return raw signature bytes; explorers and RPC use base58."""
    import base64
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    raw = base64.b64decode(b64sig)
    n, out = int.from_bytes(raw, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = alphabet[r] + out
    return "1" * (len(raw) - len(raw.lstrip(bytes(1)))) + out


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def balance(address, mint):
    body = {"jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
            "params": [address, {"mint": mint}, {"encoding": "jsonParsed"}]}
    req = urllib.request.Request("http://127.0.0.1:8899", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.loads(r.read())["result"]["value"]
    return sum(int(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]) for a in out)


async def spawn_box(page):
    """The team's outlined starting area: the lime rectangle on the map."""
    img = Image.open(io.BytesIO(await page.screenshot())).convert("RGB")
    w, h = img.size
    scale = w / page.viewport_size["width"]
    px = img.load()
    lime = lambda x, y: (lambda c: c[1] > 200 and 140 < c[0] < 230 and c[2] < 90)(px[x, y])
    run = int(60 * scale)
    top = int(h * 0.03)
    rows = [y for y in range(top, h, 1) if sum(1 for x in range(0, w, 2) if lime(x, y)) * 2 >= run]
    cols = [x for x in range(0, w, 1) if sum(1 for y in range(top, h, 2) if lime(x, y)) * 2 >= run]
    if not rows or not cols:
        return None
    return (min(cols) / scale, min(rows) / scale, max(cols) / scale, max(rows) / scale)


async def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        await page.screenshot(path=str(OUT / f"{name}.png"))
    except Exception as e:
        log("shot failed", name, e)


class Player:
    def __init__(self, n, info):
        self.n = n
        self.address = info["address"]
        self.pubkey = info["publicKey"]
        self.phone = n == PHONE
        self.page = None
        self.errors = []

    async def open(self, browser, pw):
        opts = pw.devices["iPhone 13"] if self.phone else {"viewport": {"width": 1280, "height": 860}}
        opts = dict(opts, reduced_motion="reduce")
        if self.phone:
            opts.pop("default_browser_type", None)
        self.ctx = await browser.new_context(**opts)
        await self.ctx.add_init_script(
            WALLET_JS.replace("__PLAYER__", str(self.n)).replace("__SIGNER__", SIGNER)
            .replace("__ADDRESS__", self.address).replace("__PUBKEY__", self.pubkey))
        self.page = await self.ctx.new_page()
        self.page.on("console", lambda m: m.type == "error" and self.errors.append(m.text[:300]))
        self.page.on("pageerror", lambda e: self.errors.append(str(e)[:300]))
        self.page.on("framenavigated", lambda f: f == self.page.main_frame and
                     log("nav", self.n, f.url[:90]))
        self.page.on("response", lambda r: r.status in (401, 429) and
                     log("http", self.n, r.status, r.url[:100]))
        self.page.on("websocket", lambda ws: ws.on("close", lambda _: log("ws closed", self.n, ws.url[:60])))
        await self.page.goto(CLIENT, wait_until="domcontentloaded")

    async def card(self):
        await self.page.wait_for_selector("[data-testid=pot-primary]", timeout=60_000)

    async def sign_in(self):
        await self.card()
        short = self.address[:4] + "…" + self.address[-4:]
        for _ in range(3):
            try:
                async with self.page.expect_navigation(timeout=60_000):
                    await self.page.evaluate(
                        "window.dispatchEvent(new Event('landpot:connect-wallet'))")
                await self.page.wait_for_function(
                    "s => document.body.innerText.includes(s)", arg=short, timeout=60_000)
                return
            except Exception as err:
                log("sign-in retry", self.n, str(err)[:120])
        raise RuntimeError(f"player {self.n} could not sign in")


async def main():
    started = time.time()
    result = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "steps": []}

    def step(name, **kw):
        kw["t"] = round(time.time() - started, 1)
        result["steps"].append({"step": name, **kw})
        log(name, kw)

    _, cfg = http("GET", "/public/pot/config")
    mint = cfg["token"]["address"]
    _, infos = http("GET", "/players", base=SIGNER)
    players = [Player(i["player"], i) for i in infos[:PLAYERS]]

    # A fresh Cup lobby with time to spare.
    lobby = None
    _, data = http("GET", "/public/pot/lobbies")
    cups = [l for l in data["lobbies"] if l.get("cup") and l["deposited"] == 0
            and l["fundingEnds"] - time.time() > 420]
    if cups:
        lobby = cups[0]
    else:
        st, _ = http("POST", "/pot/cup-next", key=True)
        step("armed next Cup", status=st)
        for _ in range(120):
            _, data = http("GET", "/public/pot/lobbies")
            cups = [l for l in data["lobbies"] if l.get("cup") and l["deposited"] == 0
                    and l["fundingEnds"] - time.time() > 420]
            if cups:
                lobby = cups[0]
                break
            await asyncio.sleep(5)
    if not lobby:
        raise SystemExit("no Cup lobby opened")
    game_id = lobby["gameId"]
    step("cup lobby", gameId=game_id, fundingEnds=lobby["fundingEnds"], stake=lobby["stake"])
    result["gameId"] = game_id
    before = {p.n: balance(p.address, mint) for p in players}

    async with async_playwright() as pw:
        exe = os.environ.get("CUP_E2E_CHROME")
        browser = await pw.chromium.launch(headless=True, executable_path=exe or None, args=[
            "--use-angle=d3d11", "--enable-gpu", "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist", "--mute-audio"])
        for p in players:
            await p.open(browser, pw)
            await p.sign_in()
            log("signed in", p.n)
        step("8 wallets signed in", wallets=[p.address for p in players])
        await shot(players[0].page, "01-signed-in")
        await shot(players[-1].page, "01-signed-in-phone")

        # Four pairs through invite links: 1 invites 2, 3 invites 4, ...
        # Player 7 invites the phone (8).
        invites = 0
        for i in range(0, PLAYERS, 2):
            a, b = players[i], players[i + 1]
            await a.page.reload()
            await a.card()
            await a.page.click("[data-testid=cup-invite-copy]")
            link = await a.page.input_value("[data-testid=cup-invite-link]", timeout=15_000)
            invites += 1
            await b.page.goto(link)
            await b.page.wait_for_selector("[data-testid=cup-invite]", timeout=30_000)
            st, view = http("GET", "/public/pot/invite/" + link.split("cup_invite=")[1])
            assert view["state"] in ("open",), view  # opening confirms nothing
            if i == 0:
                await shot(b.page, "02-invite-open")
            if b.phone:
                await shot(b.page, "02-invite-open-phone")
            await b.page.click("[data-testid=cup-invite-confirm]")
            await b.page.wait_for_function(
                "() => document.querySelector('[data-testid=cup-invite]')?.innerText.length > 0 && !document.querySelector('[data-testid=cup-invite-confirm]')",
                timeout=30_000)
            step("pair", inviter=a.n, partner=b.n, link=link)
        st, stats = http("GET", f"/pot/cup-stats/{game_id}", key=True)
        step("pairs locked", stats=stats)

        # Everyone pays their own entry and joins.
        async def pay(p):
            await p.page.goto(CLIENT)
            await p.card()
            await p.page.wait_for_function(
                "() => !document.querySelector('[data-testid=pot-primary]').disabled", timeout=30_000)
            if p.n in (1, PHONE):
                await shot(p.page, f"03-before-pay-{'phone' if p.phone else 'desktop'}")
            await p.page.click("[data-testid=pot-primary]")
            await p.page.wait_for_function("() => !!window.__lastTx", timeout=90_000)
            p.deposit_tx = await p.page.evaluate("window.__lastTx")

        # Stagger so the validator sees them one by one.
        for p in players:
            await pay(p)
            step("deposit", player=p.n)
        await asyncio.sleep(5)
        await shot(players[0].page, "04-lobby")

        # Wait for the match.
        t_full = time.time()
        for _ in range(180):
            in_game = await asyncio.gather(*(p.page.evaluate(
                "() => !!document.querySelector('canvas') && location.pathname.includes('/game/')") for p in players))
            if all(in_game):
                break
            await asyncio.sleep(2)
        step("match started", waitedSeconds=round(time.time() - t_full, 1), inGame=in_game)
        await asyncio.sleep(4)
        await shot(players[0].page, "05-spawn-phase")
        await shot(players[-1].page, "05-spawn-phase-phone")

        # Spawn: each player picks land inside the team's outlined area.
        async def spawn(p, idx):
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
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            dx = (x1 - x0) * (0.18 if idx % 2 else -0.18)
            x, y = cx + dx, cy
            p.home = (x, y)
            if p.phone:
                await p.page.touchscreen.tap(x, y)
            else:
                await p.page.mouse.click(x, y)
            return [round(v) for v in box]
        boxes = await asyncio.gather(*(spawn(p, i) for i, p in enumerate(players)))
        step("spawn tiles picked", boxes=boxes)
        await asyncio.sleep(3)
        await shot(players[0].page, "06-spawned")
        await shot(players[-1].page, "06-spawned-phone")

        # Play: expand by clicking land around the centre until the limit.
        t_play = time.time()
        deadline = time.time() + 17 * 60
        n = 0
        while time.time() < deadline:
            sett, rnd = settlement(game_id)
            if sett or (rnd and rnd[0] not in ("funding", "started")):
                step("match over", round=rnd, settlement=sett and sett["status"])
                break
            async def poke(p):
                # Attack outward from home: neighbouring land first, further later.
                hx, hy = getattr(p, "home", (640, 430))
                reach = 30 + min(220, (time.time() - t_play) / 600 * 220)
                x = hx + random.uniform(-reach, reach)
                y = hy + random.uniform(-reach, reach)
                try:
                    if p.phone:
                        await p.page.touchscreen.tap(x, y)
                    else:
                        await p.page.mouse.click(x, y)
                except Exception:
                    pass
            await asyncio.gather(*(poke(p) for p in players))
            n += 1
            if n % 10 == 0:
                await shot(players[0].page, f"07-play-{n:03d}")
                log("still playing", round(time.time() - started), "s")
            await asyncio.sleep(3)
        await shot(players[0].page, "08-end")
        await shot(players[-1].page, "08-end-phone")

        # Archive → replay → settle → finalize: the API's keeper does it.
        t_end = time.time()
        claims = {}
        for _ in range(180):
            sett, rnd = settlement(game_id)
            claims = all_claims(players, game_id)
            ready = [c for cs in claims.values() for c in cs
                     if c["kind"] in ("winnings", "refund") and c["phase"] != 3]
            if sett and (ready or sett["status"] == "void"):
                break
            await asyncio.sleep(5)
        result["settlement"] = sett
        result["round"] = rnd
        result["claims"] = {str(k): v for k, v in claims.items()}
        step("settled", secondsAfterEnd=round(time.time() - t_end, 1),
             settlement=sett, claims=claims)

        paid = []
        for p in players:
            if not any(c["kind"] in ("winnings", "refund") for c in claims[p.n]):
                continue
            await p.page.goto(CLIENT)
            await p.card()
            await p.page.evaluate("window.__lastTx = null")
            pre = balance(p.address, mint)
            await p.page.click("[data-testid=pot-claim]", timeout=30_000)
            await p.page.wait_for_function("() => !!window.__lastTx", timeout=90_000)
            sig = await p.page.evaluate("window.__lastTx")
            after = pre
            for _ in range(30):
                after = balance(p.address, mint)
                if after != pre:
                    break
                await asyncio.sleep(1)
            paid.append({"player": p.n, "address": p.address, "claimTx": b58(sig),
                         "balanceBeforeClaim": pre, "balanceAfterClaim": after,
                         "received": after - pre})
            await shot(p.page, f"09-claimed-{p.n}")
        result["paid"] = paid
        step("paid", paid=paid)
        result["consoleErrors"] = {p.n: p.errors[:10] for p in players}
        await browser.close()

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8", newline="\n")
    log("done", OUT / "result.json")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        CLIENT = sys.argv[1]
    asyncio.run(main())
