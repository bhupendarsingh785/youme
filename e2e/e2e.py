"""Asli Chrome me poora flow test (login, recovery, post, report/block, DM, local mode).
Chalane ke liye:  pip install playwright   aur Chrome chahiye (CHROME=/path/to/chrome)
                  python3 e2e/e2e.py
CI me nahi chalta (Chrome chahiye) — bade badlav ke baad apne aap chalao."""
import json, re, subprocess, sys, time, urllib.request, os, shutil, tempfile
from playwright.sync_api import sync_playwright, expect

PORT = 3997
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="ym-e2e-")
DB = os.path.join(TMP, "youme.db")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
srv = subprocess.Popen(["node", "--disable-warning=ExperimentalWarning", os.path.join(ROOT, "server", "index.js")],
    env={**os.environ, "PORT": str(PORT), "DB_PATH": DB, "JWT_SECRET": "e2e-secret"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.5)

def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)

results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if (extra and not cond) else ""))

try:
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
        ctx = br.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        page.goto(BASE); page.wait_for_selector("#loginScreen.on", timeout=8000)
        check("backend mila -> login screen", True)

        # --- signup #1: recovery screen, token tab band hone tak save nahi
        page.fill("#lgUser", "e2e_one"); page.fill("#lgName", "Ek"); page.fill("#lgPass", "secret123")
        page.click("#lgSignup"); page.wait_for_selector("#recoveryScreen.on")
        code1 = page.inner_text("#rcCode").strip()
        check("recovery code dikha", re.fullmatch(r"([A-Z2-9]{4}-){4}[A-Z2-9]{4}", code1), code1)
        page.click("#rcContinue")
        check("tick ke bina aage nahi badh sakte", page.locator("#recoveryScreen.on").count() == 1)
        check("recovery screen par token save nahi", page.evaluate("localStorage.getItem('ym.token')") in (None, ""))
        page.check("#rcOk"); page.click("#rcContinue"); page.wait_for_selector("#homeScreen.on")
        check("home khula, token save", bool(page.evaluate("localStorage.getItem('ym.token')")))

        # --- post
        page.click('nav [data-s="create"]'); page.fill("#postText", "mera pehla server post"); page.click("#doPost")
        page.wait_for_selector("#homeScreen.on"); page.wait_for_selector("#feed article:has-text('mera pehla server post')")
        check("post feed me dikha", True)
        page.click('nav [data-s="profile"]'); page.wait_for_timeout(300)
        check("coins: post 5 + roz ka 2 = 7", page.inner_text("#coins").strip() == "7", page.inner_text("#coins"))
        check("profile me server username", "@e2e_one" in page.inner_text("#profHandle"))

        # --- doosra user API se: post + DM
        s, two = api("POST", "/api/signup", body={"username": "e2e_two", "password": "secret123", "display": "Do"})
        api("POST", "/api/posts", two["token"], {"text": "do ka post"})
        s, thr = api("POST", "/api/signup", body={"username": "e2e_three", "password": "secret123", "display": "Teen"})
        api("POST", "/api/messages", thr["token"], {"to": "e2e_one", "text": "hello from three"})

        page.reload(); page.wait_for_selector("#homeScreen.on"); page.wait_for_selector("#feed article")
        page.wait_for_function("document.querySelector('nav [data-s=dm]').dataset.badge === '1'", timeout=6000)
        check("Inbox par unread badge 1", True)
        check("feed me do ka post", page.locator("#feed article:has-text('do ka post')").count() == 1)

        # --- own post menu (delete option) / other post menu (report, block)
        own = page.locator("#feed article:has-text('mera pehla server post') [data-more]")
        own.click(); page.wait_for_selector("#sheet[style*='block']")
        check("apne post par delete option", "delete" in page.inner_text("#sheetBox").lower())
        page.click("[data-sh='x']")
        page.locator("#feed article:has-text('do ka post') [data-more]").click()
        box = page.inner_text("#sheetBox")
        check("doosre ke post par report + block", "Report" in box and "block" in box.lower())
        page.locator("#sheetBox button", has_text="Report karo").click()
        page.locator("#sheetBox button", has_text="Spam").click()
        page.wait_for_function("!document.querySelector('#feed').innerText.includes('do ka post')")
        check("report ke baad post turant chhupa", True)

        # --- DM
        page.click('nav [data-s="dm"]'); page.wait_for_selector("#dmList [data-c='u:e2e_three']")
        check("DM list me e2e_three", True)
        page.click("#dmList [data-c='u:e2e_three']"); page.wait_for_selector("#chatBody:has-text('hello from three')")
        page.fill("#chatIn", "jawab: namaste"); page.click("#chatSend")
        page.wait_for_selector("#chatBody:has-text('jawab: namaste')")
        s, t = api("GET", "/api/messages/e2e_one", thr["token"])
        check("jawab server par pahucha", any(m["text"] == "jawab: namaste" for m in t["messages"]))
        page.wait_for_function("document.querySelector('nav [data-s=dm]').dataset.badge === ''", timeout=35000) if False else None
        # naya message poll se aaye
        api("POST", "/api/messages", thr["token"], {"to": "e2e_one", "text": "live aaya"})
        page.wait_for_selector("#chatBody:has-text('live aaya')", timeout=9000)
        check("naya message poll se apne aap aaya", True)

        # --- chat se block
        page.click("#chatMore"); page.locator("#sheetBox button", has_text="block").first.click()
        page.wait_for_selector("#dmScreen.on")
        s, r = api("POST", "/api/messages", two["token"], {"to": "e2e_one", "text": "x"})  # control: do abhi block nahi
        s2, r2 = api("POST", "/api/messages", thr["token"], {"to": "e2e_one", "text": "blocked?"})
        check("block ke baad teen message nahi bhej sakta", s2 == 403, str(s2))

        # --- logout + forgot password
        page.click('nav [data-s="profile"]'); page.click("#logoutBtn"); page.wait_for_selector("#loginScreen.on")
        page.click("#lgForgot"); page.wait_for_selector("#forgotScreen.on")
        page.fill("#fgUser", "e2e_one"); page.fill("#fgCode", code1.lower()); page.fill("#fgPass", "brandnew99")
        page.click("#fgGo"); page.wait_for_selector("#recoveryScreen.on")
        code2 = page.inner_text("#rcCode").strip()
        check("recover ke baad naya code", code2 != code1)
        page.check("#rcOk"); page.click("#rcContinue"); page.wait_for_selector("#homeScreen.on")
        check("naye password se andar", True)
        s, _ = api("POST", "/api/login", body={"username": "e2e_one", "password": "secret123"})
        check("purana password band", s == 401)

        # --- local mode bhi chalta hai (backend na mile): file:// jaisa
        page2 = ctx.new_page(); page2.on("pageerror", lambda e: errors.append("p2:" + str(e)))
        page2.goto("file://" + os.path.join(ROOT, "public", "index.html")); page2.wait_for_timeout(3500)
        check("backend ke bina local mode: home dikhta hai", page2.locator("#homeScreen.on").count() == 1)
        check("local mode me ⋯ button chhupa", not page2.locator("#feed [data-more]").first.is_visible())

        real_errors = [e for e in errors if "Failed to fetch" not in e and "dynamically imported" not in e]
        check("koi JS error nahi", not real_errors, "; ".join(real_errors)[:300])
        page.screenshot(path=os.path.join(TMP, "home.png"))
        br.close()
finally:
    srv.terminate()
    shutil.rmtree(TMP, ignore_errors=True)

bad = [n for n, ok in results if not ok]
print(f"\n{len(results)-len(bad)}/{len(results)} pass")
sys.exit(1 if bad else 0)
