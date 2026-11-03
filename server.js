// 도로명 → 식당 지도 서버
// - 공공데이터포털 상가(상권)정보 API 키를 숨기고, 브라우저 대신 외부 API를 호출합니다.
// - 외부 패키지 없이 Node.js(18+) 기본 기능만 사용합니다.

const http = require("http");
const fs = require("fs");
const path = require("path");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.DATA_GO_KR_KEY;
const STORE_API = "https://apis.data.go.kr/B553077/api/open/sdsc2";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "road-restaurant-map/1.0 (local dev)";

const FOOD_CODE = "I2"; // 상권업종대분류: 음식
const RADIUS = 250; // 반경 검색 크기(m)
const MIN_GAP = 200; // 검색 중심점끼리의 최소 거리(m)
const MAX_CALLS = 80; // 한 번 검색할 때 상가 API 최대 호출 수
const CONCURRENCY = 1; // 개발계정은 동시 요청 시 초당 한도 오류가 나서 순서대로 보냅니다

if (!API_KEY) {
  console.error("DATA_GO_KR_KEY가 없습니다. .env 파일을 확인하세요 (.env.example 참고).");
  process.exit(1);
}

// ---------- 유틸 ----------

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

function distM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "대전 중앙로" → { road: "중앙로", regionWords: ["대전"] }
function parseQuery(q) {
  const words = q.trim().split(/\s+/).filter(Boolean);
  const road = words.pop() || "";
  return { road, regionWords: words };
}

// ---------- Nominatim: 도로 위치 찾기 ----------

let lastNominatim = 0;
async function nominatimSearch(q) {
  // Nominatim 이용 정책: 초당 1회 이하
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();

  const u = new URL(NOMINATIM);
  const params = {
    q,
    format: "jsonv2",
    countrycodes: "kr",
    limit: "40",
    dedupe: "0",
    addressdetails: "1",
    polygon_geojson: "1",
    polygon_threshold: "0.0002",
    "accept-language": "ko",
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`도로 위치 검색 실패 (HTTP ${res.status})`);
  return res.json();
}

function regionOf(addr) {
  const top = addr.province || addr.city || addr.state || "";
  const mid = addr.province ? addr.city || addr.county || "" : addr.county || "";
  return [top, mid].filter(Boolean).join(" ");
}

// 같은 이름의 도로를 지역(시/도 + 시/군) 단위로 묶습니다.
async function findRoadGroups(query) {
  const { road, regionWords } = parseQuery(query);
  const results = await nominatimSearch(query);
  const roads = results.filter(
    (r) => r.category === "highway" && (r.name === road || r.address?.road === road)
  );

  const groups = new Map();
  for (const r of roads) {
    const key = regionOf(r.address || {}) || "지역 미상";
    if (!groups.has(key)) groups.set(key, { id: key, label: key, districts: new Set(), lines: [] });
    const g = groups.get(key);
    const a = r.address || {};
    const district = a.borough || a.county || a.city_district || a.town || "";
    if (district) g.districts.add(district);
    g.lines.push(...geometryToLines(r));
  }

  let list = [...groups.values()].map((g) => ({
    id: g.id,
    label: g.label,
    districts: [...g.districts],
    lines: g.lines,
  }));

  // "대전 중앙로"처럼 지역을 같이 적었으면 그 지역만 남깁니다.
  if (regionWords.length) {
    const filtered = list.filter((g) => {
      const text = g.label + " " + g.districts.join(" ");
      return regionWords.every((w) => text.includes(w));
    });
    if (filtered.length) list = filtered;
  }
  return { road, groups: list };
}

function geometryToLines(r) {
  const g = r.geojson;
  const pt = [[Number(r.lon), Number(r.lat)]];
  if (!g) return [pt];
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  if (g.type === "Polygon") return [g.coordinates[0]];
  return [pt];
}

// 선을 따라 일정 간격으로 점을 뽑습니다. (반환: [{lat, lon}])
function samplePoints(lines, step) {
  const out = [];
  for (const line of lines) {
    if (!line.length) continue;
    let prev = { lon: line[0][0], lat: line[0][1] };
    out.push(prev);
    let acc = 0;
    for (let i = 1; i < line.length; i++) {
      const cur = { lon: line[i][0], lat: line[i][1] };
      const d = distM(prev, cur);
      acc += d;
      if (acc >= step) {
        out.push(cur);
        acc = 0;
      }
      prev = cur;
    }
    out.push(prev);
  }
  return out;
}

// ---------- 상가(상권)정보 API ----------

// 개발계정은 초당 요청 수 제한이 있어서, 요청 사이에 간격을 두고
// 제한에 걸리면 잠시 기다렸다가 다시 시도합니다.
const MIN_INTERVAL_MS = 150;
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_INTERVAL_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function callStoreApi(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    const text = await (await fetch(url)).text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}

    // 오류는 OpenAPI_ServiceResponse(JSON) 또는 XML 형태로 옵니다.
    const err = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    const reason = err?.returnReasonCode || text.match(/<returnReasonCode>(\d+)</)?.[1];
    if (data?.header) return data;
    if (reason === "22" || reason === "23") {
      // 22: 일일 한도 초과, 23: 초당 한도 초과
      if (reason === "22") throw new Error("상가 API 일일 호출 한도를 넘었습니다. 내일 다시 시도하세요.");
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    const msg =
      err?.returnAuthMsg ||
      text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/)?.[1] ||
      text.slice(0, 120);
    throw new Error(`상가 API 오류: ${msg}`);
  }
  throw new Error("상가 API 요청이 너무 많습니다. 잠시 후 다시 시도하세요.");
}

