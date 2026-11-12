import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("frontend: har inline script ka syntax theek hai", () => {
  assert.ok(scripts.length >= 3, "module + main + server-mode scripts");
  scripts.forEach((code, i) => {
    // module script me top-level await hai, isliye async function me lapet kar jaanchte hain
    assert.doesNotThrow(() => new vm.Script(`(async function(){${code}\n})`), `script #${i + 1}`);
  });
});

test("frontend: HTML me koi id do baar nahi (purane duplicate-id bug jaisa)", () => {
  const body = html.slice(0, html.indexOf("<script"));
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, []);
});

test("frontend: JS jin id ko $('...') se dhundta hai wo HTML me hain", () => {
  const body = html.slice(0, html.indexOf("<script"));
  const have = new Set([...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...scripts.join("\n").matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
  // ye id JS khud banata hai (template me), HTML me nahi hote
  const dynamic = new Set(["reelImg", "openLens"]);
  const missing = [...used].filter((id) => !have.has(id) && !dynamic.has(id));
  assert.deepEqual(missing, []);
});

test("privacy aur terms pages maujood hain", () => {
  for (const f of ["privacy.html", "terms.html"]) {
    assert.match(readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8"), /<h1>/);
  }
});
