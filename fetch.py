"""釣具店の釣果を集めて data/choka.json にまとめる。

GitHub Actions から2時間おきに動かす。標準ライブラリだけで動く。
相手サイトに負担をかけないよう、1回の実行で読むのは十数ページまで、
1リクエストごとに少し待つ。写真と本文は保存せず、短い抜粋とリンクだけ持つ。
"""
import html
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

JST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0 (compatible; choka-matome/1.0; personal use)"
KEEP_DAYS = 45
EXCERPT_LEN = 100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "choka.json")

NS = {
    "dc": "http://purl.org/dc/elements/1.1/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}

# かめやの店名→県。カテゴリAPIが読めなかったときの控え。
KAMEYA_SHOPS = {
    "広島": ["五日市店", "サファ福山西店", "三次店", "八木店", "呉店", "商工センター店", "東広島店", "福山店", "総本店"],
    "山口": ["下松店", "大島店", "岩国通津店", "防府店"],
}

# 表示名 → 本文中の言い方（正規表現）
FISH = [
    ("アオリイカ", r"アオリ|秋イカ|新子イカ"),
    ("イカ(その他)", r"ケンサキ|ヒイカ|コウイカ|モンゴウ|スルメイカ|ヤリイカ|ジンドウ"),
    ("タコ", r"タコ|蛸|イイダコ"),
    ("アジ", r"アジ|鯵"),
    ("サバ", r"サバ|鯖"),
    ("イワシ", r"イワシ|鰯"),
    ("サヨリ", r"サヨリ|さより"),
    ("キス", r"キス|鱚"),
    ("カワハギ", r"カワハギ|ハゲ釣"),
    ("ハゼ", r"ハゼ"),
    ("メバル", r"メバル|メバリング"),
    ("カサゴ", r"カサゴ|ガシラ"),
    ("ハタ類", r"キジハタ|アコウ|オオモンハタ|アカハタ|(?<![ヒ])ハタ(?!ハタ)"),
    ("チヌ", r"チヌ|クロダイ|キビレ|チニング"),
    ("グレ", r"グレ|メジナ|クロ(?![ダソムマ])"),
    ("マダイ", r"マダイ|真鯛|タイラバ|鯛ラバ"),
    ("イシダイ", r"イシダイ|サンバソウ|イシガキダイ"),
    ("タチウオ", r"タチウオ|太刀魚|タチ魚"),
    ("サワラ", r"サワラ|サゴシ|鰆"),
    ("ブリ類", r"ブリ(?!ーフ)|ハマチ|ヤズ|ツバス|メジロ|青物"),
    ("ヒラマサ", r"ヒラマサ"),
    ("カンパチ", r"カンパチ|ネリゴ"),
    ("シーバス", r"シーバス|スズキ|セイゴ|フッコ"),
    ("ヒラメ", r"ヒラメ"),
    ("マゴチ", r"コチ"),
    ("カレイ", r"カレイ"),
    ("アナゴ", r"アナゴ|穴子"),
    ("イサキ", r"イサキ"),
    ("アマダイ", r"アマダイ"),
    ("アユ", r"鮎|アユ"),
    ("ブラックバス", r"ブラックバス|(?<!シー)バス(?!ケット|タオル|停)"),
    ("トラウト", r"トラウト|ニジマス|ヤマメ|アマゴ|イワナ"),
    ("ナマズ", r"ナマズ"),
]
FISH_RE = [(name, re.compile(pat)) for name, pat in FISH]
FRESHWATER = {"アユ", "ブラックバス", "トラウト", "ナマズ"}
BOAT_RE = re.compile(r"船|遊漁|乗合|沖|ジギング|タイラバ|鯛ラバ|ティップラン|オフショア|テンヤ|スルルー")
FRESH_RE = re.compile(r"ダム|湖|管理釣り場|渓流")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
    time.sleep(1.5)
    return body.decode("utf-8", "replace")


def plain(s):
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s or "", flags=re.S)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s).replace(" ", " ")
    return re.sub(r"\s+", " ", s).strip()


def cut(s, n=EXCERPT_LEN):
    return s if len(s) <= n else s[:n].rstrip() + "…"


def field(text, *names):
    """「釣行場所 周防大島 釣果 …」や「【釣場】西海岸」から項目を抜く。"""
    for n in names:
        m = re.search(r"【" + n + r"】\s*([^【]{1,40})", text)
        if m:
            return m.group(1).strip()
        m = re.search(n + r"\s+(.{1,30}?)(?=\s+(?:釣果|タックル|釣行日|釣行場所|サイズ|釣り方|仕掛け)|$)", text)
        if m:
            return m.group(1).strip()
    return ""


