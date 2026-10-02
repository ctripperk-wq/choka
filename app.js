/* 釣果まとめ 中四国
 * 店の釣果（data/choka.json、GitHub Actions が2時間おきに更新）と、
 * みんなの投稿（Supabase）を、一覧・地図・魚種で見る。
 * 地域は「店の場所」ではなく「釣った場所」で絞り込む。 */
"use strict";

const CFG = window.CHOKA_CONFIG || {};
const sb = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey)
  : null;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("choka-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("choka-" + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
};

const PREFS9 = ["鳥取", "島根", "岡山", "広島", "山口", "徳島", "香川", "愛媛", "高知"];
const ANGLERS_ID = { 鳥取: 31, 島根: 32, 岡山: 33, 広島: 34, 山口: 35, 徳島: 36, 香川: 37, 愛媛: 38, 高知: 39 };
const KANPARI_SLUG = { 鳥取: "tottori", 島根: "simane", 岡山: "okayama", 広島: "hiroshima", 山口: "yamaguchi", 徳島: "tokushima", 香川: "kagawa", 愛媛: "ehime", 高知: "kochi" };
// 店のある地域（釣り場が分からない釣果の控え）→ 含まれる県
const SHOP_AREA_PREFS = { 山陰: ["鳥取", "島根"], 山陽: ["岡山", "広島", "山口"], 四国: ["徳島", "香川", "愛媛", "高知"], "岡山・広島": ["岡山", "広島"] };

// 魚種の辞書は data/fish.json（fetch.py と共通）
let FISH = [], GROUPS = [];
async function loadFish() {
  try {
    const d = await (await fetch("data/fish.json?v=2")).json();
    GROUPS = d.groups;
    FISH = d.fish.map(f => Object.assign({}, f, { rx: new RegExp(f.re) }));
  } catch (e) { FISH = []; GROUPS = []; }
}
function fishOf(text) {
  const t = String(text || "");
  return FISH.filter(f => f.rx.test((f.excl || []).reduce((s, e) => s.split(e).join(""), t))).map(f => f.name);
}
// ひらがな→カタカナ、全角英数→半角、空白除去（「あじ」でも「アジ」が引けるように）
function norm(s) {
  return String(s || "").replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\s+/g, "").toLowerCase();
}
function searchFish(q) {
  const n = norm(q);
  if (!n) return FISH;
  return FISH.filter(f => [f.name, ...(f.alias || [])].some(w => norm(w).includes(n) || (n.length >= 2 && n.includes(norm(w)))));
}

const S = {
  shop: [], places: [], areas: {}, regions: { 中国: PREFS9.slice(0, 5), 四国: PREFS9.slice(5) },
  updated: "", status: {},
  posts: [], me: null, nickname: store.get("nickname", ""),
  photoUrl: {},          // 写真のパス → 表示用URL
  filter: loadFilter(),
  shown: 60,
  tab: "list",
  fishView: "",          // 魚種タブで開いている魚
};
function loadFilter() {
  const f = Object.assign({ region: "all", area: "", days: 7, kind: "all", src: "all", fish: "", q: "" }, store.get("filter", {}));
  if (f.pref) { if (f.pref !== "all") f.region = f.pref; delete f.pref; }  // 以前の保存形式
  return f;
}

