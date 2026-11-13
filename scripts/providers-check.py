#!/usr/bin/env python3
"""providers.json padh kar Google login ready hai ya nahi batata."""
import json, sys
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/p.json", encoding="utf-8"))
g = next((p for p in d.get("providers", []) if p.get("key") == "google"), None)
ready = bool(g and g.get("ready"))
print("google login ready:", ready)
print("READY=" + ("1" if ready else "0"))