# 釣り場名 → おおよその位置（緯度, 経度）。店の釣果を地図に出すために使う。
# 長い名前から先に照合する。あいまいな地名（室津・大津など）は入れない。
PLACES_BY_PREF = {"広島": {
    "倉橋": (34.115, 132.52), "音戸": (34.19, 132.54), "警固屋": (34.20, 132.54), "呉": (34.23, 132.56),
    "江田島": (34.20, 132.45), "能美島": (34.18, 132.40), "沖美": (34.20, 132.34), "大柿": (34.18, 132.47),
    "大黒神島": (34.17, 132.36), "似島": (34.32, 132.42), "宇品": (34.35, 132.46), "広島港": (34.35, 132.46),
    "江波": (34.37, 132.43), "太田川": (34.48, 132.50), "八幡川": (34.36, 132.35), "五日市": (34.36, 132.36),
    "廿日市": (34.34, 132.33), "宮島": (34.28, 132.31), "大竹": (34.23, 132.22), "小屋浦": (34.31, 132.52),
    "坂ベイサイド": (34.32, 132.51), "下蒲刈": (34.20, 132.64), "上蒲刈": (34.19, 132.70), "蒲刈": (34.19, 132.68),
    "安浦": (34.27, 132.70), "竹原": (34.34, 132.91), "忠海": (34.32, 132.97), "大久野島": (34.31, 132.99),
    "大崎上島": (34.25, 132.90), "三原": (34.39, 133.08), "生口島": (34.29, 133.10), "因島": (34.31, 133.18),
    "向島": (34.38, 133.21), "尾道": (34.41, 133.20), "鞆": (34.38, 133.38), "福山": (34.46, 133.40),
    "走島": (34.34, 133.46),
}, "山口": {
    "周防大島": (33.93, 132.25), "屋代島": (33.93, 132.25), "岩国": (34.17, 132.22), "錦川": (34.17, 132.18),
    "由宇": (34.04, 132.20), "柳井": (33.96, 132.10), "上関": (33.82, 132.11), "光市": (33.96, 131.94),
    "下松": (34.00, 131.87), "笠戸島": (33.97, 131.83), "徳山": (34.04, 131.80), "周南": (34.04, 131.80),
    "粭島": (34.00, 131.73), "防府": (34.03, 131.56), "佐波川": (34.05, 131.55), "野島": (33.93, 131.61),
    "秋穂": (34.00, 131.42), "宇部": (33.94, 131.25), "小野田": (33.98, 131.18), "長府": (34.02, 131.00),
    "関門": (33.96, 130.95), "彦島": (33.94, 130.90), "荒田": (33.94, 130.89), "福浦": (33.95, 130.90),
    "六連島": (33.98, 130.86), "吉見": (34.03, 130.89), "蓋井島": (34.10, 130.80), "下関": (33.96, 130.94),
    "角島": (34.35, 130.85), "特牛": (34.31, 130.89), "豊北": (34.30, 130.90), "油谷": (34.37, 131.03),
    "仙崎": (34.39, 131.20), "青海島": (34.41, 131.20), "長門": (34.37, 131.18), "萩": (34.41, 131.40),
    "阿武川": (34.40, 131.42), "須佐": (34.62, 131.60), "見島": (34.77, 131.14),
}, "島根": {  # 広島・山口から通う人が多い
    "浜田": (34.90, 132.07), "大田": (35.19, 132.50), "江津": (35.01, 132.22), "益田": (34.68, 131.84),
}}
PLACES = {k: v for d in PLACES_BY_PREF.values() for k, v in d.items()}
PLACE_KEYS = sorted(PLACES, key=len, reverse=True)


def locate(*texts):
    for t in texts:
        for k in PLACE_KEYS:
            if k in t:
                return k, PLACES[k]
    return "", None


def classify(text):
    fish = [name for name, rx in FISH_RE if rx.search(text)]
    if fish and all(f in FRESHWATER for f in fish) or FRESH_RE.search(text):
        kind = "淡水"
    elif BOAT_RE.search(text):
        kind = "船"
    else:
        kind = "岸"
    return fish, kind


def make(src, pref, shop, title, url, date, body, spot=""):
    text = title + " " + body
    fish, kind = classify(text)
    spot = spot if spot and not re.fullmatch(r"都道府県地名|釣り場|船釣り|-", spot) else ""
    place, pos = locate(spot, title, body)
    return {
        "url": url,
        "src": src,
        "pref": pref,
        "shop": shop,
        "title": cut(plain(title), 60),
        "date": date.astimezone(JST).isoformat(timespec="minutes"),
        "spot": cut(spot, 30),
        "fish": fish,
        "kind": kind,
        "text": cut(body),
        "place": place,
        "pos": list(pos) if pos else None,
    }


def rss_items(xml_text):
    root = ET.fromstring(xml_text.encode("utf-8"))
    for it in root.iter("item"):
        yield {
            "title": it.findtext("title") or "",
            "link": it.findtext("link") or "",
            "date": parsedate_to_datetime(it.findtext("pubDate")),
            "creator": it.findtext("dc:creator", namespaces=NS) or "",
            "desc": plain(it.findtext("description")),
            "content": plain(it.findtext("content:encoded", namespaces=NS)),
        }


