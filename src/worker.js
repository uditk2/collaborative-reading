// Ramayana Reading: tiny API on Cloudflare Workers (free plan).
// Photos live in KV, the timeline (who, when) lives in D1.

const MAX_FULL = 2_500_000; // bytes, the page already compresses to ~0.5 MB
const MAX_THUMB = 300_000;
const PEOPLE = ["Udit", "Mum"]; // only these two can upload

let ready = null;

function init(env) {
  if (!ready) {
    ready = env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, who TEXT NOT NULL, doha TEXT, created_at INTEGER NOT NULL)"
      ),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS photos_time ON photos (created_at DESC)"
      ),
    ])
      // Databases made before the Doha field existed: add the column once, ignore if already there.
      .then(() => env.DB.prepare("ALTER TABLE photos ADD COLUMN doha TEXT").run().catch(() => {}))
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

function isJpeg(buf) {
  const b = new Uint8Array(buf, 0, 3);
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Install manifest: carries the optional access key into the home-screen app.
      if (path === "/manifest.webmanifest") {
        const k = url.searchParams.get("k");
        return new Response(
          JSON.stringify({
            name: "Ramayana Reading",
            short_name: "Ramayana",
            start_url: k ? `/?k=${encodeURIComponent(k)}` : "/",
            display: "standalone",
            background_color: "#FBF3E4",
            theme_color: "#FBF3E4",
            icons: [
              { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
              { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
            ],
          }),
          { headers: { "content-type": "application/manifest+json" } }
        );
      }

      // Photo files. Ids are random and unguessable, and never change, so cache forever.
      const img = path.match(/^\/api\/img\/([0-9a-f-]{36})\/(full|thumb)$/);
      if (img && request.method === "GET") {
        const body = await env.PHOTOS.get(`${img[2]}:${img[1]}`, { type: "stream" });
        if (!body) return new Response("Not found", { status: 404 });
        return new Response(body, {
          headers: {
            "content-type": "image/jpeg",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }

      // Everything below needs the access key, if one has been set.
      if (path.startsWith("/api/")) {
        if (env.ACCESS_KEY && request.headers.get("x-key") !== env.ACCESS_KEY) {
          return json({ error: "locked" }, 401);
        }
        await init(env);
      }

      if (path === "/api/photos" && request.method === "GET") {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit")) || 60, 1), 200);
        const before = parseInt(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
        const { results } = await env.DB.prepare(
          "SELECT id, who, doha, created_at FROM photos WHERE created_at < ? ORDER BY created_at DESC LIMIT ?"
        )
          .bind(before, limit)
          .all();
        return json({ photos: results });
      }

      if (path === "/api/photos" && request.method === "POST") {
        const form = await request.formData();
        const who = String(form.get("who") || "").trim();
        const full = form.get("full");
        const thumb = form.get("thumb");
        const doha = String(form.get("doha") || "").trim(); // optional, digits only

        if (!PEOPLE.includes(who)) return json({ error: "unknown person" }, 400);
        if (doha && !/^\d{1,4}$/.test(doha)) return json({ error: "bad doha number" }, 400);
        if (!full || !thumb || typeof full === "string" || typeof thumb === "string") {
          return json({ error: "missing photo" }, 400);
        }
        if (full.size > MAX_FULL || thumb.size > MAX_THUMB) return json({ error: "too big" }, 413);

        const fullBuf = await full.arrayBuffer();
        const thumbBuf = await thumb.arrayBuffer();
        if (!isJpeg(fullBuf) || !isJpeg(thumbBuf)) return json({ error: "not a photo" }, 400);

        const id = crypto.randomUUID();
        const created_at = Date.now();

        // Photos first, timeline row last, so the timeline never points at a missing photo.
        await Promise.all([
          env.PHOTOS.put(`full:${id}`, fullBuf),
          env.PHOTOS.put(`thumb:${id}`, thumbBuf),
        ]);
        await env.DB.prepare("INSERT INTO photos (id, who, doha, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, who, doha || null, created_at)
          .run();

        return json({ id, who, doha: doha || null, created_at }, 201);
      }

      // Fix or remove one entry. The page always asks "are you sure?" before calling these.
      const one = path.match(/^\/api\/photos\/([0-9a-f-]{36})$/);
      if (one && request.method === "PATCH") {
        const id = one[1];
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
        const sets = [];
        const vals = [];
        if ("who" in body) {
          if (!PEOPLE.includes(body.who)) return json({ error: "unknown person" }, 400);
          sets.push("who = ?");
          vals.push(body.who);
        }
        if ("doha" in body) {
          const d = String(body.doha ?? "").trim();
          if (d && !/^\d{1,4}$/.test(d)) return json({ error: "bad doha number" }, 400);
          sets.push("doha = ?");
          vals.push(d || null);
        }
        if (!sets.length) return json({ error: "nothing to change" }, 400);
        const res = await env.DB.prepare(`UPDATE photos SET ${sets.join(", ")} WHERE id = ?`)
          .bind(...vals, id)
          .run();
        if (!res.meta.changes) return json({ error: "not found" }, 404);
        const row = await env.DB.prepare("SELECT id, who, doha, created_at FROM photos WHERE id = ?")
          .bind(id)
          .first();
        return json(row);
      }
      if (one && request.method === "DELETE") {
        const id = one[1];
        // Timeline row first, so nothing ever points at a missing photo.
        const res = await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
        if (!res.meta.changes) return json({ error: "not found" }, 404);
        await Promise.all([env.PHOTOS.delete(`full:${id}`), env.PHOTOS.delete(`thumb:${id}`)]);
        return json({ ok: true });
      }

      if (path.startsWith("/api/")) return json({ error: "not found" }, 404);

      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: "server error" }, 500);
    }
  },
};