async function storesInRadius(center) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const u = new URL(`${STORE_API}/storeListInRadius`);
    const params = {
      serviceKey: API_KEY,
      pageNo: String(page),
      numOfRows: "1000",
      radius: String(RADIUS),
      cx: String(center.lon),
      cy: String(center.lat),
      indsLclsCd: FOOD_CODE,
      type: "json",
    };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

    const data = await callStoreApi(u);
    const code = data.header?.resultCode;
    if (code === "03") return all; // 데이터 없음
    if (code !== "00") throw new Error(`상가 API 오류: ${data.header?.resultMsg || code}`);

    const items = data.body?.items || [];
    all.push(...items);
    if (all.length >= (data.body?.totalCount || 0) || items.length < 1000) break;
  }
  return all;
}

// 도로를 따라 검색 범위를 넓혀가며 해당 도로에 주소가 있는 식당을 모읍니다.
async function crawlRoad(road, lines, includeSideStreets, onProgress) {
  const base = escapeRegex(road);
  const pattern = includeSideStreets
    ? new RegExp(`(^|\\s)${base}(\\d+(번)?[가-힣]?길)?$`)
    : new RegExp(`(^|\\s)${base}$`);

  const queue = [];
  const centers = [];
  const addCenter = (p) => {
    if (centers.some((c) => distM(c, p) < MIN_GAP)) return;
    centers.push(p);
    queue.push(p);
  };
  for (const p of samplePoints(lines, MIN_GAP)) addCenter(p);

  const found = new Map();
  let calls = 0;

  while (queue.length && calls < MAX_CALLS) {
    const batch = queue.splice(0, Math.min(CONCURRENCY, MAX_CALLS - calls));
    calls += batch.length;
    const results = await Promise.all(batch.map(storesInRadius));
    for (const items of results) {
      for (const s of items) {
        if (!pattern.test(s.rdnm || "")) continue;
        if (found.has(s.bizesId)) continue;
        found.set(s.bizesId, s);
        // 찾은 식당 주변도 검색해서 도로 끝까지 따라갑니다.
        addCenter({ lat: Number(s.lat), lon: Number(s.lon) });
      }
    }
    onProgress({ calls, pending: queue.length, found: found.size });
  }

  return {
    stores: [...found.values()].map(slimStore),
    calls,
    truncated: queue.length > 0,
  };
}

function slimStore(s) {
  return {
    id: s.bizesId,
    name: s.bizesNm,
    branch: s.brchNm,
    large: s.indsLclsNm,
    middle: s.indsMclsNm,
    small: s.indsSclsNm,
    ksic: s.ksicNm,
    sido: s.ctprvnNm,
    sigungu: s.signguNm,
    adong: s.adongNm,
    ldong: s.ldongNm,
    jibunAddr: s.lnoAdr,
    roadName: s.rdnm,
    roadAddr: s.rdnmAdr,
    building: s.bldNm,
    zip: s.newZipcd,
    dong: s.dongNo,
    floor: s.flrNo,
    ho: s.hoNo,
    lat: Number(s.lat),
    lon: Number(s.lon),
  };
}

// ---------- HTTP ----------

const cache = new Map(); // 같은 검색은 1시간 동안 재사용
const CACHE_MS = 60 * 60 * 1000;

async function handleSearch(url, res) {
  const q = (url.searchParams.get("q") || "").trim();
  const regionId = url.searchParams.get("region");
  const side = url.searchParams.get("side") === "1";

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    if (!q) throw new Error("도로명을 입력하세요.");
    const { road } = parseQuery(q);
    if (!/(로|길)$/.test(road)) throw new Error("'○○로' 또는 '○○길' 형태로 입력하세요. 예: 테헤란로, 대전 중앙로");

    send({ type: "status", message: `'${road}' 위치를 찾는 중...` });
    const { groups } = await findRoadGroups(q);
    if (!groups.length) throw new Error(`'${q}' 도로를 찾지 못했습니다. 시/구 이름을 앞에 붙여 보세요. 예: 강남구 ${road}`);

    let group = groups.find((g) => g.id === regionId);
    if (!group) {
      if (groups.length > 1) {
        send({
          type: "choose",
          road,
          options: groups.map((g) => ({ id: g.id, label: g.label, districts: g.districts })),
        });
        return;
      }
      group = groups[0];
    }

    const cacheKey = `${road}|${group.id}|${side}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.time < CACHE_MS) {
      send({ type: "result", ...hit.data, cached: true });
      return;
    }

    send({ type: "status", message: `${group.label} ${road} 주변 식당을 모으는 중...` });
    const result = await crawlRoad(road, group.lines, side, (p) =>
      send({ type: "progress", ...p })
    );
    const data = { road, region: group.label, roadLines: group.lines, ...result };
    cache.set(cacheKey, { time: Date.now(), data });
    send({ type: "result", ...data });
  } catch (err) {
    send({ type: "error", message: err.message || String(err) });
  } finally {
    res.end();
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(url, res) {
  const publicDir = path.join(__dirname, "public");
  const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/search") return void handleSearch(url, res);
    serveStatic(url, res);
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT} 에서 실행 중`));