# ---- かめや釣具（山陽エリアの釣果フィード） ----
def kameya():
    shop_pref = {s: p for p, shops in KAMEYA_SHOPS.items() for s in shops}
    try:
        cats = json.loads(get("https://kameya-choka.com/sanyo/wp-json/wp/v2/categories?per_page=100"))
        by_id = {c["id"]: c["name"] for c in cats}
        for c in cats:
            area = by_id.get(c["parent"], "")
            if area.endswith("エリア"):
                shop_pref[c["name"]] = area[:-3]
    except Exception as e:
        log("kameya categories:", e)
    out = []
    for page in (1, 2, 3):
        url = "https://kameya-choka.com/sanyo/archives/f-info/feed"
        if page > 1:
            url += f"?paged={page}"
        for it in rss_items(get(url)):
            pref = shop_pref.get(it["creator"])
            if pref not in ("広島", "山口"):
                continue
            body = it["content"] or it["desc"]
            body = re.sub(r"お持ち込み＆キッズ釣果自慢.*", "", body)
            out.append(make("かめや", pref, it["creator"], it["title"], it["link"], it["date"],
                            body, field(body, "釣行場所")))
    return out


# ---- アングル（エリア別の釣果フィード） ----
def angle():
    out = []
    for slug, pref in (("hiroshimaarea", "広島"), ("yamaguchiarea", "山口")):
        for page in (1, 2):
            url = f"https://www.e-angle.co.jp/chokaarea/{slug}/feed/"
            if page > 1:
                url += f"?paged={page}"
            try:
                items = list(rss_items(get(url)))
            except Exception as e:
                log("angle", slug, page, e)
                break
            for it in items:
                body = re.sub(r"The post .*? first appeared on .*$", "", it["content"] or it["desc"]).strip()
                m = re.search(r"([^\s0-9０-９/／、。！!]{1,8}店)", it["title"] + " " + body)
                shop = m.group(1).replace("ＡＧ", "").replace("AG", "") if m else "アングル"
                out.append(make("アングル", pref, shop, it["title"], it["link"], it["date"], body))
    return out


# ---- 釣具のポイント（お持込釣果の一覧ページ） ----
CARD_RE = re.compile(
    r'href="/fishing_infos/(\d+)".*?card__title">\s*(.*?)\s*</p>.*?'
    r'card__tag--fishing">\s*(.*?)\s*</div>.*?card__date">\s*(.*?)\s*</div>.*?'
    r'card__text">(.*?)</div>', re.S)


def point():
    out = []
    for area_id, pref in (("92", "広島"), ("91", "山口")):
        for page in (1, 2):
            url = f"https://www.point-i.jp/fishing_infos?area_id={area_id}&shop_id=0"
            if page > 1:
                url += f"&page={page}"
            try:
                page_html = get(url)
            except Exception as e:
                log("point", pref, page, e)
                break
            for pid, title, tag, date, body in CARD_RE.findall(page_html):
                shop = plain(tag).split(" ")[0]
                body = plain(body)
                d = datetime.strptime(date.strip(), "%Y/%m/%d").replace(hour=12, tzinfo=JST)
                spot = field(body, "釣場")
                size = field(body, "サイズ")
                fishes = field(body, "釣魚")
                short = " ".join(x for x in (fishes, size) if x) or body
                item = make("ポイント", pref, "ポイント" + shop, title, f"https://www.point-i.jp/fishing_infos/{pid}", d,
                            body, spot)
                item["text"] = cut(short if fishes else body)
                item["dateOnly"] = True
                out.append(item)
    return out


def main():
    try:
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f).get("items", [])
    except (OSError, ValueError):
        old = []
    by_url = {i["url"]: i for i in old}
    status = {}
    for name, fn in (("かめや", kameya), ("アングル", angle), ("ポイント", point)):
        try:
            items = fn()
            status[name] = len(items)
            for i in items:
                by_url[i["url"]] = i
            log(name, len(items))
        except Exception as e:
            status[name] = f"失敗: {e.__class__.__name__}"
            log(name, "FAILED", repr(e))
    cutoff = (datetime.now(JST) - timedelta(days=KEEP_DAYS)).isoformat()
    items = sorted((i for i in by_url.values() if i["date"] >= cutoff), key=lambda i: i["date"], reverse=True)
    new_urls = sorted(i["url"] for i in items)
    old_urls = sorted(i["url"] for i in old)
    if new_urls == old_urls and items == sorted(old, key=lambda i: i["date"], reverse=True):
        log("変更なし")
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    places = [[k, pref, lat, lng] for pref, d in PLACES_BY_PREF.items() for k, (lat, lng) in d.items()]
    data = {"updated": datetime.now(JST).isoformat(timespec="minutes"), "status": status, "places": places, "items": items}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log("保存", len(items), "件")


if __name__ == "__main__":
    main()
