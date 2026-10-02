"""みんなの投稿の容量を見て、いっぱいに近づいたら古いものから消す。

GitHub Actions から1日1回動かす。投稿はふだんは消さず、ずっと残す。
Supabase の無料枠（写真 1GB・データベース 500MB）の 9割を超えたら、8割まで戻す。
  1. どの投稿にも付いていない写真（投稿をやめた等）を消す
  2. それでも写真が多ければ、釣った日の古い投稿の写真から消す（本文は残し、photos_removed を付ける）
  3. データベースが満杯に近いときだけ、古い投稿そのものを消す（1回の実行で最大 DB_DELETE_MAX 件）

必要な設定（GitHub の Settings → Secrets and variables → Actions）:
  SUPABASE_SERVICE_KEY … Supabase の secret key（sb_secret_…）。公開してはいけない鍵なので、ファイルには書かない。
鍵が無ければ何もせずに終わる。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

URL = os.environ.get("SUPABASE_URL", "https://qfjfeywptmklucoewhhi.supabase.co").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
MB = 1024 * 1024
PHOTO_LIMIT, DB_LIMIT = 1024 * MB, 500 * MB      # 無料枠
START, TARGET = 0.9, 0.8                          # 9割を超えたら 8割まで戻す
DB_DELETE_MAX = 1000
DRY_RUN = os.environ.get("DRY_RUN") == "1"        # 1 なら消さずに、消す予定だけ表示


def log(*a):
    print(*a, flush=True)


def call(method, path, body=None, headers=None):
    h = {"apikey": KEY, "Content-Type": "application/json"}
    h.update(headers or {})
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(URL + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        txt = r.read().decode() or "null"
    return json.loads(txt)


def rpc(name, args=None):
    return call("POST", f"/rest/v1/rpc/{name}", args or {})


def usage():
    u = rpc("storage_usage")[0]
    return int(u["photo_bytes"]), int(u["db_bytes"])


def remove_files(paths):
    for k in range(0, len(paths), 100):
        if not DRY_RUN:
            call("DELETE", "/storage/v1/object/photos", {"prefixes": paths[k:k + 100]})


def mark_removed(removed):
    """投稿の photos から消した写真を外し、photos_removed を付ける。"""
    ids = list(removed)
    for k in range(0, len(ids), 100):
        q = "id=in.(" + ",".join(ids[k:k + 100]) + ")"
        rows = call("GET", f"/rest/v1/catches?select=id,photos&{q}")
        for r in rows:
            left = [p for p in (r["photos"] or []) if p not in removed[r["id"]]]
            if not DRY_RUN:
                call("PATCH", f"/rest/v1/catches?id=eq.{r['id']}", {"photos": left, "photos_removed": True},
                     {"Prefer": "return=minimal"})


def main():
    if not KEY:
        log("SUPABASE_SERVICE_KEY が無いので何もしません")
        return
    photo, db = usage()
    log(f"写真 {photo / MB:.1f}MB / {PHOTO_LIMIT / MB:.0f}MB、データベース {db / MB:.1f}MB / {DB_LIMIT / MB:.0f}MB")

    # 1. どの投稿にも付いていない写真
    orphans = rpc("orphan_photos", {"max_rows": 1000})
    if orphans:
        remove_files([o["path"] for o in orphans])
        log(f"投稿に付いていない写真 {len(orphans)} 枚を消去", "（試しのため消していません）" if DRY_RUN else "")
        photo -= sum(int(o["bytes"]) for o in orphans)

    # 2. 古い投稿の写真
    if photo > PHOTO_LIMIT * START:
        need = photo - PHOTO_LIMIT * TARGET
        freed, removed, paths = 0, {}, []
        while freed < need:
            rows = [r for r in rpc("oldest_photos", {"max_rows": 500}) if r["path"] not in paths]
            if not rows:
                break
            for r in rows:
                if freed >= need:
                    break
                paths.append(r["path"])
                removed.setdefault(r["catch_id"], set()).add(r["path"])
                freed += int(r["bytes"])
            if DRY_RUN:
                break
            remove_files(paths[-len(rows):])
            mark_removed({k: v for k, v in removed.items()})
        if DRY_RUN:
            remove_files(paths)
        log(f"古い投稿の写真 {len(paths)} 枚（{freed / MB:.1f}MB）を消去、{len(removed)} 件の投稿に「容量のため削除」を付けた",
            "（試しのため消していません）" if DRY_RUN else "")

    # 3. データベースが満杯に近いときだけ、古い投稿そのもの
    if db > DB_LIMIT * START:
        rows = call("GET", f"/rest/v1/catches?select=id,photos&order=caught_at.asc&limit={DB_DELETE_MAX}")
        cut = rows[:max(1, len(rows) // 5)]  # 一度に消しすぎない（大きさの反映は遅れるため）
        remove_files([p for r in cut for p in (r["photos"] or [])])
        ids = ",".join(r["id"] for r in cut)
        if not DRY_RUN and ids:
            call("DELETE", f"/rest/v1/catches?id=in.({ids})", headers={"Prefer": "return=minimal"})
        log(f"データベースが満杯に近いため、古い投稿 {len(cut)} 件を消去", "（試しのため消していません）" if DRY_RUN else "")

    photo, db = usage()
    log(f"整理後：写真 {photo / MB:.1f}MB、データベース {db / MB:.1f}MB")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        log("エラー", e.code, e.read().decode()[:500])
        sys.exit(1)
