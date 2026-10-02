"""中四国の釣具店の釣果を集めて data/choka.json にまとめる。

GitHub Actions から2時間おきに動かす。標準ライブラリだけで動く。
相手サイトに負担をかけないよう、1回の実行で読むのは30ページ弱まで、
1リクエストごとに少し待つ。写真と本文は保存せず、短い抜粋とリンクだけ持つ。

県・エリアは「店の場所」ではなく「釣った場所」で決める。
釣り場名・見出し・本文に data/places.json の地名があればその県・エリア、
県名だけ書いてあればその県、どちらもなければ店の地域（店名の地名・県）で分ける。
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
KEEP_DAYS = 365
# 過去分を一度だけ取り込むとき： BACKFILL_DAYS=365 python fetch.py
# 日付がその日数前に届くまでページをめくる（ふだんの2時間おきの実行では最新の数ページだけ）。
BACKFILL_DAYS = int(os.environ.get("BACKFILL_DAYS") or 0)
DEEP_CUTOFF = datetime.now(JST) - timedelta(days=BACKFILL_DAYS) if BACKFILL_DAYS else None
# 別の choka.json の釣果を混ぜる（取り込み中に自動更新が入ったときの合流用）
MERGE_FILE = os.environ.get("MERGE_FILE")
EXCERPT_LEN = 100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "choka.json")

NS = {
    "dc": "http://purl.org/dc/elements/1.1/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}

with open(os.path.join(HERE, "data", "places.json"), encoding="utf-8") as f:
    _P = json.load(f)
REGIONS = _P["regions"]
PREFS = [p for ps in REGIONS.values() for p in ps]
PLACES = {}  # 地名 → (県, エリア, 緯度, 経度)
for _pref, _areas in _P["places"].items():
    for _area, _names in _areas.items():
        for _name, (_lat, _lng) in _names.items():
            PLACES[_name] = (_pref, _area, _lat, _lng)
AMBIG = _P.get("ambiguous", {})      # 同じ地名が複数あるもの → 候補
CENTERS = _P.get("centers", {})      # 県・地域のおおよその中心（店の位置が分からないとき用）
PLACE_KEYS = sorted(list(PLACES) + list(AMBIG), key=len, reverse=True)
PREF_RE = re.compile("(" + "|".join(PREFS) + ")")
OUTSIDE_RE = re.compile("|".join(map(re.escape, _P.get("outside", []))))
REGION_WORDS = _P.get("region_words", {})

with open(os.path.join(HERE, "data", "fish.json"), encoding="utf-8") as f:
    _F = json.load(f)
FISH = [(x["name"], x["group"], re.compile(x["re"]), x.get("excl", [])) for x in _F["fish"]]
FRESH_GROUP = "淡水"
BOAT_RE = re.compile(r"船|遊漁|乗合|沖(?!堤)|ジギング|タイラバ|鯛ラバ|ティップラン|オフショア|テンヤ|スルルー|イカメタル")
FRESH_RE = re.compile(r"ダム|湖(?!畔の宿)|管理釣り場|渓流|河川上流")

# 店名 → 店のある地域（釣り場が分からないときの控え）
KAMEYA_SHOPS = {
    "広島": ["五日市店", "サファ福山西店", "三次店", "八木店", "呉店", "商工センター店", "東広島店", "福山店", "総本店"],
    "山口": ["下松店", "大島店", "岩国通津店", "防府店"],
    "岡山": ["岡山妹尾店", "岡山平井店"],
    "鳥取": ["鳥取店", "米子店"],
    "島根": ["浜田店", "出雲店", "松江店"],
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
    time.sleep(2.0 if DEEP_CUTOFF else 1.5)
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
        m = re.search(n + r"\s+(?!(?:釣果|タックル|釣行日|釣行者|サイズ)\s)(.{1,30}?)(?=\s+(?:釣果|タックル|釣行日|釣行者|釣行場所|サイズ|釣り方|仕掛け)|$)", text)
        if m:
            return m.group(1).strip()
    return ""


def strip_shops(s):
    """店名（「〇〇店」）や海の名前は釣った場所の地名ではないので、照合から外す。"""
    s = re.sub(r"瀬戸内海|日本海|太平洋", " ", s)  # 「瀬戸内海」の「内海」などに反応しないように
    return re.sub(r"[^\s、。!！?？()（）【】「」・|｜]{1,10}店", " ", s)


def shop_pos(shop, shop_area):
    """店のおおよその位置（店名の地名 → 店名の県名 → 店のある地域の中心）。"""
    for k in sorted(PLACES, key=len, reverse=True):
        if k in shop:
            return PLACES[k][2:]
    m = PREF_RE.search(shop)
    return CENTERS.get(m.group(1) if m else shop_area)


def where(spot, title, body, shop="", shop_area=""):
    """釣った場所 → (県, エリア, 地名, 位置)。分からなければ県は空。
    同じ地名が複数ある場合（長浜・内海など）は、投稿した店にいちばん近い候補にする。"""
    texts = [strip_shops(t) for t in (spot, title, body)]
    for t in texts:
        for k in PLACE_KEYS:
            if k not in t:
                continue
            if k in PLACES:
                pref, area, lat, lng = PLACES[k]
                return pref, area, k, [lat, lng]
            sp = shop_pos(shop, shop_area)
            if not sp:
                continue  # 店の位置も分からなければ決めない
            pref, area, lat, lng = min(AMBIG[k], key=lambda c: (c[2] - sp[0]) ** 2 + (c[3] - sp[1]) ** 2)
            return pref, area, k, [lat, lng]
    for t in texts[:2]:  # 県名だけ書いてある場合
        m = PREF_RE.search(t)
        if m:
            return m.group(1), "", "", None
    # 本文の県名は店の紹介のこともあるので、「愛媛まで」「島根県」「山口方面」のような書き方だけ見る
    m = re.search("(" + "|".join(PREFS) + r")(?:県|まで|へ|方面|に遠征)", re.sub(r"〒.*?(?:TEL|ＴＥＬ|☎)\S*", " ", texts[2]))
    if m:
        return m.group(1), "", "", None
    return "", "", "", None


def shop_where(shop, shop_area):
    """釣り場が分からないときは、店の地域で分ける（店名の地名 → 店名の県名 → 店のある県）。"""
    for k in sorted(PLACES, key=len, reverse=True):
        if k in shop:
            pref, area, _lat, _lng = PLACES[k]
            return pref, area
    m = PREF_RE.search(shop)
    if m:
        return m.group(1), ""
    return (shop_area, "") if shop_area in PREFS else ("", "")


def fish_of(text):
    out = []
    for name, _group, rx, excl in FISH:
        t = text
        for e in excl:
            t = t.replace(e, "")
        if rx.search(t):
            out.append(name)
    return out


FRESH_NAMES = {name for name, group, _rx, _e in FISH if group == FRESH_GROUP}


def classify(text):
    fish = fish_of(text)
    if fish and all(f in FRESH_NAMES for f in fish) or FRESH_RE.search(text):
        kind = "淡水"
    elif BOAT_RE.search(text):
        kind = "船"
    else:
        kind = "岸"
    return fish, kind


def make(src, shop, shop_area, title, url, date, body, spot=""):
    title, body = plain(title), plain(body)
    spot = spot if spot and not re.fullmatch(r"都道府県地名|釣り場|釣場|船釣り|-|ー|不明", spot) else ""
    fish, kind = classify(title + " " + body)
    pref, area, place, pos = where(spot, title, body, shop, shop_area)
    by_shop, outside, hint = False, False, ""
    if not pref:
        texts = " ".join(strip_shops(t) for t in (spot, title, body))
        hint = next((w for w in REGION_WORDS if w in texts), "")
        if hint:
            pass                   # 「山陰」など県まで分からないもの：地方だけ控える
        elif OUTSIDE_RE.search(texts):
            outside = True         # 中四国の外での釣果（遠征記など）
        else:
            pref, area = shop_where(shop, shop_area)
            by_shop = True
    return {
        "byShop": by_shop,         # True なら釣り場が分からず、店の地域で分けたもの
        "outside": outside,
        "regionHint": hint,        # 「山陰」など、県が分からないときの地方
        "url": url,
        "src": src,
        "shop": shop,
        "shopArea": shop_area,     # 店のある地域（参考）
        "pref": pref,              # 釣った場所の県（不明なら店の県。それも分からなければ空）
        "area": area,
        "place": place,
        "pos": pos,
        "title": cut(title, 60),
        "date": date.astimezone(JST).isoformat(timespec="minutes"),
        "spot": cut(spot, 30),
        "fish": fish,
        "kind": kind,
        "text": cut(body),
    }


def rss_items(xml_text):
    root = ET.fromstring(xml_text.encode("utf-8"))
    for it in root.iter("item"):
        yield {
            "title": it.findtext("title") or "",
            "link": it.findtext("link") or "",
            "date": parsedate_to_datetime(it.findtext("pubDate")),
            "creator": it.findtext("dc:creator", namespaces=NS) or "",
            "cats": [c.text or "" for c in it.findall("category")],
            "desc": plain(it.findtext("description")),
            "content": plain(it.findtext("content:encoded", namespaces=NS)),
        }


def feed_pages(url, pages):
    out, seen = [], set()
    limit = 1000 if DEEP_CUTOFF else pages
    for page in range(1, limit + 1):
        u = url if page == 1 else url + ("&" if "?" in url else "?") + f"paged={page}"
        try:
            items = list(rss_items(get(u)))
        except Exception as e:
            log("feed", u, e)
            break
        new = [i for i in items if i["link"] not in seen]
        if not new:  # 同じページが返ってきたら終わり（ページめくりに対応していないフィード）
            break
        seen.update(i["link"] for i in new)
        out += new
        if len(items) < 10:
            break
        if DEEP_CUTOFF:
            oldest = min(i["date"] for i in items)
            if page % 20 == 0:
                log("  ", url, page, "ページ目", oldest.date())
            if oldest < DEEP_CUTOFF:
                break
    return out


# ---- かめや釣具（山陽・山陰の釣果フィード） ----
def kameya():
    shop_area = {s: p for p, shops in KAMEYA_SHOPS.items() for s in shops}
    shop_area["itukaichi"] = "広島"  # 五日市店のアカウント名がローマ字のことがある
    out = []
    for region in ("sanyo", "sanin"):
        for it in feed_pages(f"https://kameya-choka.com/{region}/archives/f-info/feed", 3):
            body = it["content"] or it["desc"]
            body = re.sub(r"お持ち込み＆キッズ釣果自慢.*", "", body)
            shop = "五日市店" if it["creator"] == "itukaichi" else it["creator"]
            out.append(make("かめや", shop, shop_area.get(it["creator"], "山陰" if region == "sanin" else "山陽"),
                            it["title"], it["link"], it["date"], body, field(body, "釣行場所")))
    return out


# ---- アングル（エリア別の釣果フィード） ----
def angle():
    out = []
    for slug, area in (("hiroshimaarea", "広島"), ("yamaguchiarea", "山口"), ("shimanearea", "島根"), ("totoriarea", "鳥取")):
        for it in feed_pages(f"https://www.e-angle.co.jp/chokaarea/{slug}/feed/", 2):
            body = re.sub(r"The post .*? first appeared on .*$", "", it["content"] or it["desc"]).strip()
            m = re.search(r"([^\s0-9０-９/／、。！!]{1,8}店)", it["title"] + " " + body)
            shop = m.group(1).replace("ＡＧ", "").replace("AG", "") if m else "アングル"
            out.append(make("アングル", shop, area, it["title"], it["link"], it["date"], body))
    return out


# ---- 釣具のポイント（お持込釣果の一覧ページ） ----
CARD_RE = re.compile(
    r'href="/fishing_infos/(\d+)".*?card__title">\s*(.*?)\s*</p>.*?'
    r'card__tag--fishing">\s*(.*?)\s*</div>.*?card__date">\s*(.*?)\s*</div>.*?'
    r'card__text">(.*?)</div>', re.S)
POINT_AREAS = (("74", "山陰"), ("93", "岡山"), ("92", "広島"), ("91", "山口"), ("95", "四国"))


def point():
    out = []
    for area_id, area in POINT_AREAS:
        for page in range(1, 1000 if DEEP_CUTOFF else 3):
            url = f"https://www.point-i.jp/fishing_infos?area_id={area_id}&shop_id=0"
            if page > 1:
                url += f"&page={page}"
            try:
                page_html = get(url)
            except Exception as e:
                log("point", area, page, e)
                break
            cards = CARD_RE.findall(page_html)
            if not cards:
                break
            if DEEP_CUTOFF:
                oldest = datetime.strptime(cards[-1][3].strip(), "%Y/%m/%d").replace(tzinfo=JST)
                if page % 20 == 0:
                    log("   ポイント", area, page, "ページ目", oldest.date())
            for pid, title, tag, date, body in cards:
                shop = plain(tag).split(" ")[0]
                body = plain(body)
                d = datetime.strptime(date.strip(), "%Y/%m/%d").replace(hour=12, tzinfo=JST)
                fishes, size = field(body, "釣魚"), field(body, "サイズ")
                item = make("ポイント", "ポイント" + shop, area, title, f"https://www.point-i.jp/fishing_infos/{pid}", d,
                            body, field(body, "釣場"))
                if fishes:
                    item["text"] = cut(" ".join(x for x in (fishes, size) if x))
                item["dateOnly"] = True
                out.append(item)
            if DEEP_CUTOFF and oldest < DEEP_CUTOFF:
                break
    return out


# ---- 釣り具のタイム（岡山・広島。お持ち込み釣果のフィード） ----
def ftime():
    out = []
    for it in feed_pages("https://f-time.jp/category/motikomi/feed/", 2):
        if re.search(r"\d+日号|まとめ", it["title"]):  # 週刊のまとめ記事は場所が混ざるので外す
            continue
        body = re.sub(r"^釣具のタイムにお持ち込みいただいたお客様情報です。ありがとうございます。", "", it["desc"]).strip()
        parts = it["title"].split("|")  # 「広島県の釣果情報|内海周辺|エギング|アオリイカ【2026年9月】」
        spot = field(body, "釣場") or (parts[1] if len(parts) > 2 else "")
        out.append(make("タイム", "タイム", "岡山・広島", it["title"], it["link"], it["date"], body, spot))
    return out


# ---- パゴス（広島。スタッフ釣行記のフィード） ----
def pagos():
    out = []
    for it in feed_pages("https://pagos.jp/category/fishingdiary/feed/", 1):
        body = it["desc"] + " " + " ".join(c for c in it["cats"] if c not in ("スタッフ釣行記",))
        m = re.search(r"([^\s(（]{1,6}店)", it["title"])
        out.append(make("パゴス", "パゴス" + (m.group(1) if m else ""), "広島", it["title"], it["link"], it["date"], body))
    return out


# ---- つり具のわたなべ（岡山。釣果情報のフィード。遠征記は中四国の外なら外れる） ----
def watanabe():
    out = []
    for it in feed_pages("https://tsurigu-watanabe.jp/category/fishinginfo/feed/", 1):
        body = it["content"] or it["desc"]
        out.append(make("わたなべ", "わたなべ", "岡山", it["title"], it["link"], it["date"], body))
    return out


# ---- 釣具のフレンド（愛媛。店ブログ。お知らせも混ざるので、釣れた話だけ拾う） ----
CATCH_WORDS = re.compile(r"釣れ|釣果|釣って|釣った|釣り上げ|ゲット|お持ち込み|ヒット|上がりました")


def friend():
    out = []
    for it in feed_pages("https://rssblog.ameba.jp/turigunofurendo/rss20.xml", 1):
        body = it["content"] or it["desc"]
        body = re.sub(r"最新情報をLINEで配信中.*$", "", body)
        if not (CATCH_WORDS.search(it["title"] + body) and fish_of(it["title"] + " " + body)):
            continue
        m = re.search(r"フレンド\s*(松山|松前|今治)", body)
        shop = "フレンド" + (m.group(1) + "店" if m else "")
        out.append(make("フレンド", shop, "愛媛", it["title"], it["link"], it["date"], body))
    return out


# ---- ジャンプワールド（アングラーズグループの四国の店。ブログの「釣果情報」分類） ----
ATOM = "{http://www.w3.org/2005/Atom}"


def atom_items(xml_text):
    root = ET.fromstring(xml_text.encode("utf-8"))
    for e in root.iter(ATOM + "entry"):
        link = next((l.get("href") for l in e.findall(ATOM + "link") if l.get("rel", "alternate") == "alternate"), "")
        yield {
            "title": e.findtext(ATOM + "title") or "",
            "link": link,
            "date": datetime.fromisoformat((e.findtext(ATOM + "published") or e.findtext(ATOM + "updated")).replace("Z", "+00:00")),
            "cats": [c.get("term") or "" for c in e.findall(ATOM + "category")],
            "content": plain(e.findtext(ATOM + "content") or e.findtext(ATOM + "summary")),
        }


def jw_clean(body):
    # 毎回付く店の住所・イベント案内より後ろは、釣り場の情報ではないので切る
    body = re.split(r"☆?イベント情報|\d{4}アオリイカフォトダービー|ジャンプワールド\S{1,5}店\s*(?:〒|香川県|愛媛県|高松市)", body)[0]
    return re.sub(r"この投稿をInstagramで見る|\S*\(@\w+\)がシェアした投稿|☆JUMP全店.*?☆", " ", body)


def jw_item(title, link, date, cats, body, area):
    body = jw_clean(body)
    m = re.search(r"ジャンプワールド\s*([^\s　(（@]{1,5}店)", body)
    shop_cat = next((c for c in cats if c.endswith("店")), "")
    shop = "ジャンプワールド" + (shop_cat or (m.group(1) if m else ""))
    return make("ジャンプ", shop, area, title, link, date, body)


JW_BLOGS = (("imabari", "愛媛"), ("jump2", "香川"))
JW_ENTRY_RE = re.compile(
    r'<h2 class="entry-header"><a href="([^"]+)">(.*?)<span class="date-category">(.*?)</span>'
    r'<span class="date-header">(\d{4})-(\d\d)-(\d\d) (AM|PM)(\d\d):(\d\d)</span>', re.S)


def jw_archive(blog, area):
    """過去分：月ごとのページ（10件ずつ）を、1年前の月までさかのぼって読む。"""
    out = []
    y, mo = datetime.now(JST).year, datetime.now(JST).month
    while (y, mo) >= (DEEP_CUTOFF.year, DEEP_CUTOFF.month):
        for page in range(1, 30):
            url = f"https://anglers.lekumo.biz/{blog}/{y}/{mo:02d}/" + (f"?p={page}" if page > 1 else "")
            try:
                h = get(url)
            except Exception as e:
                log("jumpworld", url, e)
                break
            chunks = h.split('<div class="entry" id="')[1:]
            for ch in chunks:
                m = JW_ENTRY_RE.search(ch)
                if not m:
                    continue
                link, title, cat, yy, mm, dd, ap, hh, mi = m.groups()
                cats = re.findall(r"（([^）]+)）", plain(cat))
                if "釣果情報" not in cats:
                    continue
                hour = int(hh) % 12 + (12 if ap == "PM" else 0)
                date = datetime(int(yy), int(mm), int(dd), hour, int(mi), tzinfo=JST)
                body = plain(ch.split('class="entry-body"', 1)[-1].split('class="entry-footer"', 1)[0])
                out.append(jw_item(plain(title), link, date, cats, body, area))
            if len(chunks) < 10:
                break
        y, mo = (y, mo - 1) if mo > 1 else (y - 1, 12)
    return out


def jumpworld():
    out = []
    for blog, area in JW_BLOGS:
        if DEEP_CUTOFF:
            out += jw_archive(blog, area)
            continue
        try:
            items = list(atom_items(get(f"https://anglers.lekumo.biz/{blog}/cyouka/atom.xml")))
        except Exception as e:
            log("jumpworld", blog, e)
            continue
        for it in items:
            out.append(jw_item(it["title"], it["link"], it["date"], it["cats"], it["content"], area))
    return out


SOURCES = (("かめや", kameya), ("アングル", angle), ("ポイント", point), ("タイム", ftime), ("パゴス", pagos),
           ("わたなべ", watanabe), ("フレンド", friend), ("ジャンプ", jumpworld))
SHOP_AREAS = set(PREFS) | {"山陰", "山陽", "四国", "岡山・広島"}


def main():
    try:
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = {}
    by_url = {i["url"]: i for i in old.get("items", []) if "outside" in i}  # 古い形式の行は作り直す
    if MERGE_FILE:
        with open(MERGE_FILE, encoding="utf-8") as f:
            extra = [i for i in json.load(f).get("items", []) if "outside" in i]
        for i in extra:
            by_url.setdefault(i["url"], i)
        log("合流", MERGE_FILE, len(extra), "件")
    status = {}
    only = [x for x in (os.environ.get("ONLY") or "").split(",") if x]  # 例: ONLY=タイム,パゴス（一部の店だけ読み直す）
    for name, fn in SOURCES:
        if only and name not in only:
            continue
        try:
            items = fn()
            # 中四国で釣ったもの、または場所不明でも中四国の店のもの
            keep = [i for i in items if not i["outside"] and
                    (i["pref"] in PREFS or i["regionHint"] or (not i["pref"] and i["shopArea"] in SHOP_AREAS))]
            status[name] = len(keep)
            for i in keep:
                by_url[i["url"]] = i
            log(name, len(items), "→", len(keep))
        except Exception as e:
            status[name] = f"失敗: {e.__class__.__name__}"
            log(name, "FAILED", repr(e))
    cutoff = (datetime.now(JST) - timedelta(days=KEEP_DAYS)).isoformat()
    items = sorted((i for i in by_url.values() if i["date"] >= cutoff), key=lambda i: i["date"], reverse=True)
    if items == old.get("items"):
        log("変更なし")
        return
    places = [[k, v[0], v[1], v[2], v[3]] for k, v in PLACES.items()]  # 画面の「近くの地名」用（重複地名は除く）
    areas = {p: list(_P["places"][p].keys()) for p in PREFS}
    data = {"updated": datetime.now(JST).isoformat(timespec="minutes"), "status": status,
            "regions": REGIONS, "areas": areas, "places": places, "items": items}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log("保存", len(items), "件")


if __name__ == "__main__":
    main()