/* ---------- 日付 ---------- */
const pad = n => String(n).padStart(2, "0");
function fmtDate(iso, dateOnly) {
  const d = new Date(iso);
  const s = `${d.getMonth() + 1}/${d.getDate()}`;
  return dateOnly ? s : `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- データ読み込み ---------- */
async function loadShop() {
  try {
    const r = await fetch("data/choka.json?t=" + Date.now(), { cache: "no-store" });
    const d = await r.json();
    S.shop = (d.items || []).map(i => Object.assign({ type: "shop" }, i));
    S.places = d.places || [];
    S.areas = d.areas || {};
    if (d.regions) S.regions = d.regions;
    S.updated = d.updated || "";
    S.status = d.status || {};
  } catch (e) {
    S.shop = [];
  }
  $("#upd").innerHTML = S.updated ? `店の釣果<br>${esc(fmtDate(S.updated))} 更新` : "";
}

async function loadPosts() {
  if (!sb) return;
  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const { data, error } = await sb.from("catches").select("*")
    .gte("caught_at", since).order("caught_at", { ascending: false }).limit(1000);
  if (error) { console.warn(error); return; }
  S.posts = (data || []).map(postItem);
  await mergeExactSpots(S.posts);
  await signPhotos(S.posts.flatMap(p => p.row.photos || []));
}

// 位置からいちばん近い地名（15km以内）
function nearestPlace(pos) {
  if (!pos || !S.places.length) return null;
  let best = null, bd = 1e9;
  S.places.forEach(([name, pref, area, lat, lng]) => {
    const d = Math.hypot((lat - pos[0]) * 111, (lng - pos[1]) * 92);
    if (d < bd) { bd = d; best = { name, pref, area }; }
  });
  return bd <= 15 ? best : null;
}

function postItem(row) {
  const pos = row.lat != null && row.lng != null ? [row.lat, row.lng] : null;
  const near = nearestPlace(pos);
  const pref = PREFS9.includes(row.pref) ? row.pref : (near ? near.pref : "");
  return {
    type: "post", id: row.id, row, src: "みんな",
    date: row.caught_at, pref, area: near && near.pref === pref ? near.area : "", shop: row.nickname,
    title: row.fish, spot: row.spot || "", place: near ? near.name : "",
    fish: fishOf(row.fish).length ? fishOf(row.fish) : [row.fish],
    kind: row.kind || "岸", text: [row.size, row.count, row.memo].filter(Boolean).join(" ・ "),
    pos, mine: S.me && row.user_id === S.me.id,
  };
}

// 自分の投稿は、ぼかす前の位置で見せる
async function mergeExactSpots(items) {
  if (!sb || !S.me) return;
  const mine = items.filter(i => i.mine);
  if (!mine.length) return;
  const { data } = await sb.from("catch_spots").select("*").in("catch_id", mine.map(i => i.id));
  const m = Object.fromEntries((data || []).map(r => [r.catch_id, [r.lat, r.lng]]));
  mine.forEach(i => { if (m[i.id]) { i.pos = m[i.id]; i.exact = true; } });
}

async function signPhotos(paths) {
  const need = [...new Set(paths)].filter(p => !S.photoUrl[p]);
  if (!sb || !need.length) return;
  for (let i = 0; i < need.length; i += 100) {
    const { data } = await sb.storage.from("photos").createSignedUrls(need.slice(i, i + 100), 60 * 60 * 6);
    (data || []).forEach(d => { if (d.signedUrl) S.photoUrl[d.path] = d.signedUrl; });
  }
}

/* ---------- 絞り込み ---------- */
// 選んでいる地域に含まれる県
function regionPrefs(region) {
  if (region === "all") return PREFS9;
  return S.regions[region] || [region];
}
function inRegion(i) {
  const f = S.filter;
  if (f.region === "all") return true;
  const prefs = regionPrefs(f.region);
  if (!i.pref) {  // 釣った場所も店の県も分からないもの（「山陰」の店など）は、店の地域で判断する
    const sp = SHOP_AREA_PREFS[i.shopArea] || [i.shopArea];
    return !f.area && sp.some(p => prefs.includes(p));
  }
  if (!prefs.includes(i.pref)) return false;
  return !f.area || i.area === f.area;
}
function baseFiltered(opt = {}) {
  const f = S.filter;
  const since = Date.now() - f.days * 864e5;
  const q = norm(f.q);
  let items = [];
  if (f.src !== "post") items = items.concat(S.shop);
  if (f.src !== "shop") items = items.concat(S.posts);
  return items.filter(i =>
    new Date(i.date).getTime() >= since && inRegion(i) &&
    (f.kind === "all" || i.kind === f.kind) &&
    (opt.noQuery || !q || norm([i.title, i.text, i.spot, i.shop, i.place, i.area, i.pref, (i.fish || []).join(" ")].join(" ")).includes(q)));
}
function filtered() {
  const f = S.filter;
  return baseFiltered().filter(i => !f.fish || (i.fish || []).includes(f.fish))
    .sort((a, b) => b.date.localeCompare(a.date));
}
function fishCounts(items) {
  const cnt = {};
  items.forEach(i => (i.fish || []).forEach(n => { cnt[n] = (cnt[n] || 0) + 1; }));
  return cnt;
}

function regionLabel() {
  const f = S.filter;
  if (f.region === "all") return "中四国";
  return f.area ? `${f.region}・${f.area}` : (S.regions[f.region] ? f.region + "地方" : f.region + "県");
}

function renderFilters() {
  const f = S.filter;
  const reg = $("#fRegion");
  if (!reg.options.length) {
    reg.innerHTML = `<option value="all">中四国すべて</option>` +
      Object.entries(S.regions).map(([r, ps]) => `<optgroup label="${esc(r)}地方"><option value="${esc(r)}">${esc(r)}すべて</option>` +
        ps.map(p => `<option value="${esc(p)}">${esc(p)}県</option>`).join("") + `</optgroup>`).join("");
  }
  reg.value = f.region;
  const areas = S.areas[f.region] || [];
  $("#fArea").classList.toggle("hidden", !areas.length);
  $("#fArea").innerHTML = `<option value="">${esc(f.region)}県のすべて</option>` + areas.map(a => `<option>${esc(a)}</option>`).join("");
  $("#fArea").value = areas.includes(f.area) ? f.area : "";
  $("#fDays").value = String(f.days);
  $("#fKind").value = f.kind;
  $("#fSrc").value = f.src;
  if ($("#fQ").value !== f.q) $("#fQ").value = f.q;
  // 魚種は、いまの条件で多い順に並べる
  const cnt = fishCounts(baseFiltered());
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  if (f.fish && !cnt[f.fish]) top.unshift([f.fish, 0]);
  $("#fFish").innerHTML = `<button class="chip find" data-goto="fish">🔍 魚種で探す</button>` +
    `<button class="chip" data-v="" aria-pressed="${!f.fish}">すべての魚</button>` +
    top.map(([n, c]) => `<button class="chip" data-v="${esc(n)}" aria-pressed="${f.fish === n}">${esc(n)}<span class="n">${c}</span></button>`).join("");
  renderLinks();
}

// 転載できないサイト（アングラーズ・カンパリ）は、選んでいる県のページへのリンクだけ
function renderLinks() {
  const prefs = regionPrefs(S.filter.region);
  $("#links").innerHTML = `<b>ほかの釣果サイト</b>（規約で転載できないため、リンクのみ）
    <div class="linkgrid">${prefs.map(p => `<span>${esc(p)}</span>
      <a href="https://anglers.jp/prefectures/${ANGLERS_ID[p]}/catches" target="_blank" rel="noopener">アングラーズ</a>
      <a href="https://fishing.ne.jp/fishingpost/area/${KANPARI_SLUG[p]}" target="_blank" rel="noopener">カンパリ</a>`).join("")}</div>
    <p class="note">店の釣果は各店の公開ページから見出しと短い抜粋だけを集めています。写真と全文は元の記事でご覧ください。
    地域は釣った場所（釣り場名・本文の地名）で分けています。同じ地名が複数ある場合と、場所が書かれていない場合は、投稿した店の地域で分けています。</p>`;
}

function setFilter(patch) {
  Object.assign(S.filter, patch);
  store.set("filter", S.filter);
  S.shown = 60;
  renderAll();
}

/* ---------- 一覧 ---------- */
function placeLine(i) {
  if (i.byShop) {
    return `<span class="unknown">📍場所の記載なし（店の地域：${esc(i.pref ? i.pref + (i.area ? "・" + i.area : "") : i.shopArea)}）</span>`;
  }
  if (i.pref) {
    const name = i.spot || i.place || i.area;
    return `📍${esc(name ? name + "（" + i.pref + "）" : i.pref + "県")}`;
  }
  return `<span class="unknown">📍場所不明${i.shopArea ? "（" + esc(i.shopArea) + "の店）" : ""}</span>${i.spot ? " " + esc(i.spot) : ""}`;
}
function cardHtml(i) {
  if (i.type === "shop") {
    return `<a class="card" href="${esc(i.url)}" target="_blank" rel="noopener"><div class="body">
      <div class="meta"><span class="badge b-${esc(i.src)}">${esc(i.src)}</span>${esc(i.shop)}・${esc(fmtDate(i.date, i.dateOnly))}</div>
      <div class="title">${esc(i.title)}</div>
      <div class="meta">${placeLine(i)}</div>
      <div class="text">${esc(i.text)}</div>
      <div>${(i.fish || []).map(n => `<span class="tag fish">${esc(n)}</span>`).join("")}<span class="tag">${kindLabel(i.kind)}</span></div>
    </div></a>`;
  }
  const r = i.row, ph = (r.photos || [])[0];
  return `<a class="card" href="#" data-post="${esc(i.id)}">
    ${ph && S.photoUrl[ph] ? `<img class="thumb" loading="lazy" src="${esc(S.photoUrl[ph])}" alt="">` : ""}
    <div class="body">
      <div class="meta"><span class="badge b-みんな">投稿</span>${esc(r.nickname)}・${esc(fmtDate(r.caught_at))}
        ${r.is_public ? "" : `<span class="private">🔒非公開</span>`}</div>
      <div class="title">${esc(r.fish)}${r.size ? " " + esc(r.size) : ""}${r.count ? " × " + esc(r.count) : ""}</div>
      ${r.spot || i.pref ? `<div class="meta">📍${esc([r.spot, i.pref ? "（" + i.pref + "）" : ""].filter(Boolean).join(""))}</div>` : ""}
      <div>${r.weather ? `<span class="tag">${esc(weatherIcon(r.weather))}${esc(r.weather)}${r.temp != null ? " " + esc(r.temp) + "℃" : ""}</span>` : ""}
        ${r.tide_name ? `<span class="tag">🌊${esc(r.tide_name)}</span>` : ""}<span class="tag">${kindLabel(r.kind)}</span></div>
    </div></a>`;
}
const kindLabel = k => ({ 岸: "堤防・磯", 船: "船", 淡水: "淡水" }[k] || "");
const weatherIcon = w => ({ 晴れ: "☀️", くもり: "☁️", 雨: "🌧️", 雪: "❄️", 霧: "🌫️", 雷雨: "⛈️" }[w] || "");

function renderList() {
  const items = filtered();
  const el = $("#list");
  const head = `<p class="note">${esc(regionLabel())}${S.filter.fish ? "・" + esc(S.filter.fish) : ""}：${items.length}件</p>`;
  if (!items.length) {
    el.innerHTML = head + `<div class="empty">条件に合う釣果がありません。<br>期間を広げるか、魚種を「すべて」にしてください。` +
      `</div>`;
    return;
  }
  el.innerHTML = head + items.slice(0, S.shown).map(cardHtml).join("") +
    (items.length > S.shown ? `<button class="more" id="more">もっと見る（残り${items.length - S.shown}件）</button>` : "");
}

/* ---------- 魚種 ---------- */
function renderFish() {
  if (S.tab !== "fish") return;
  const el = $("#fishView");
  if (S.fishView) return renderFishDetail(el, S.fishView);
  const all = baseFiltered();
  const cnt = fishCounts(all);
  const q = $("#fsQ") ? $("#fsQ").value : "";
  const hits = new Set(searchFish(q).map(f => f.name));
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const groupHtml = GROUPS.map(g => {
    const fs = FISH.filter(f => f.group === g && hits.has(f.name));
    if (!fs.length) return "";
    return `<div class="fgroup"><h3>${esc(g)}</h3><div class="fgrid">${fs.map(f => `
      <button class="fcell ${cnt[f.name] ? "" : "zero"}" data-fish="${esc(f.name)}">
        <b>${esc(f.name)}</b><span>${cnt[f.name] ? cnt[f.name] + "件" : "—"}</span>
        ${(f.alias || []).length ? `<small>${esc(f.alias.slice(0, 4).join("・"))}</small>` : ""}</button>`).join("")}</div></div>`;
  }).join("");
  const keep = document.activeElement && document.activeElement.id === "fsQ";
  el.innerHTML = `
    <input class="search" id="fsQ" type="search" placeholder="魚の名前で探す（ひらがな・別名もOK 例：はまち、がしら）" value="${esc(q)}">
    ${!q && top.length ? `<div class="fgroup"><h3>${esc(regionLabel())}でいま多い魚（${S.filter.days}日）</h3>
      <div class="chips wrap">${top.map(([n, c]) => `<button class="chip" data-fish="${esc(n)}">${esc(n)}<span class="n">${c}</span></button>`).join("")}</div></div>` : ""}
    ${groupHtml || `<div class="empty">「${esc(q)}」に当たる魚が見つかりません</div>`}
    <p class="note">件数は上の地域・期間・釣り方の条件で数えています。</p>`;
  const inp = $("#fsQ");
  inp.oninput = () => { const pos = inp.selectionStart; renderFish(); const n = $("#fsQ"); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* 一部の入力欄は位置指定できない */ } };
  if (keep) inp.focus();
}

function renderFishDetail(el, name) {
  const f = FISH.find(x => x.name === name) || { name, alias: [] };
  const items = baseFiltered().filter(i => (i.fish || []).includes(name)).sort((a, b) => b.date.localeCompare(a.date));
  // 釣れている場所（エリア単位）
  const byArea = {};
  items.forEach(i => {
    const onePref = PREFS9.includes(S.filter.region);  // 県を選んでいるときは県名を省く
    const k = i.pref ? (i.area ? (onePref ? i.area : `${i.pref}・${i.area}`) : `${i.pref}（エリア不明）`) : "場所不明";
    byArea[k] = (byArea[k] || 0) + 1;
  });
  const areas = Object.entries(byArea).sort((a, b) => b[1] - a[1]);
  const maxA = areas.length ? areas[0][1] : 1;
  // 釣り方
  const kinds = { 岸: 0, 船: 0, 淡水: 0 };
  items.forEach(i => { kinds[i.kind] = (kinds[i.kind] || 0) + 1; });
  // 日ごと（最大14日）
  const days = Math.min(S.filter.days, 14), today = new Date(); today.setHours(0, 0, 0, 0);
  const daily = [];
  for (let k = days - 1; k >= 0; k--) {
    const d0 = new Date(today.getTime() - k * 864e5), d1 = new Date(d0.getTime() + 864e5);
    daily.push({ d: d0, n: items.filter(i => { const t = new Date(i.date); return t >= d0 && t < d1; }).length });
  }
  const maxD = Math.max(1, ...daily.map(x => x.n));
  el.innerHTML = `
    <div class="row"><button class="btn" data-fishback>← 戻る</button><span style="flex:1"></span>
      <button class="btn" data-fishlist="${esc(name)}">📋 一覧</button><button class="btn" data-fishmap="${esc(name)}">🗺️ 地図</button></div>
    <h2 class="fishname">${esc(name)}</h2>
    ${(f.alias || []).length ? `<p class="note">別名・含むもの：${esc(f.alias.join("、"))}</p>` : ""}
    <p><b>${esc(regionLabel())}</b>・${S.filter.days}日間で <b style="font-size:20px">${items.length}</b> 件</p>
    ${items.length ? `
    <div class="box"><h3>日ごとの件数</h3>
      <div class="bars">${daily.map(x => `<div class="bar" title="${x.d.getMonth() + 1}/${x.d.getDate()} ${x.n}件">
        <i style="height:${Math.round(x.n / maxD * 100)}%"></i><span>${x.d.getDate()}</span></div>`).join("")}</div></div>
    <div class="box"><h3>釣れている場所</h3>${areas.map(([k, n]) => `
      <div class="hbar"><span class="k">${esc(k)}</span><span class="v"><i style="width:${Math.round(n / maxA * 100)}%"></i></span><span class="n">${n}</span></div>`).join("")}</div>
    <div class="box"><h3>釣り方</h3><div class="row" style="gap:16px">${Object.entries(kinds).filter(x => x[1]).map(([k, n]) => `<span>${esc(kindLabel(k))} <b>${n}</b></span>`).join("")}</div></div>
    <h3>最新の釣果</h3>${items.slice(0, 20).map(cardHtml).join("")}
    ${items.length > 20 ? `<button class="more" data-fishlist="${esc(name)}">残り${items.length - 20}件を一覧で見る</button>` : ""}`
    : `<div class="empty">この条件では釣果がありません。<br>期間を広げるか、地域を変えてみてください。</div>`}`;
}

/* ---------- 地図 ---------- */
let map, layer;
function jitter(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return [((h & 0xff) / 255 - 0.5) * 0.03, (((h >> 8) & 0xff) / 255 - 0.5) * 0.03];
}
const tiles = () => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});
const SRC_COLOR = { かめや: "--kameya", アングル: "--angle", ポイント: "--point", タイム: "--time", パゴス: "--pagos" };
let lastFitKey = "";
function renderMap() {
  if (S.tab !== "map") return;
  if (!map) {
    map = L.map("map", { zoomControl: true }).setView([34.3, 133.0], 7);
    tiles().addTo(map);
    layer = L.layerGroup().addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 0);
  layer.clearLayers();
  const pts = [];
  const css = getComputedStyle(document.documentElement);
  filtered().forEach(i => {
    if (!i.pos) return;
    pts.push(i.pos);
    if (i.type === "shop") {
      const j = jitter(i.url);
      L.circleMarker([i.pos[0] + j[0], i.pos[1] + j[1]], {
        radius: 8, weight: 2, color: "#fff", fillColor: css.getPropertyValue(SRC_COLOR[i.src] || "--accent").trim(), fillOpacity: .9,
      }).bindPopup(`<b>${esc(i.title)}</b><br>${esc(i.src)} ${esc(i.shop)}・${esc(fmtDate(i.date, i.dateOnly))}<br>
        ${(i.fish || []).map(esc).join("・")}<br>📍${esc(i.spot || i.place)}（${esc(i.pref)}・おおよその位置）<br>
        <a href="${esc(i.url)}" target="_blank" rel="noopener">元の記事を見る</a>`).addTo(layer);
    } else {
      const r = i.row, ph = (r.photos || [])[0];
      L.marker(i.pos, { icon: L.divIcon({ className: "pin", html: i.mine ? "📍" : "📌", iconSize: [26, 26], iconAnchor: [13, 24] }) })
        .bindPopup(`${ph && S.photoUrl[ph] ? `<img src="${esc(S.photoUrl[ph])}" alt="">` : ""}
          <b>${esc(r.fish)}${r.size ? " " + esc(r.size) : ""}</b><br>${esc(r.nickname)}・${esc(fmtDate(r.caught_at))}
          ${r.is_public ? "" : " 🔒"}${r.blurred && !i.exact ? "<br>（位置は約1kmぼかし）" : ""}<br>
          <a href="#" data-post="${esc(r.id)}">詳しく見る</a>`).addTo(layer);
    }
  });
  // 地域を変えたら、その範囲に合わせる
  const key = S.filter.region + "|" + S.filter.area;
  if (pts.length && key !== lastFitKey) {
    lastFitKey = key;
    setTimeout(() => map.fitBounds(pts, { padding: [24, 24], maxZoom: 11 }), 50);
  }
}

/* ---------- 詳細 ---------- */
function openSheet(html) {
  $("#sheetInner").innerHTML = html;
  $("#sheet").classList.remove("hidden");
}
function closeSheet() { $("#sheet").classList.add("hidden"); }

function showPost(id) {
  const i = S.posts.find(p => p.id === id) || myPosts.find(p => p.id === id);
  if (!i) return;
  const r = i.row;
  const rows = [
    ["釣った人", r.nickname], ["日時", new Date(r.caught_at).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" })],
    ["場所", [i.pref, i.area, r.spot].filter(Boolean).join(" ")], ["魚種", r.fish], ["サイズ", r.size], ["数", r.count],
    ["釣り方", kindLabel(r.kind)], ["仕掛け・エサ", r.tackle],
    ["天気", [r.weather, r.temp != null ? r.temp + "℃" : "", r.wind].filter(Boolean).join("・")],
    ["潮", [r.tide_name, r.tide_info].filter(Boolean).join("・")], ["メモ", r.memo],
    ["公開", r.is_public ? "公開" + (r.blurred ? "（位置は約1kmぼかし）" : "") : "🔒非公開（自分だけ）"],
  ].filter(x => x[1]);
  openSheet(`
    <div class="row"><b style="flex:1;font-size:18px">${esc(r.fish)}</b><button class="btn" data-close>閉じる</button></div>
    ${(r.photos || []).length ? `<div class="gallery">${r.photos.map(p => S.photoUrl[p] ? `<img src="${esc(S.photoUrl[p])}" alt="">` : "").join("")}</div>` : ""}
    <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <div class="btns">
      ${i.pos ? `<button class="btn" data-fly="${esc(r.id)}">🗺️ 地図で見る</button>
        <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${i.pos[0]},${i.pos[1]}">Googleマップ</a>` : ""}
      ${i.mine ? `<button class="btn" data-edit="${esc(r.id)}">✏️ 直す</button><button class="btn danger" data-del="${esc(r.id)}">削除</button>` : ""}
    </div>`);
}

/* ---------- タブ ---------- */
function setTab(tab) {
  S.tab = tab;
  $$("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("#filters").classList.toggle("hidden", !(tab === "list" || tab === "map" || tab === "fish"));
  $("#fFish").classList.toggle("hidden", tab === "fish");
  $("#fQRow").classList.toggle("hidden", tab === "fish");
  $("#listView").classList.toggle("hidden", tab !== "list");
  $("#mapView").classList.toggle("hidden", tab !== "map");
  $("#fishView").classList.toggle("hidden", tab !== "fish");
  $("#postView").classList.toggle("hidden", tab !== "post");
  $("#myView").classList.toggle("hidden", tab !== "my");
  if (tab === "map") renderMap();
  if (tab === "fish") renderFish();
  if (tab === "post") renderPostView();
  if (tab === "my") renderMy();
  window.scrollTo(0, 0);
}
function renderAll() {
  renderFilters();
  renderList();
  renderMap();
  renderFish();
}

/* ---------- 潮と天気 ---------- */
// 月齢から潮回り（大潮・中潮…）を出す。日本の釣り向け潮汐表と同じ、旧暦の日付による区分。
function moonAge(d) {
  const syn = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14);
  let a = ((d.getTime() - ref) / 864e5) % syn;
  return a < 0 ? a + syn : a;
}
function tideName(dateStr) {
  const day = Math.floor(moonAge(new Date(dateStr + "T12:00:00+09:00"))) + 1;
  if (day <= 3 || day >= 29 || (day >= 14 && day <= 17)) return "大潮";
  if ((day >= 4 && day <= 6) || day === 12 || day === 13 || (day >= 18 && day <= 21) || day === 27 || day === 28) return "中潮";
  if (day === 10 || day === 25) return "長潮";
  if (day === 11 || day === 26) return "若潮";
  return "小潮";
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00+09:00");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// 潮位（Open-Meteo の海洋モデル、1時間ごと）から満潮・干潮の時刻を求める
async function tideAt(lat, lng, local) {
  const date = local.slice(0, 10);
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&hourly=sea_level_height_msl&timezone=Asia%2FTokyo&start_date=${addDays(date, -1)}&end_date=${addDays(date, 1)}`;
  const d = await (await fetch(url)).json();
  const t = d.hourly?.time || [], h = d.hourly?.sea_level_height_msl || [];
  if (!h.length || h.some(v => v == null)) return null;
  const ext = [];
  for (let k = 1; k < h.length - 1; k++) {
    const hi = h[k] >= h[k - 1] && h[k] > h[k + 1], lo = h[k] <= h[k - 1] && h[k] < h[k + 1];
    if (!hi && !lo) continue;
    const den = h[k - 1] - 2 * h[k] + h[k + 1];
    const off = den ? 0.5 * (h[k - 1] - h[k + 1]) / den : 0;
    ext.push({ hi, at: new Date(new Date(t[k] + ":00+09:00").getTime() + off * 36e5), h: h[k] - 0.25 * (h[k - 1] - h[k + 1]) * off });
  }
  const now = new Date(local + ":00+09:00");
  const prev = ext.filter(e => e.at <= now).pop(), next = ext.find(e => e.at > now);
  let state = "";
  if (prev && next) {
    const k = Math.round((now - prev.at) / (next.at - prev.at) * 10);
    const up = !prev.hi;
    state = k <= 0 ? (up ? "干潮" : "満潮") + "の潮止まり" : k >= 10 ? (up ? "満潮" : "干潮") + "の潮止まり" : (up ? "上げ" : "下げ") + k + "分";
  }
  const hm = e => `${pad(e.at.getHours())}:${pad(e.at.getMinutes())}`;
  const today = ext.filter(e => localInput(e.at).slice(0, 10) === date);
  const highs = today.filter(e => e.hi).map(hm), lows = today.filter(e => !e.hi).map(hm);
  const range = today.length ? Math.max(...today.map(e => e.h)) - Math.min(...today.map(e => e.h)) : 0;
  return [state, highs.length ? "満潮 " + highs.join("・") : "", lows.length ? "干潮 " + lows.join("・") : "",
    range ? `干満差 約${range.toFixed(1)}m` : ""].filter(Boolean).join("／");
}
const WMO = c => c <= 1 ? "晴れ" : c <= 3 ? "くもり" : c <= 48 ? "霧" : c <= 67 || (c >= 80 && c <= 82) ? "雨" : c <= 77 || c === 85 || c === 86 ? "雪" : "雷雨";
const DIR16 = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];
async function weatherAt(lat, lng, local) {
  const date = local.slice(0, 10);
  const age = (Date.now() - new Date(date + "T00:00:00+09:00")) / 864e5;
  const host = age > 80 ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  const url = `${host}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&hourly=weather_code,temperature_2m,wind_speed_10m,wind_direction_10m` +
    `&wind_speed_unit=ms&timezone=Asia%2FTokyo&start_date=${date}&end_date=${date}`;
  const d = await (await fetch(url)).json();
  const k = Number(local.slice(11, 13));
  const hr = d.hourly;
  if (!hr || hr.weather_code?.[k] == null) return null;
  return {
    weather: WMO(hr.weather_code[k]), temp: Math.round(hr.temperature_2m[k] * 10) / 10,
    wind: `${DIR16[Math.round(hr.wind_direction_10m[k] / 22.5) % 16]} ${Math.round(hr.wind_speed_10m[k])}m/s`,
  };
}

