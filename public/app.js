// 길따라 식당지도 - 화면 로직

const CATEGORY_COLORS = {
  "한식": "#e4572e",
  "중식": "#d81159",
  "일식": "#2563eb",
  "서양식": "#7c3aed",
  "동남아시아": "#0d9488",
  "기타 외국": "#0891b2",
  "구내식당·뷔페": "#65a30d",
  "기타 간이": "#d97706",
  "비알코올": "#92400e",
  "주점": "#4f46e5",
};
const CATEGORY_LABELS = { "비알코올": "카페·음료", "기타 간이": "분식·간이" };
const FALLBACK_COLOR = "#64748b";

const colorOf = (cat) => CATEGORY_COLORS[cat] || FALLBACK_COLOR;
const labelOf = (cat) => CATEGORY_LABELS[cat] || cat;

const $ = (id) => document.getElementById(id);
const els = {
  form: $("search-form"),
  q: $("q"),
  side: $("side"),
  btn: $("search-btn"),
  status: $("status"),
  choices: $("choices"),
  detail: $("detail"),
  results: $("results"),
  summary: $("summary"),
  chips: $("chips"),
  filter: $("filter"),
  list: $("list"),
  intro: $("intro"),
};

const state = {
  stores: [],
  hidden: new Set(), // 숨긴 업종
  text: "",
  selectedId: null,
};

// ---------- 지도 ----------

const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([36.5, 127.8], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const roadLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let selectedRing = null;

// ---------- 공통 ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function setStatus(msg, kind = "") {
  els.status.textContent = msg || "";
  els.status.className = "status " + kind;
}

function floorText(s) {
  const parts = [];
  if (s.dong) parts.push(`${s.dong}동`);
  if (s.floor) parts.push(/^B|^지하/.test(s.floor) ? s.floor : `${s.floor}층`);
  if (s.ho) parts.push(`${s.ho}호`);
  return parts.join(" ");
}

// ---------- 검색 ----------

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  search(els.q.value.trim());
});

let lastSearch = null; // "새로 모으기"용

async function search(q, region, refresh = false) {
  if (!q) return;
  const params = new URLSearchParams({ q });
  if (region) params.set("region", region);
  if (els.side.checked) params.set("side", "1");
  if (refresh) params.set("refresh", "1");

  // 주소창에 검색어를 남겨서 새로고침·공유해도 같은 결과가 나오게 합니다.
  const pageParams = new URLSearchParams({ q });
  if (region) pageParams.set("region", region);
  if (els.side.checked) pageParams.set("side", "1");
  history.replaceState(null, "", "?" + pageParams);

  els.btn.disabled = true;
  els.choices.hidden = true;
  setStatus("검색 중...", "loading");

  try {
    const res = await fetch("/api/search?" + params);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleMessage(JSON.parse(line), q);
      }
    }
  } catch (err) {
    setStatus("서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인하세요.", "error");
  } finally {
    els.btn.disabled = false;
  }
}

function handleMessage(msg, q) {
  switch (msg.type) {
    case "status":
      setStatus(msg.message, "loading");
      break;
    case "progress":
      setStatus(`식당 ${msg.found}곳 찾음 · 조회 ${msg.calls}회 (남은 구간 ${msg.pending})`, "loading");
      break;
    case "choose":
      showChoices(msg, q);
      break;
    case "result":
      setStatus("");
      lastSearch = { q, region: msg.region };
      showResult(msg);
      break;
    case "notice":
      setStatus(msg.message, "loading");
      break;
    case "saved":
      setSaveNote(`Supabase에 ${msg.count.toLocaleString()}곳 저장했어요.`);
      break;
    case "saveError":
      setSaveNote(`Supabase 저장 실패: ${msg.message}`, true);
      break;
    case "error":
      setStatus(msg.message, "error");
      break;
  }
}

function showChoices(msg, q) {
  setStatus("");
  els.choices.innerHTML = `<p>'${esc(msg.road)}'가 여러 지역에 있어요. 지역을 고르세요.</p>`;
  for (const opt of msg.options) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `${esc(opt.label)}${opt.districts.length ? `<small>${esc(opt.districts.join(", "))}</small>` : ""}`;
    b.addEventListener("click", () => search(q, opt.id));
    els.choices.appendChild(b);
  }
  const hint = document.createElement("small");
  hint.className = "hint";
  hint.textContent = `찾는 지역이 없으면 '대전 ${msg.road}'처럼 지역을 같이 입력하세요.`;
  els.choices.appendChild(hint);
  els.choices.hidden = false;
}

// ---------- 결과 표시 ----------

