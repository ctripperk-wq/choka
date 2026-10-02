# 釣果まとめ 中四国 ― 公開までの手順

## できること
- **一覧／地図**：かめや・アングル・ポイント・タイム・パゴス・わたなべ・フレンド・ジャンプワールドの中四国（9県）の釣果を2時間おきに自動で集める。地方・県・エリア・期間・釣り方・魚種で絞り込める。アングラーズとカンパリは規約で転載が禁止されているので、県別ページへのリンクだけ。
  - 地域は**釣った場所**で分ける（`data/places.json` の地名辞書）。同じ地名が複数ある場合と、場所が書かれていない場合は、投稿した店の地域で分ける。中四国の外の地名（他県・淡路・壱岐など）だけが書かれた釣果は入れない。「山陰」とだけ書かれたものは鳥取・島根の両方で出す。
- **魚種**：魚の名前（ひらがな・別名も可）で探し、魚ごとに件数・日ごとの推移・釣れている場所・最新の釣果を見られる。魚の辞書は `data/fish.json`。
- **投稿**：ユーザー名・日時・場所（地図にピン）・魚種・サイズ・数・釣り方・仕掛け・天気・潮・写真（4枚まで）・メモ。
  - 天気（天気・気温・風）は、日時と場所から Open-Meteo で自動入力する。
  - 潮は、日時から潮回り（大潮〜若潮）を、場所から満潮・干潮の時刻と「上げ7分」などを自動で入れる。どちらも手で直せる。
  - 写真に撮影日時と位置が入っていれば、それを使う。保存する写真は縮小し、位置情報を消す。
  - **公開／非公開**を選べる。公開するときは位置を約1kmぼかせる。本人には正確な位置で表示される。

## ファイル
| ファイル | 役目 |
|---|---|
| `index.html` `app.js` | 画面 |
| `config.js` | Supabase の接続先（手順2で入れる） |
| `fetch.py` | 店の釣果を集める（GitHub Actions が実行） |
| `data/choka.json` | 集めた釣果（自動で更新される） |
| `data/places.json` | 釣り場の地名 → 県・エリア・位置（手で足す） |
| `data/fish.json` | 魚種の辞書（手で足す） |
| `.github/workflows/update.yml` | 2時間おきに `fetch.py` を動かす設定 |
| `supabase/setup.sql` | 投稿用のテーブルと写真置き場を作るSQL |

---

## 手順1　GitHub に置く（店の釣果の一覧・地図が動く）
1. GitHub で新しいリポジトリ `choka` を **Public** で作る。
2. このフォルダの中身を全部アップロードする。
   - `.github` フォルダはエクスプローラーからドラッグすると抜けることがある。その場合は「Add file → Create new file」で、名前に `.github/workflows/update.yml` と入力し、中身を貼り付けて保存する。
3. **Settings → Pages**：Source を「Deploy from a branch」、Branch を `main` と `/ (root)` にして Save する。
   - 数分で `https://ctripperk-wq.github.io/choka/` で開けるようになる。
4. **Settings → Actions → General**：一番下の Workflow permissions を「**Read and write permissions**」にして Save する。
5. **Actions タブ**で「釣果を更新」を選び、「Run workflow」で1回動かす。以後は2時間おきに自動で動く。

## 手順2　Supabase を用意する（投稿・写真・ログインが動く）
1. https://supabase.com で無料アカウントを作る（GitHub アカウントでログインできる）。
2. 「New project」でプロジェクトを作る。Region は **Northeast Asia (Tokyo)** にする。データベースのパスワードは控えておく。
3. 左メニューの **SQL Editor** を開き、`supabase/setup.sql` の中身を全部貼り付けて **Run** する。
4. **Authentication → Sign In / Providers → Email**：
   - 仲間内で使うなら「**Confirm email**」をオフにすると、登録してすぐ使える。無料枠では確認メールを1時間に数通しか送れないため。
5. **Authentication → URL Configuration**：Site URL に `https://ctripperk-wq.github.io/choka/` を入れる。
6. **Project Settings → API**（または Data API）から次の2つを控え、`config.js` に入れてアップロードし直す。
   - **Project URL**
   - **anon public key**（`service_role` の鍵は絶対に入れない）
7. 仲間が登録し終わったら、**Authentication → Sign In / Providers** の「Allow new users to sign up」をオフにすると、知らない人が登録できなくなる。

## 気をつけること
- 店の釣果は、見出し・短い抜粋・リンクだけを持つ。写真と全文は元の記事で見てもらう。サイトは検索に出ない設定（noindex）にしてある。
- 潮位は Open-Meteo の海洋モデルの値なので**目安**。瀬戸内海の入り組んだ場所では、満潮・干潮の時刻が数十分ずれることがある。
- 店のサイトの作りが変わると、その店だけ取れなくなる（他の店は動き続ける）。`data/choka.json` の `status` に件数か「失敗」が出る。
- GitHub は、リポジトリに60日間動きがないと自動実行を止めることがある。止まったら Actions タブから再開する。
- 無料枠の目安：Supabase はデータベース500MB・写真1GB。写真は1枚200〜400KBほどなので、数千枚までは大丈夫。

## 過去分の取り込み・保存期間
- 店の釣果は1年分（365日）を保存する。2026-10-02 に、過去1年分をまとめて取り込んだ。
- もう一度まとめて取り込むとき（このPCで）：`BACKFILL_DAYS=365 python fetch.py`（1時間ほどかかる。一部の店だけなら `ONLY=タイム,パゴス` を付ける）
- みんなの投稿は期限なしで残す。容量が9割を超えたら `cleanup.py`（毎日4時）が古い写真から消して8割に戻す。GitHub のシークレット `SUPABASE_SERVICE_KEY` が必要。
- Supabase の `supabase/cleanup.sql` は実行済み。
