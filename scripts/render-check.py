#!/usr/bin/env python3
"""Render ki env values ka SAFE report — secret print nahi hota."""
import json, sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/env.json"
data = json.load(open(path, encoding="utf-8"))
rows = []
for item in data:
    ev = item.get("envVar", item)
    rows.append((ev.get("key", ""), ev.get("value", "") or ""))

print("kul env vars:", len(rows))
d = dict(rows)
for k, v in sorted(rows):
    if k == "GOOGLE_CLIENT_SECRET":
        ws = "SPACE/NEWLINE HAI" if (v != v.strip() or " " in v) else "saaf"
        print(f"{k}: lambai={len(v)} prefix={v[:7]!r} GOCSPX_se_shuru={v.startswith('GOCSPX-')} {ws}")
    elif k == "GOOGLE_CLIENT_ID":
        print(f"{k}: lambai={len(v)} sahi_format={v.endswith('.apps.googleusercontent.com')} space={'HAAN' if v != v.strip() else 'nahi'}")
    elif k == "PUBLIC_URL":
        print(f"{k}: {v}")
    elif k == "JWT_SECRET":
        print(f"{k}: lambai={len(v)} (chhupa hua)")
    else:
        print(f"{k}: lambai={len(v)}")

print("")
gs = d.get("GOOGLE_CLIENT_SECRET", "")
gid = d.get("GOOGLE_CLIENT_ID", "")
if not gs.startswith("GOCSPX-"):
    print("❌ GOOGLE_CLIENT_SECRET galat (GOCSPX- se shuru hona chahiye)")
elif gid and not gid.endswith(".apps.googleusercontent.com"):
    print("❌ GOOGLE_CLIENT_ID adhura hai")
else:
    print("✅ dono ka roop theek — phir bhi fail ho to Google me naya secret banao")
