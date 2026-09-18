import { getStore } from "@netlify/blobs";

const BOARD_SIZE = 5;
const MAX_STORED = 1000; // hard cap so the blob can't grow without bound
const GRADES = ["1年", "2年", "3年", "4年", "5年", "6年"];
const CLASSES = ["1組", "2組", "3組", "4組", "ほしの子学級"];

// Mirrors encodeScore()/checksum36() in exam-practice.html — the exam
// result screen is the only place a code is minted, so decoding here must
// match exactly or every code gets rejected.
function checksum36(s) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1296;
  return ("0" + h.toString(36)).slice(-2).toUpperCase();
}

function decodeScore(code) {
  const cleaned = String(code || "").toUpperCase().replace(/[^0-9A-Z-]/g, "");
  const parts = cleaned.split("-");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (checksum36(parts[0]) !== parts[1]) return null;
  const n = parseInt(parts[0], 36);
  if (!Number.isFinite(n) || n < 0) return null;
  return {
    points: Math.floor(n / 100000000),
    speed: Math.floor(n / 10000) % 10000,
    accuracy: n % 10000
  };
}

function personKey(e) {
  return e.grade + "|" + e.cls + "|" + e.name;
}

// An admin can pin an entry to a fixed board rank (1..BOARD_SIZE) via
// `rankOverride`; every other entry fills the remaining slots by points.
function pinnedRank(e) {
  const r = e.rankOverride;
  return Number.isInteger(r) && r >= 1 && r <= BOARD_SIZE ? r : 0;
}

// Same person (same grade + class + name) keeps only their highest score
// (or their pinned entry, if they have one); the board then shows just the
// top BOARD_SIZE people overall, with pinned entries placed at their rank.
function finalizeList(list) {
  const sorted = list.slice().sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return (b.ts || 0) - (a.ts || 0);
  });
  const chosen = new Map();
  for (const e of sorted) {
    const key = personKey(e);
    const cur = chosen.get(key);
    if (!cur || (!pinnedRank(cur) && pinnedRank(e))) chosen.set(key, e);
  }
  const deduped = sorted.filter((e) => chosen.get(personKey(e)) === e);
  const result = deduped.filter((e) => !pinnedRank(e));
  const pins = deduped
    .filter((e) => pinnedRank(e))
    .sort((a, b) => pinnedRank(a) - pinnedRank(b) || (a.ts || 0) - (b.ts || 0));
  for (const p of pins) {
    result.splice(Math.min(pinnedRank(p) - 1, result.length), 0, p);
  }
  return result.slice(0, BOARD_SIZE);
}

// Admin view: every stored entry, annotated with its current board rank
// (null = not on the board), board entries first in rank order.
function adminView(list) {
  const rankByTs = new Map();
  finalizeList(list).forEach((e, i) => {
    if (e.ts) rankByTs.set(e.ts, i + 1);
  });
  const annotated = list.map((e) => ({ ...e, boardRank: (e.ts && rankByTs.get(e.ts)) || null }));
  annotated.sort((a, b) => {
    if (a.boardRank && b.boardRank) return a.boardRank - b.boardRank;
    if (a.boardRank) return -1;
    if (b.boardRank) return 1;
    return (b.ts || 0) - (a.ts || 0);
  });
  return annotated;
}

// After pinning `moved` to a rank, push any other pins that would collide
// with it one rank down; a pin pushed past the board falls back to automatic.
function resolvePinConflicts(list, moved) {
  const start = pinnedRank(moved);
  if (!start) return;
  const others = list
    .filter((e) => e !== moved && pinnedRank(e) >= start)
    .sort((a, b) => pinnedRank(a) - pinnedRank(b));
  let next = start;
  for (const o of others) {
    if (pinnedRank(o) !== next) break;
    next += 1;
    if (next > BOARD_SIZE) delete o.rankOverride;
    else o.rankOverride = next;
  }
}