/* ---------- 写真 ---------- */
// JPEG の EXIF から撮影日時と位置を読む（読めなければ何もしない）
async function readExif(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return {};
    let o = 2;
    while (o < v.byteLength - 10) {
      const m = v.getUint16(o), len = v.getUint16(o + 2);
      if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) return parseTiff(v, o + 10);
      if ((m & 0xFF00) !== 0xFF00) break;
      o += 2 + len;
    }
  } catch (e) { /* 読めない写真はそのまま */ }
  return {};
}
function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
  const ifd = p => { const n = u16(p), e = {}; for (let i = 0; i < n; i++) { const q = p + 2 + i * 12; e[u16(q)] = { count: u32(q + 4), val: q + 8 }; } return e; };
  const rat = p => u32(p) / u32(p + 4);
  const at = ent => t + u32(ent.val);
  const ascii = ent => { const p = ent.count > 4 ? at(ent) : ent.val; let s = ""; for (let i = 0; i < ent.count - 1; i++) s += String.fromCharCode(v.getUint8(p + i)); return s; };
  const res = {};
  const ifd0 = ifd(t + u32(t + 4));
  if (ifd0[0x8769]) {
    const ex = ifd(at(ifd0[0x8769]));
    const m = ex[0x9003] && ascii(ex[0x9003]).match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/);
    if (m) res.date = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  }
  if (ifd0[0x8825]) {
    const g = ifd(at(ifd0[0x8825]));
    if (g[2] && g[4]) {
      const la = at(g[2]), lo = at(g[4]);
      let lat = rat(la) + rat(la + 8) / 60 + rat(la + 16) / 3600, lng = rat(lo) + rat(lo + 8) / 60 + rat(lo + 16) / 3600;
      if (g[1] && v.getUint8(g[1].val) === 83) lat = -lat;
      if (g[3] && v.getUint8(g[3].val) === 87) lng = -lng;
      if (isFinite(lat) && isFinite(lng) && (lat || lng)) res.pos = [lat, lng];
    }
  }
  return res;
}
// 長い辺を1600pxに縮め、JPEGで作り直す（位置情報などの埋め込みデータはここで消える）
async function shrink(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e) {
    src = await new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = ng; im.src = URL.createObjectURL(file); });
  }
  const w = src.width, h = src.height, s = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return new Promise(ok => c.toBlob(ok, "image/jpeg", 0.82));
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- 投稿フォーム ---------- */
let pickMap, pickMarker;
const P = { editing: null, pos: null, photos: [], keep: [], drop: [], dirty: {}, busy: false };

