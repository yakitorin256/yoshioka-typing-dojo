const { getStore } = require("@netlify/blobs");

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

// Same person (same grade + class + name) keeps only their highest score;
// the board then shows just the top BOARD_SIZE people overall.
function finalizeList(list) {
  const sorted = list.slice().sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return (b.ts || 0) - (a.ts || 0);
  });
  const seen = new Set();
  const deduped = [];
  for (const e of sorted) {
    const key = personKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  return deduped.slice(0, BOARD_SIZE);
}

exports.handler = async (event) => {
  const store = getStore("rival-board");
  const headers = { "Content-Type": "application/json; charset=utf-8" };

  if (event.httpMethod === "GET") {
    const list = (await store.get("entries", { type: "json" })) || [];
    return { statusCode: 200, headers, body: JSON.stringify(finalizeList(list)) };
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_body" }) };
    }

    const grade = String(body.grade || "").trim();
    const cls = String(body.cls || "").trim();
    const name = String(body.name || "").trim().slice(0, 20);

    if (!GRADES.includes(grade)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_grade" }) };
    }
    if (!CLASSES.includes(cls)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_cls" }) };
    }
    if (!name) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_name" }) };
    }

    const score = decodeScore(body.code);
    if (!score) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_code" }) };
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

    return { statusCode: 200, headers, body: JSON.stringify(finalizeList(trimmed)) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "method_not_allowed" }) };
};