function showResult(data) {
  state.stores = data.stores.map((s) => ({ ...s, cat: (s.middle || "기타").trim() }));
  state.hidden.clear();
  state.text = "";
  els.filter.value = "";
  closeDetail();

  els.intro.hidden = true;
  els.results.hidden = false;

  const note = [];
  if (data.truncated) note.push("도로가 길어서 일부 구간만 조회했어요.");
  if (data.source === "supabase") {
    const d = new Date(data.savedAt);
    note.push(`Supabase에 저장된 데이터예요 (${d.toLocaleDateString("ko-KR")} 수집).`);
  } else if (data.source === "memory") {
    note.push("최근 검색 결과를 다시 보여줍니다.");
  }
  const canRefresh = data.source === "supabase" || data.source === "memory";
  els.summary.innerHTML =
    `${esc(data.region)} <b>${esc(data.road)}</b> · 식당 <b>${state.stores.length.toLocaleString()}</b>곳` +
    `<span class="note">${esc(note.join(" "))}` +
    (canRefresh ? ` <button type="button" class="link-btn" id="refresh-btn">새로 모으기</button>` : "") +
    `</span><span class="note" id="save-note"></span>`;
  document.getElementById("refresh-btn")?.addEventListener("click", () => {
    if (lastSearch) search(lastSearch.q, lastSearch.region, true);
  });

  drawRoad(data.roadLines);
  buildChips();
  render();
  fitToResults();
}

function setSaveNote(text, isError = false) {
  const el = document.getElementById("save-note");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function drawRoad(lines) {
  roadLayer.clearLayers();
  for (const line of lines || []) {
    if (line.length < 2) continue;
    L.polyline(line.map(([lon, lat]) => [lat, lon]), {
      color: "#e4572e",
      weight: 6,
      opacity: 0.25,
      interactive: false,
    }).addTo(roadLayer);
  }
}

function fitToResults() {
  const pts = state.stores.map((s) => [s.lat, s.lon]);
  roadLayer.eachLayer((l) => pts.push(...l.getLatLngs()));
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 17 });
}

function buildChips() {
  const counts = new Map();
  for (const s of state.stores) counts.set(s.cat, (counts.get(s.cat) || 0) + 1);
  const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  els.chips.innerHTML = "";
  const all = document.createElement("button");
  all.className = "chip all";
  all.type = "button";
  all.textContent = "전체";
  all.addEventListener("click", () => {
    if (state.hidden.size) state.hidden.clear();
    else cats.forEach(([c]) => state.hidden.add(c));
    updateChips();
    render();
  });
  els.chips.appendChild(all);

  for (const [cat, n] of cats) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.dataset.cat = cat;
    b.innerHTML = `<span class="dot" style="background:${colorOf(cat)}"></span>${esc(labelOf(cat))} ${n}`;
    b.addEventListener("click", () => {
      state.hidden.has(cat) ? state.hidden.delete(cat) : state.hidden.add(cat);
      updateChips();
      render();
    });
    els.chips.appendChild(b);
  }
}

function updateChips() {
  els.chips.querySelectorAll(".chip[data-cat]").forEach((b) => {
    b.classList.toggle("off", state.hidden.has(b.dataset.cat));
  });
}

els.filter.addEventListener("input", () => {
  state.text = els.filter.value.trim().toLowerCase();
  render();
});

function visibleStores() {
  return state.stores.filter((s) => {
    if (state.hidden.has(s.cat)) return false;
    if (!state.text) return true;
    return [s.name, s.branch, s.middle, s.small, s.building].join(" ").toLowerCase().includes(state.text);
  });
}

function render() {
  const stores = visibleStores();
  renderList(stores);
  renderMarkers(stores);
}

function renderList(stores) {
  els.list.innerHTML = "";
  if (!stores.length) {
    els.list.innerHTML = `<li class="empty">조건에 맞는 식당이 없어요.</li>`;
    return;
  }
  const sorted = [...stores].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const frag = document.createDocumentFragment();
  for (const s of sorted) {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    if (s.id === state.selectedId) li.classList.add("active");
    const where = [s.roadAddr?.split(" ").slice(-2).join(" "), floorText(s)].filter(Boolean).join(" · ");
    li.innerHTML =
      `<span class="dot" style="background:${colorOf(s.cat)}"></span>` +
      `<div><div class="name">${esc(s.name)}${s.branch ? ` <small>${esc(s.branch)}</small>` : ""}</div>` +
      `<div class="sub">${esc(s.small)} · ${esc(where)}</div></div>`;
    li.addEventListener("click", () => selectStore(s.id, true));
    frag.appendChild(li);
  }
  els.list.appendChild(frag);
}