function needSetupHtml() {
  return `<div class="box"><b>投稿機能はまだ準備中です</b><p class="note">Supabase の設定（SETUP.md の手順）が済むと、ここから自分の釣果を投稿できます。</p></div>`;
}
function needLoginHtml() {
  return `<div class="box"><b>投稿するにはログインしてください</b><p class="note">「マイ釣果」タブから登録・ログインできます。</p>
    <button class="btn primary" data-goto="my">ログインへ</button></div>`;
}

function renderPostView() {
  const el = $("#postView");
  if (!sb) { el.innerHTML = needSetupHtml(); return; }
  if (!S.me) { el.innerHTML = needLoginHtml(); return; }
  if (el.dataset.ready === "1") { setTimeout(() => pickMap && pickMap.invalidateSize(), 0); return; }
  el.dataset.ready = "1";
  el.innerHTML = `
    <h2 style="margin:4px 0 0;font-size:18px" id="pfTitle">釣果を投稿</h2>
    <label for="pfName">ユーザー名</label>
    <input type="text" id="pfName" maxlength="30" autocomplete="nickname">
    <label for="pfDate">日時</label>
    <input type="datetime-local" id="pfDate">
    <label>場所 <span class="note" style="font-weight:400">（地図をタップしてピンを置く）</span></label>
    <div id="pickMap"></div>
    <div class="btns"><button class="btn" type="button" id="pfHere">📍 現在地</button>
      <button class="btn" type="button" id="pfClearPos">ピンを外す</button></div>
    <div class="auto" id="pfPosNote"></div>
    <div class="grid2">
      <div><label for="pfPref">県</label><select id="pfPref">${PREFS9.map(p => `<option>${p}</option>`).join("")}<option>その他</option></select></div>
      <div><label for="pfSpot">釣り場名</label><input type="text" id="pfSpot" maxlength="60" placeholder="例：倉橋島 鹿老渡"></div>
    </div>
    <label for="pfFish">魚種</label>
    <input type="text" id="pfFish" maxlength="80" list="fishList" placeholder="例：アオリイカ、アジ">
    <datalist id="fishList">${FISH.map(([n]) => `<option value="${esc(n)}">`).join("")}</datalist>
    <div class="grid3">
      <div><label for="pfSize">サイズ</label><input type="text" id="pfSize" maxlength="40" placeholder="35cm"></div>
      <div><label for="pfCount">数</label><input type="text" id="pfCount" maxlength="40" placeholder="3匹"></div>
      <div><label for="pfKind">釣り方</label><select id="pfKind"><option value="岸">堤防・磯</option><option value="船">船</option><option value="淡水">淡水</option></select></div>
    </div>
    <label for="pfTackle">仕掛け・エサ</label>
    <input type="text" id="pfTackle" maxlength="200" placeholder="例：エギ3.5号 / サビキ">

    <label>天気 <span class="note" style="font-weight:400">（日時と場所から自動で入ります。直してもOK）</span></label>
    <div class="grid3">
      <select id="pfWeather"><option value="">—</option><option>晴れ</option><option>くもり</option><option>雨</option><option>雪</option><option>霧</option><option>雷雨</option></select>
      <input type="number" id="pfTemp" step="0.1" placeholder="気温℃" inputmode="decimal">
      <input type="text" id="pfWind" maxlength="40" placeholder="風 北西 3m/s">
    </div>
    <label>潮 <span class="note" style="font-weight:400">（日時から自動判定）</span></label>
    <select id="pfTideName"><option value="">—</option><option>大潮</option><option>中潮</option><option>小潮</option><option>長潮</option><option>若潮</option></select>
    <textarea id="pfTideInfo" maxlength="200" rows="2" style="min-height:64px;margin-top:8px" placeholder="上げ7分／満潮 11:12・23:40／干潮 05:10"></textarea>
    <div class="btns"><button class="btn" type="button" id="pfAuto">🔄 天気と潮を取り直す</button></div>
    <div class="auto" id="pfAutoNote"></div>

    <label>写真（4枚まで）</label>
    <input type="file" id="pfFiles" accept="image/*" multiple class="hidden">
    <button class="btn" type="button" id="pfAddPhoto">📷 写真を選ぶ</button>
    <div class="photos" id="pfPhotos"></div>
    <div class="auto">写真は縮小し、埋め込まれた位置情報を消してから保存します。</div>

    <label for="pfMemo">メモ</label>
    <textarea id="pfMemo" maxlength="1000" placeholder="状況・ヒットパターンなど"></textarea>

    <label class="toggle"><input type="checkbox" id="pfPublic"><span class="t">みんなに公開する<small>オフなら自分だけが見られます</small></span></label>
    <label class="toggle" id="pfBlurRow"><input type="checkbox" id="pfBlur" checked><span class="t">位置を約1kmぼかす<small>ほかの人には正確な場所を見せません（自分には正確に表示）</small></span></label>

    <div id="pfMsg"></div>
    <button class="btn primary wide" type="button" id="pfSubmit">投稿する</button>
    <button class="btn wide hidden" type="button" id="pfCancel">直すのをやめる</button>`;

  pickMap = L.map("pickMap").setView(store.get("lastPos", [34.2, 132.45]), store.get("lastPos") ? 12 : 9);
  tiles().addTo(pickMap);
  pickMap.on("click", e => setPos([e.latlng.lat, e.latlng.lng], "地図で指定"));

  $("#pfHere").onclick = () => {
    if (!navigator.geolocation) return note("#pfPosNote", "この端末では現在地を使えません");
    note("#pfPosNote", "現在地を調べています…");
    navigator.geolocation.getCurrentPosition(
      p => { setPos([p.coords.latitude, p.coords.longitude], `現在地（誤差 約${Math.round(p.coords.accuracy)}m）`); pickMap.setView(P.pos, 14); },
      () => note("#pfPosNote", "現在地を取れませんでした。地図をタップして指定してください"), { enableHighAccuracy: true, timeout: 15000 });
  };
  $("#pfClearPos").onclick = () => setPos(null, "");
  $("#pfAddPhoto").onclick = () => $("#pfFiles").click();
  $("#pfFiles").onchange = e => addPhotos([...e.target.files]).then(() => { e.target.value = ""; });
  $("#pfAuto").onclick = () => { P.dirty = {}; autoFill(true); };
  $("#pfSubmit").onclick = submitPost;
  $("#pfCancel").onclick = () => resetForm();
  $("#pfPublic").onchange = () => $("#pfBlurRow").classList.toggle("hidden", !$("#pfPublic").checked);
  $("#pfDate").onchange = () => { P.dirty.date = true; autoFill(); };
  ["pfWeather", "pfTemp", "pfWind"].forEach(id => { $("#" + id).oninput = () => { P.dirty.weather = true; }; });
  ["pfTideName", "pfTideInfo"].forEach(id => { $("#" + id).oninput = () => { P.dirty.tide = true; }; });
  ["pfSpot"].forEach(id => { $("#" + id).oninput = () => { P.dirty.spot = true; }; });
  $("#pfPref").onchange = () => { P.dirty.pref = true; };
  resetForm();
}
function note(sel, s) { const el = $(sel); if (el) el.textContent = s; }