function intInRange(v, min, max) {
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Admin access is gated by the ADMIN_PASSWORD environment variable (set in
// the Netlify dashboard, never committed to the repo). Unset = admin
// features stay off rather than open.
function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  const provided = req.headers.get("x-admin-password") || "";
  return expected.length > 0 && provided === expected;
}

export default async (req) => {
  const store = getStore("rival-board");

  if (req.method === "GET") {
    const wantsAdmin = req.headers.has("x-admin-password");
    if (wantsAdmin) {
      if (!isAdmin(req)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const list = (await store.get("entries", { type: "json" })) || [];
      return Response.json({ admin: true, list: adminView(list) });
    }
    const list = (await store.get("entries", { type: "json" })) || [];
    return Response.json(finalizeList(list));
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }

    const grade = String(body.grade || "").trim();
    const cls = String(body.cls || "").trim();
    const name = String(body.name || "").trim().slice(0, 20);

    if (!GRADES.includes(grade)) {
      return Response.json({ error: "invalid_grade" }, { status: 400 });
    }
    if (!CLASSES.includes(cls)) {
      return Response.json({ error: "invalid_cls" }, { status: 400 });
    }
    if (!name) {
      return Response.json({ error: "invalid_name" }, { status: 400 });
    }

    const score = decodeScore(body.code);
    if (!score) {
      return Response.json({ error: "invalid_code" }, { status: 400 });
    }

    const entry = {
      grade, cls, name,
      points: score.points,
      speed: score.speed,
      accuracy: score.accuracy,
      ts: Date.now()
    };

    const list = (await store.get("entries", { type: "json" })) || [];
    list.push(entry);
    const trimmed = list.length > MAX_STORED ? list.slice(list.length - MAX_STORED) : list;
    await store.setJSON("entries", trimmed);

    return Response.json(finalizeList(trimmed));
  }

  if (req.method === "DELETE") {
    if (!isAdmin(req)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const ts = Number(body.ts);
    if (!Number.isFinite(ts) || ts <= 0) {
      return Response.json({ error: "invalid_ts" }, { status: 400 });
    }

    const list = (await store.get("entries", { type: "json" })) || [];
    const filtered = list.filter((e) => e.ts !== ts);
    await store.setJSON("entries", filtered);

    return Response.json({ admin: true, list: adminView(filtered) });
  }

  if (req.method === "PUT") {
    if (!isAdmin(req)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const ts = Number(body.ts);
    if (!Number.isFinite(ts) || ts <= 0) {
      return Response.json({ error: "invalid_ts" }, { status: 400 });
    }

    const list = (await store.get("entries", { type: "json" })) || [];
    const entry = list.find((e) => e.ts === ts);
    if (!entry) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // Validate everything first so a bad field can't leave a half-edited entry.
    const next = {};
    if (body.grade !== undefined) {
      const grade = String(body.grade).trim();
      if (!GRADES.includes(grade)) {
        return Response.json({ error: "invalid_grade" }, { status: 400 });
      }
      next.grade = grade;
    }
    if (body.cls !== undefined) {
      const cls = String(body.cls).trim();
      if (!CLASSES.includes(cls)) {
        return Response.json({ error: "invalid_cls" }, { status: 400 });
      }
      next.cls = cls;
    }
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 20);
      if (!name) {
        return Response.json({ error: "invalid_name" }, { status: 400 });
      }
      next.name = name;
    }
    const numericFields = [["points", 99999], ["speed", 9999], ["accuracy", 100]];
    for (const [field, max] of numericFields) {
      if (body[field] === undefined) continue;
      const n = intInRange(body[field], 0, max);
      if (n === null) {
        return Response.json({ error: "invalid_number" }, { status: 400 });
      }
      next[field] = n;
    }
    let rank;
    if ("rank" in body) {
      if (body.rank === null || body.rank === "") {
        rank = 0;
      } else {
        rank = intInRange(body.rank, 1, BOARD_SIZE);
        if (rank === null) {
          return Response.json({ error: "invalid_rank" }, { status: 400 });
        }
      }
    }

    Object.assign(entry, next);
    if (rank === 0) delete entry.rankOverride;
    else if (rank) entry.rankOverride = rank;
    resolvePinConflicts(list, entry);
    await store.setJSON("entries", list);

    return Response.json({ admin: true, list: adminView(list) });
  }

  return Response.json({ error: "method_not_allowed" }, { status: 405 });
};

export const config = {
  path: "/api/rival-board"
};
