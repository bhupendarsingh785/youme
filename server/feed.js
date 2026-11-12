// Feed ranking — "tumhari pasand" algorithm, ab server par.
// Pure functions: db se alag, isliye test karna aasaan.

export function scorePost(p, ctx, now, rng) {
  const ageH = Math.max(0, (now - p.created_at) / 3600000);
  const c = {
    "naya": Math.exp(-ageH / 18) * 4 + (p.user_id === ctx.uid && ageH < 0.2 ? 3 : 0),
    "trending": Math.log(1 + p.likes) * 0.8 + Math.log(1 + p.replies) * 1.5,
    "tumhe pasand hai": (ctx.aff.get(p.user_id) || 0) * 0.5,
    "mehnat se bana": (p.img ? 1.2 : 0) + (p.media ? 0.5 : 0) + Math.min(1, (p.text || "").length / 160),
    "naya creator": (ctx.postCount.get(p.user_id) || 0) <= 2 ? 0.8 : 0,
  };
  let total = rng() * 0.6, why = "", best = 0.4;
  for (const k of Object.keys(c)) {
    total += c[k];
    if (c[k] > best) { best = c[k]; why = k; }
  }
  return { score: total, why };
}

/** posts: [{id,user_id,likes,replies,img,media,text,created_at,...}]
 *  ctx: { uid, aff: Map(authorId -> score), postCount: Map(authorId -> n) } */
export function rankPosts(posts, ctx, now = Date.now(), rng = Math.random) {
  const pool = posts.map((p) => ({ p, ...scorePost(p, ctx, now, rng) }));
  const out = [];
  let last = null;
  while (pool.length) {
    let bi = 0, bs = -Infinity;
    for (let k = 0; k < pool.length; k++) {
      const v = pool[k].score - (last !== null && pool[k].p.user_id === last ? 1.2 : 0);
      if (v > bs) { bs = v; bi = k; }
    }
    const [pick] = pool.splice(bi, 1);
    out.push({ ...pick.p, why: pick.why });
    last = pick.p.user_id;
  }
  return out;
}