function setPos(pos, how) {
  P.pos = pos;
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  if (pos) {
    pickMarker = L.marker(pos, { draggable: true }).addTo(pickMap);
    pickMarker.on("dragend", () => { const ll = pickMarker.getLatLng(); P.pos = [ll.lat, ll.lng]; guessPlace(); autoFill(); });
    note("#pfPosNote", `${how}：${pos[0].toFixed(5)}, ${pos[1].toFixed(5)}`);
    guessPlace();
    autoFill();
  } else note("#pfPosNote", "");
}
// 近くの地名から県と釣り場名の候補を入れる
function guessPlace() {
  const best = nearestPlace(P.pos);
  if (!best) return;
  if (!P.dirty.pref) $("#pfPref").value = best.pref;
  if (!P.dirty.spot && !$("#pfSpot").value) $("#pfSpot").placeholder = `例：${best.name}付近`;
}

let autoTimer, autoSeq = 0;
function autoFill(force) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    const local = $("#pfDate").value;
    if (!local) return;
    const seq = ++autoSeq;
    if (force || !P.dirty.tide) $("#pfTideName").value = tideName(local.slice(0, 10));
    if (!P.pos) { note("#pfAutoNote", "場所を指定すると、天気と満潮・干潮の時刻も入ります"); return; }
    note("#pfAutoNote", "天気と潮を調べています…");
    const [lat, lng] = P.pos;
    const [w, t] = await Promise.all([weatherAt(lat, lng, local).catch(() => null), tideAt(lat, lng, local).catch(() => null)]);
    if (seq !== autoSeq) return;
    if (w && (force || !P.dirty.weather)) { $("#pfWeather").value = w.weather; $("#pfTemp").value = w.temp; $("#pfWind").value = w.wind; }
    if (force || !P.dirty.tide) $("#pfTideInfo").value = $("#pfKind").value === "淡水" ? "" : (t || "");
    note("#pfAutoNote", [w ? "天気: Open-Meteo" : "天気は取得できませんでした",
      $("#pfKind").value === "淡水" ? "" : t ? "潮位: Open-Meteo 海洋モデル（目安）" : "この場所の潮位データはありません"].filter(Boolean).join("　"));
  }, 500);
}

