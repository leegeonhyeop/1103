// Supabase 저장소 - 모은 식당 데이터를 저장하고 다시 불러옵니다.
// 외부 패키지 없이 Supabase REST API(PostgREST)를 fetch로 호출합니다.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없으면 아무것도 하지 않습니다.

const PAGE = 1000; // Supabase가 한 번에 돌려주는 최대 행 수
const CHUNK = 500; // 한 번에 저장하는 행 수

function config() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return url && key ? { url, key } : null;
}

const isEnabled = () => Boolean(config());

async function rest(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.message || j.hint || text;
    } catch {}
    if (/relation .* does not exist|Could not find the table/i.test(msg)) {
      msg = "Supabase에 테이블이 없습니다. supabase/schema.sql 을 SQL Editor에서 실행하세요.";
    }
    throw new Error(`Supabase ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------- 행 변환 ----------

function toRow(s) {
  return {
    id: s.id,
    name: s.name,
    branch: s.branch,
    category_large: s.large,
    category_middle: s.middle,
    category_small: s.small,
    ksic: s.ksic,
    sido: s.sido,
    sigungu: s.sigungu,
    adong: s.adong,
    ldong: s.ldong,
    jibun_addr: s.jibunAddr,
    road_name: s.roadName,
    road_addr: s.roadAddr,
    building: s.building,
    zip: s.zip,
    dong: s.dong,
    floor: s.floor,
    ho: s.ho,
    lat: s.lat,
    lon: s.lon,
    updated_at: new Date().toISOString(),
  };
}

function fromRow(r) {
  return {
    id: r.id,
    name: r.name,
    branch: r.branch,
    large: r.category_large,
    middle: r.category_middle,
    small: r.category_small,
    ksic: r.ksic,
    sido: r.sido,
    sigungu: r.sigungu,
    adong: r.adong,
    ldong: r.ldong,
    jibunAddr: r.jibun_addr,
    roadName: r.road_name,
    roadAddr: r.road_addr,
    building: r.building,
    zip: r.zip,
    dong: r.dong,
    floor: r.floor,
    ho: r.ho,
    lat: r.lat,
    lon: r.lon,
  };
}

// ---------- 불러오기 ----------

// 저장된 검색 결과가 있으면 { road, region, roadLines, stores, calls, truncated, savedAt } 반환
async function loadSearch(searchId) {
  const id = encodeURIComponent(searchId);
  const rows = await rest(`road_searches?id=eq.${id}&select=*`);
  const search = rows?.[0];
  if (!search) return null;

  const stores = [];
  for (let offset = 0; ; offset += PAGE) {
    const links = await rest(
      `road_search_restaurants?search_id=eq.${id}&select=restaurants(*)` +
        `&order=restaurant_id&limit=${PAGE}&offset=${offset}`
    );
    for (const l of links) if (l.restaurants) stores.push(fromRow(l.restaurants));
    if (links.length < PAGE) break;
  }

  return {
    road: search.road,
    region: search.region,
    roadLines: search.road_lines || [],
    stores,
    calls: search.api_calls,
    truncated: search.truncated,
    savedAt: search.searched_at,
  };
}

// ---------- 저장하기 ----------

async function insertChunks(table, rows, prefer) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await rest(table, { method: "POST", body: rows.slice(i, i + CHUNK), prefer });
  }
}

async function saveSearch(searchId, { road, region, includeSideStreets, roadLines, stores, calls, truncated }) {
  // 1) 식당: 이미 있으면 최신 정보로 덮어씁니다.
  await insertChunks(
    "restaurants",
    stores.map(toRow),
    "resolution=merge-duplicates,return=minimal"
  );

  // 2) 검색 기록
  await rest("road_searches", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [
      {
        id: searchId,
        road,
        region,
        include_side_streets: includeSideStreets,
        road_lines: roadLines,
        api_calls: calls,
        truncated,
        store_count: stores.length,
        searched_at: new Date().toISOString(),
      },
    ],
  });

  // 3) 검색-식당 연결: 예전 연결을 지우고 새로 넣습니다.
  await rest(`road_search_restaurants?search_id=eq.${encodeURIComponent(searchId)}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  await insertChunks(
    "road_search_restaurants",
    stores.map((s) => ({ search_id: searchId, restaurant_id: s.id })),
    "resolution=ignore-duplicates,return=minimal"
  );
}

module.exports = { isEnabled, loadSearch, saveSearch };