// 같은 건물(같은 좌표)에 여러 식당이 있으면 점 하나로 묶습니다.
function renderMarkers(stores) {
  markerLayer.clearLayers();
  const groups = new Map();
  for (const s of stores) {
    const key = `${s.lat.toFixed(6)},${s.lon.toFixed(6)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const group of groups.values()) {
    const first = group[0];
    const n = group.length;
    const marker = L.circleMarker([first.lat, first.lon], {
      radius: n > 1 ? Math.min(6 + Math.sqrt(n) * 2, 14) : 6,
      color: "#fff",
      weight: 1.5,
      fillColor: colorOf(first.cat),
      fillOpacity: 0.9,
    });
    marker.bindTooltip(n > 1 ? `${esc(first.name)} 외 ${n - 1}곳` : esc(first.name), { direction: "top", offset: [0, -6] });

    if (n === 1) {
      marker.on("click", () => selectStore(first.id, false));
    } else {
      marker.on("click", () => {
        const html =
          `<div class="popup-title">${esc(first.building || "이 건물")}에 ${n}곳</div>` +
          `<ul class="popup-list">` +
          group
            .map(
              (s) =>
                `<li data-id="${esc(s.id)}"><span class="dot" style="background:${colorOf(s.cat)}"></span>${esc(s.name)} <small>${esc(floorText(s))}</small></li>`
            )
            .join("") +
          `</ul>`;
        const popup = L.popup({ maxWidth: 260 }).setLatLng(marker.getLatLng()).setContent(html).openOn(map);
        popup.getElement().querySelectorAll("li[data-id]").forEach((li) =>
          li.addEventListener("click", () => selectStore(li.dataset.id, false))
        );
      });
    }
    marker.addTo(markerLayer);
  }
}

// ---------- 상세 정보 ----------

function selectStore(id, fromList) {
  const s = state.stores.find((x) => x.id === id);
  if (!s) return;
  state.selectedId = id;

  els.list.querySelectorAll("li.active").forEach((li) => li.classList.remove("active"));
  els.list.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.classList.add("active");

  if (selectedRing) selectedRing.remove();
  selectedRing = L.circleMarker([s.lat, s.lon], {
    radius: 13,
    color: "#111",
    weight: 2.5,
    fill: false,
    interactive: false,
  }).addTo(map);

  if (fromList) {
    map.closePopup();
    map.setView([s.lat, s.lon], Math.max(map.getZoom(), 17));
  }
  showDetail(s);
}

function showDetail(s) {
  const rows = [
    ["도로명주소", s.roadAddr],
    ["지번주소", s.jibunAddr],
    ["건물", s.building],
    ["위치", floorText(s)],
    ["우편번호", s.zip],
    ["행정동", [s.sigungu, s.adong].filter(Boolean).join(" ")],
    ["산업분류", s.ksic],
    ["업소번호", s.id],
  ].filter(([, v]) => v);

  const query = encodeURIComponent(`${s.name} ${s.roadAddr || ""}`.trim());
  els.detail.innerHTML = `
    <div class="detail-top">
      <h2>${esc(s.name)}${s.branch ? `<small>${esc(s.branch)}</small>` : ""}</h2>
      <button class="close" type="button" aria-label="닫기">×</button>
    </div>
    <div class="tags">
      <span class="tag main" style="background:${colorOf(s.cat)}">${esc(labelOf(s.cat))}</span>
      ${s.small ? `<span class="tag">${esc(s.small)}</span>` : ""}
    </div>
    <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <div class="links">
      <a href="https://map.naver.com/p/search/${query}" target="_blank" rel="noopener">네이버 지도</a>
      <a href="https://map.kakao.com/?q=${encodeURIComponent(s.name + " " + (s.sigungu || ""))}" target="_blank" rel="noopener">카카오맵</a>
      <a href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}" target="_blank" rel="noopener">구글 지도</a>
    </div>`;
  els.detail.querySelector(".close").addEventListener("click", closeDetail);
  els.detail.hidden = false;
  els.detail.scrollTop = 0;
}

function closeDetail() {
  els.detail.hidden = true;
  state.selectedId = null;
  if (selectedRing) selectedRing.remove();
  selectedRing = null;
  els.list.querySelectorAll("li.active").forEach((li) => li.classList.remove("active"));
}

// ---------- 시작 ----------

(() => {
  const p = new URLSearchParams(location.search);
  const q = p.get("q");
  if (p.get("side") === "1") els.side.checked = true;
  if (q) {
    els.q.value = q;
    search(q, p.get("region") || undefined);
  }
})();