async function addPhotos(files) {
  for (const f of files) {
    if (P.photos.length + P.keep.length >= 4) { alert("写真は4枚までです"); break; }
    const ex = await readExif(f);
    if (ex.pos && !P.pos) { setPos(ex.pos, "写真の位置情報"); pickMap.setView(ex.pos, 14); }
    if (ex.date && !P.dirty.date && !P.editing) { $("#pfDate").value = ex.date; P.dirty.date = true; autoFill(); }
    try {
      const blob = await shrink(f);
      P.photos.push({ blob, url: URL.createObjectURL(blob) });
    } catch (e) { alert("この写真は読み込めませんでした（" + f.name + "）"); }
  }
  renderPhotos();
}
function renderPhotos() {
  $("#pfPhotos").innerHTML =
    P.keep.map((p, k) => `<div class="ph"><img src="${esc(S.photoUrl[p] || "")}" alt=""><button type="button" data-keep="${k}" aria-label="外す">×</button></div>`).join("") +
    P.photos.map((p, k) => `<div class="ph"><img src="${esc(p.url)}" alt=""><button type="button" data-new="${k}" aria-label="外す">×</button></div>`).join("");
  $$("#pfPhotos [data-keep]").forEach(b => b.onclick = () => { P.drop.push(P.keep.splice(+b.dataset.keep, 1)[0]); renderPhotos(); });
  $$("#pfPhotos [data-new]").forEach(b => b.onclick = () => { P.photos.splice(+b.dataset.new, 1); renderPhotos(); });
}

function resetForm(row) {
  P.editing = row ? row.id : null;
  P.photos = []; P.keep = row ? [...(row.photos || [])] : []; P.drop = []; P.dirty = row ? { date: true, weather: true, tide: true, spot: true, pref: true } : {};
  $("#pfTitle").textContent = row ? "投稿を直す" : "釣果を投稿";
  $("#pfSubmit").textContent = row ? "保存する" : "投稿する";
  $("#pfCancel").classList.toggle("hidden", !row);
  $("#pfName").value = row ? row.nickname : S.nickname;
  $("#pfDate").value = localInput(row ? new Date(row.caught_at) : new Date());
  $("#pfPref").value = row?.pref || store.get("lastPref", "広島");
  $("#pfSpot").value = row?.spot || "";
  $("#pfFish").value = row?.fish || "";
  $("#pfSize").value = row?.size || "";
  $("#pfCount").value = row?.count || "";
  $("#pfKind").value = row?.kind || "岸";
  $("#pfTackle").value = row?.tackle || "";
  $("#pfWeather").value = row?.weather || "";
  $("#pfTemp").value = row?.temp ?? "";
  $("#pfWind").value = row?.wind || "";
  $("#pfTideName").value = row?.tide_name || "";
  $("#pfTideInfo").value = row?.tide_info || "";
  $("#pfMemo").value = row?.memo || "";
  $("#pfPublic").checked = row ? row.is_public : store.get("lastPublic", false);
  $("#pfBlur").checked = row ? row.blurred : true;
  $("#pfBlurRow").classList.toggle("hidden", !$("#pfPublic").checked);
  $("#pfMsg").innerHTML = "";
  const item = row && (S.posts.find(p => p.id === row.id) || myPosts.find(p => p.id === row.id));
  setPosQuiet(item?.pos || null);
  renderPhotos();
  if (!row) autoFill();
}
function setPosQuiet(pos) {
  P.pos = pos;
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  if (pos) {
    pickMarker = L.marker(pos, { draggable: true }).addTo(pickMap);
    pickMarker.on("dragend", () => { const ll = pickMarker.getLatLng(); P.pos = [ll.lat, ll.lng]; });
    pickMap.setView(pos, 13);
  }
  note("#pfPosNote", pos ? `${pos[0].toFixed(5)}, ${pos[1].toFixed(5)}` : "");
}

function blur(v) { return Math.round(v * 100) / 100; }  // 0.01度 ≒ 1km

async function submitPost() {
  if (P.busy) return;
  const msg = (s, err) => { $("#pfMsg").innerHTML = `<div class="msg ${err ? "err" : ""}">${esc(s)}</div>`; };
  const nickname = $("#pfName").value.trim(), fish = $("#pfFish").value.trim(), local = $("#pfDate").value;
  if (!nickname) return msg("ユーザー名を入れてください", true);
  if (!local) return msg("日時を入れてください", true);
  if (!fish) return msg("魚種を入れてください", true);
  P.busy = true;
  $("#pfSubmit").disabled = true;
  msg("保存しています…");
  try {
    const uid = S.me.id;
    const uploaded = [];
    for (const p of P.photos) {
      const path = `${uid}/${uuid()}.jpg`;
      const { error } = await sb.storage.from("photos").upload(path, p.blob, { contentType: "image/jpeg" });
      if (error) throw error;
      uploaded.push(path);
    }
    const isPublic = $("#pfPublic").checked, blurred = isPublic && $("#pfBlur").checked;
    const temp = $("#pfTemp").value === "" ? null : Number($("#pfTemp").value);
    const row = {
      nickname, caught_at: new Date(local).toISOString(), pref: $("#pfPref").value, spot: $("#pfSpot").value.trim() || null,
      fish, size: $("#pfSize").value.trim() || null, count: $("#pfCount").value.trim() || null, kind: $("#pfKind").value,
      tackle: $("#pfTackle").value.trim() || null, memo: $("#pfMemo").value.trim() || null,
      weather: $("#pfWeather").value || null, temp: isFinite(temp) ? temp : null, wind: $("#pfWind").value.trim() || null,
      tide_name: $("#pfTideName").value || null, tide_info: $("#pfTideInfo").value.trim() || null,
      lat: P.pos ? (blurred ? blur(P.pos[0]) : P.pos[0]) : null, lng: P.pos ? (blurred ? blur(P.pos[1]) : P.pos[1]) : null,
      blurred, is_public: isPublic, photos: P.keep.concat(uploaded), updated_at: new Date().toISOString(),
    };
    let id = P.editing;
    if (id) {
      const { error } = await sb.from("catches").update(row).eq("id", id);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from("catches").insert(row).select("id").single();
      if (error) throw error;
      id = data.id;
    }
    if (P.pos) await sb.from("catch_spots").upsert({ catch_id: id, lat: P.pos[0], lng: P.pos[1] });
    else await sb.from("catch_spots").delete().eq("catch_id", id);
    if (P.drop.length) await sb.storage.from("photos").remove(P.drop);
    S.nickname = nickname; store.set("nickname", nickname);
    store.set("lastPref", row.pref); store.set("lastPublic", isPublic);
    if (P.pos) store.set("lastPos", P.pos);
    const wasEdit = !!P.editing;
    await refreshPosts();
    resetForm();
    msg(wasEdit ? "保存しました" : "投稿しました！一覧に出ています");
  } catch (e) {
    console.error(e);
    msg("保存できませんでした：" + (e.message || e), true);
  } finally {
    P.busy = false;
    $("#pfSubmit").disabled = false;
  }
}

/* ---------- マイ釣果 ---------- */
let myPosts = [];
async function renderMy() {
  const el = $("#myView");
  if (!sb) { el.innerHTML = needSetupHtml(); return; }
  if (!S.me) {
    el.innerHTML = `<div class="box form">
      <b>ログイン / 新規登録</b>
      <label for="auEmail">メールアドレス</label><input type="email" id="auEmail" autocomplete="email">
      <label for="auPass">パスワード（6文字以上）</label><input type="password" id="auPass" autocomplete="current-password">
      <label for="auName">ユーザー名（新規登録のとき）</label><input type="text" id="auName" maxlength="30" value="${esc(S.nickname)}">
      <div id="auMsg"></div>
      <div class="btns"><button class="btn primary" id="auIn">ログイン</button><button class="btn" id="auUp">新規登録</button></div>
    </div>`;
    const m = (s, err) => { $("#auMsg").innerHTML = `<div class="msg ${err ? "err" : ""}">${esc(s)}</div>`; };
    $("#auIn").onclick = async () => {
      const { error } = await sb.auth.signInWithPassword({ email: $("#auEmail").value.trim(), password: $("#auPass").value });
      if (error) m("ログインできませんでした：" + error.message, true);
    };
    $("#auUp").onclick = async () => {
      const name = $("#auName").value.trim();
      if (!name) return m("ユーザー名を入れてください", true);
      const { data, error } = await sb.auth.signUp({ email: $("#auEmail").value.trim(), password: $("#auPass").value, options: { data: { nickname: name } } });
      if (error) return m("登録できませんでした：" + error.message, true);
      S.nickname = name; store.set("nickname", name);
      if (!data.session) m("確認メールを送りました。メールのリンクを開いてからログインしてください。");
    };
    return;
  }
  el.innerHTML = `<div class="box"><div class="row"><div style="flex:1"><b>${esc(S.nickname || "(名前なし)")}</b><div class="note">${esc(S.me.email || "")}</div></div>
      <button class="btn" id="myOut">ログアウト</button></div></div>
    <div id="myList"><p class="note">読み込み中…</p></div>`;
  $("#myOut").onclick = () => sb.auth.signOut();
  const { data, error } = await sb.from("catches").select("*").eq("user_id", S.me.id).order("caught_at", { ascending: false }).limit(500);
  if (error) { $("#myList").innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  myPosts = (data || []).map(postItem);
  await mergeExactSpots(myPosts);
  await signPhotos(myPosts.flatMap(p => p.row.photos || []));
  if (!myPosts.length) { $("#myList").innerHTML = `<div class="empty">まだ投稿がありません。<br>「投稿」タブから記録できます。</div>`; return; }
  const n = myPosts.length, pub = myPosts.filter(p => p.row.is_public).length;
  $("#myList").innerHTML = `<p class="note">${n}件（公開 ${pub}・非公開 ${n - pub}）</p>` + myPosts.map(i => `
    <div>${cardHtml(i)}
      <div class="btns" style="margin:-4px 0 14px">
        <label class="toggle" style="margin:0;padding:6px 10px;flex:1"><input type="checkbox" data-pub="${esc(i.id)}" ${i.row.is_public ? "checked" : ""}><span class="t">公開</span></label>
        <button class="btn" data-edit="${esc(i.id)}">✏️ 直す</button><button class="btn danger" data-del="${esc(i.id)}">削除</button>
      </div></div>`).join("");
  $$("#myList [data-pub]").forEach(cb => cb.onchange = async () => {
    const { error } = await sb.from("catches").update({ is_public: cb.checked }).eq("id", cb.dataset.pub);
    if (error) { alert("切り替えできませんでした：" + error.message); cb.checked = !cb.checked; return; }
    await refreshPosts();
  });
}

function editPost(id) {
  const i = S.posts.find(p => p.id === id) || myPosts.find(p => p.id === id);
  if (!i) return;
  closeSheet();
  setTab("post");
  resetForm(i.row);
}
async function deletePost(id) {
  const i = S.posts.find(p => p.id === id) || myPosts.find(p => p.id === id);
  if (!i || !confirm(`「${i.row.fish}」の投稿を削除します。写真も消え、元に戻せません。よろしいですか？`)) return;
  const { error } = await sb.from("catches").delete().eq("id", id);
  if (error) return alert("削除できませんでした：" + error.message);
  if ((i.row.photos || []).length) await sb.storage.from("photos").remove(i.row.photos);
  closeSheet();
  await refreshPosts();
}
async function refreshPosts() {
  await loadPosts();
  renderAll();
  if (S.tab === "my") renderMy();
}

/* ---------- イベント ---------- */
document.addEventListener("click", e => {
  const t = e.target.closest("[data-post],[data-close],[data-edit],[data-del],[data-fly],[data-goto],[data-fish],[data-fishback],[data-fishlist],[data-fishmap],#more,#fFish .chip,nav.tabs button");
  if (!t) { if (e.target.id === "sheet") closeSheet(); return; }
  if (t.matches("nav.tabs button")) { if (t.dataset.tab === "fish") S.fishView = ""; return setTab(t.dataset.tab); }
  if (t.dataset.goto) { if (t.dataset.goto === "fish") S.fishView = ""; return setTab(t.dataset.goto); }
  if (t.matches("#fFish .chip")) return setFilter({ fish: t.dataset.v });
  if (t.dataset.fish) { S.fishView = t.dataset.fish; renderFish(); return window.scrollTo(0, 0); }
  if (t.hasAttribute("data-fishback")) { S.fishView = ""; return renderFish(); }
  if (t.dataset.fishlist) { setFilter({ fish: t.dataset.fishlist, q: "" }); return setTab("list"); }
  if (t.dataset.fishmap) { setFilter({ fish: t.dataset.fishmap, q: "" }); return setTab("map"); }
  if (t.id === "more") { S.shown += 60; return renderList(); }
  e.preventDefault();
  if (t.dataset.post) return showPost(t.dataset.post);
  if (t.hasAttribute("data-close")) return closeSheet();
  if (t.dataset.edit) return editPost(t.dataset.edit);
  if (t.dataset.del) return deletePost(t.dataset.del);
  if (t.dataset.fly) {
    const i = S.posts.find(p => p.id === t.dataset.fly) || myPosts.find(p => p.id === t.dataset.fly);
    closeSheet(); setTab("map");
    if (i?.pos) map.setView(i.pos, 13);
  }
});
$("#fRegion").onchange = e => setFilter({ region: e.target.value, area: "" });
$("#fArea").onchange = e => setFilter({ area: e.target.value });
$("#fDays").onchange = e => setFilter({ days: Number(e.target.value) });
$("#fKind").onchange = e => setFilter({ kind: e.target.value });
$("#fSrc").onchange = e => setFilter({ src: e.target.value });
let qTimer;
$("#fQ").oninput = e => { clearTimeout(qTimer); qTimer = setTimeout(() => setFilter({ q: e.target.value }), 250); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

/* ---------- 起動 ---------- */
(async function start() {
  if (sb) {
    const { data } = await sb.auth.getSession();
    S.me = data.session?.user || null;
    if (S.me?.user_metadata?.nickname && !S.nickname) { S.nickname = S.me.user_metadata.nickname; store.set("nickname", S.nickname); }
    sb.auth.onAuthStateChange((_ev, session) => {
      const was = S.me?.id;
      S.me = session?.user || null;
      if (S.me?.user_metadata?.nickname && !S.nickname) { S.nickname = S.me.user_metadata.nickname; store.set("nickname", S.nickname); }
      if (was !== S.me?.id) {
        $("#postView").dataset.ready = "";
        setTimeout(async () => { await refreshPosts(); if (S.tab === "post") renderPostView(); }, 0);
      }
    });
  }
  await Promise.all([loadFish(), loadShop()]);  // 投稿の魚種・地名の判定に使うので先に読む
  await loadPosts();
  renderAll();
})();
