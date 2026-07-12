# SFX Generator — 設計仕様書(API契約)

Stable Audio 3 Small SFX を使ったローカル効果音生成アプリ。
バックエンド: FastAPI(単独起動可、外部アプリからREST呼び出し可)/ フロントエンド: 静的SPA(FastAPIが配信)。

## ディレクトリ構成

```
/home/animede/sound-efect/
  venv/                  # 構築済み venv(torch 2.7.1+cu128, stable_audio_3, fastapi, uvicorn, soundfile, httpx)
  app/
    __init__.py
    main.py              # FastAPI app。`./venv/bin/python -m app.main --host 0.0.0.0 --port 8600` で起動
    config.py            # 設定(環境変数で上書き可)
    sfx_model.py         # StableAudioModel ラッパー(バックグラウンドロード、推論ロック)
    translate.py         # 日本語→英語翻訳(ローカルLLM、OpenAI互換API)
    store.py             # SQLite メタデータ + WAVファイル管理
    presets.py           # ワンクリックプリセット定義(約40種)
    routers/
      __init__.py
      api.py             # /api/* エンドポイント
  static/
    index.html
    style.css
    app.js
    vendor/wavesurfer.esm.js
    vendor/regions.esm.js
  generated/             # WAV保存先(git管理外)+ sounds.db
  docs/DESIGN.md
```

## 設定(app/config.py、環境変数で上書き)

| 変数 | 既定値 | 説明 |
|---|---|---|
| SFX_HOST | 0.0.0.0 | |
| SFX_PORT | 8600 | |
| SFX_MODEL | small-sfx | StableAudioModel.from_pretrained に渡す名前 |
| SFX_DEVICE | cuda | "cuda" / "cpu" |
| SFX_DATA_DIR | ./generated | WAV と sounds.db の置き場所 |
| SFX_LLM_URL | http://127.0.0.1:64652/v1 | 翻訳用ローカルLLM(OpenAI互換) |
| SFX_LLM_MODEL | unsloth/gemma-4-E4B-it-GGUF | |

## モデル利用(app/sfx_model.py)

- ライブラリ: `stable_audio_3`(venv にインストール済み)。**実装前に必ず `venv/lib/python3.12/site-packages/stable_audio_3/` の実コードを読んで `StableAudioModel.from_pretrained` / `generate` の正確なシグネチャ・返り値型・サンプルレート取得方法を確認すること。**
- 参考(README 記載): `model = StableAudioModel.from_pretrained("small-sfx")` → `audio = model.generate(prompt="...", duration=7)`
- 起動時にバックグラウンドスレッドでロード開始。ロード完了前の生成要求は 503。
- 推論は `threading.Lock` で直列化し、FastAPI からは `run_in_executor` で呼ぶ。
- 生成結果は 44.1kHz ステレオ想定。`soundfile` で WAV (PCM_16) 保存。
- HFゲート未承認だと from_pretrained が 403 で失敗する。エラーメッセージを保持し `/api/status` で返すこと(「https://huggingface.co/stabilityai/stable-audio-3-small-sfx でライセンス同意が必要」)。

## 翻訳(app/translate.py)

- プロンプトに日本語文字(ひらがな/カタカナ/漢字、`[ぁ-ヿ一-鿿]`)が含まれる場合のみ、ローカルLLMで英訳。ASCII のみならそのまま使う。
- OpenAI互換 `POST {SFX_LLM_URL}/chat/completions`、system プロンプト:
  "You are a translator for a sound-effect generation AI. Translate the Japanese description of a sound effect into a concise English prompt suitable for a text-to-audio model. Output ONLY the English prompt, nothing else."
- temperature 0.2、タイムアウト 30s。失敗時は HTTP 503 `{"detail": "翻訳サーバに接続できません..."}` を返す(誤った日本語プロンプトのまま生成しない)。

## データ(app/store.py)

SQLite(`generated/sounds.db`)、テーブル `sounds`:

```sql
CREATE TABLE IF NOT EXISTS sounds (
  id TEXT PRIMARY KEY,            -- uuid4 hex
  name TEXT NOT NULL,             -- 表示名(一意)
  prompt_original TEXT NOT NULL,  -- ユーザー入力 or プリセット英語プロンプト
  prompt_en TEXT NOT NULL,        -- 実際にモデルへ渡した英語プロンプト
  source TEXT NOT NULL,           -- preset_id または "custom"
  duration_s REAL NOT NULL,       -- 現在のファイルの長さ(カット後更新)
  sample_rate INTEGER NOT NULL,
  filename TEXT NOT NULL,         -- generated/ 内のファイル名({id}.wav)
  created_at TEXT NOT NULL        -- ISO8601
);
```

- **命名規則**: `name` 指定があればそれを使用(重複時は `_2`, `_3` を付与)。無指定時は、プリセット生成なら「プリセット日本語ラベル+`_`+3桁連番」(例 `爆発_001`)、自由入力なら入力文の先頭20文字(改行・記号除去)+`_`+3桁連番。連番は同じベース名の既存数+1。
- カット時は元ファイルを `{id}.wav.bak` に退避(1段階アンドゥ用)。新カットで上書き。

## REST API(app/routers/api.py)

すべて JSON。エラーは FastAPI 標準 `{"detail": "..."}`。

### GET /api/status
`{"model_loaded": bool, "model_loading": bool, "model_error": str|null, "translator_ok": bool, "device": "cuda"}`
(translator_ok は LLM サーバへの疎通結果。キャッシュ可)

### GET /api/presets
`[{"id": "explosion", "label": "爆発", "category": "ゲーム・バトル", "prompt": "a powerful explosion with deep rumbling debris", "duration": 4.0}, ...]`

### POST /api/generate
Body: `{"prompt": str?, "preset_id": str?, "duration": float?, "name": str?, "seed": int?, "steps": int?, "cfg_scale": float?, "negative_prompt": str?}`
- `prompt` か `preset_id` のどちらか必須(両方あれば prompt 優先、source は custom)。
- `duration`: 0.5〜120。省略時: プリセットの既定値 or 5.0。
- `seed`: 省略/負値ならランダム。実際に使われたseedはレスポンスの`seed`で返る(再現用に控えておける)。
- `steps`: 1〜100(省略時8)。拡散ステップ数。多いほど高品質だが生成が遅い。
- `cfg_scale`: 0.1〜10(省略時1.0)。プロンプトへの追従度合い(classifier-free guidance)。高いほどプロンプト通りになるが不自然になりやすい。
- `negative_prompt`: 含めたくない要素の説明(日本語可、自動翻訳)。
- 処理: 翻訳(必要時、prompt/negative_prompt両方)→ 生成 → WAV保存 → DB登録。
- 200: Sound オブジェクト(下記)。モデル未ロード: 503。翻訳サーバ不通: 503。バリデーション: 422/400。

Sound オブジェクト:
```json
{"id": "...", "name": "爆発_001", "prompt_original": "...", "prompt_en": "...",
 "source": "explosion", "duration_s": 4.0, "sample_rate": 44100,
 "url": "/api/sounds/{id}/audio", "created_at": "...", "has_backup": false,
 "seed": 12345, "steps": 8, "cfg_scale": 1.0, "negative_prompt": null}
```

### GET /api/sounds
`[Sound, ...]` 新しい順。

### GET /api/sounds/{id}
Sound。404 あり。

### GET /api/sounds/{id}/audio?download=0|1
WAV を返す(`audio/wav`)。`download=1` で `Content-Disposition: attachment; filename*=UTF-8''{name}.wav`。

### PATCH /api/sounds/{id}
Body: `{"name": str}` → 改名(重複時 `_2` 付与)。更新後 Sound を返す。

### DELETE /api/sounds/{id}
ファイル+バックアップ+DB行を削除。204。

### POST /api/sounds/{id}/cut
Body: `{"start_s": float, "end_s": float}` — この区間を**削除**して前後を連結。
バリデーション: 0 <= start < end <= duration、結果が 0.1s 未満なら 400。
元ファイルを .bak に退避 → 更新後 Sound を返す(`has_backup: true`)。

### POST /api/sounds/{id}/gain
Body: `{"gain_db": float}`(-24〜+24)または `{"normalize": true}`(ピークを0.99に最大化)。
処理前に .bak 退避(1段階アンドゥ対象)。クリップは [-1,1] に飽和。ほぼ無音のnormalizeは400。更新後 Sound を返す。

### POST /api/sounds/{id}/undo
.bak があれば復元(duration_s も戻す)。無ければ 404。更新後 Sound を返す。

### GET /
`static/index.html` を返す。`/static/*` は StaticFiles マウント。

### CORS
外部アプリから呼べるよう `CORSMiddleware` で allow_origins=["*"](ローカル用途)。

## プリセット(app/presets.py、約40種)

カテゴリ: 自然 / 動物 / 生活 / 人 / 機械・乗り物 / ゲーム・バトル
各: id(英小文字snake)、label(日本語)、category、prompt(英語、効果音向けに具体的な描写)、duration(2〜8秒程度)。
例: 雨(rain)、雷(thunder)、風(wind)、川(river)、波(waves)、焚き火(campfire)、犬(dog_bark)、猫(cat_meow)、小鳥(birds)、カラス(crow)、セミ(cicada)、ドア開(door_open)、ドア閉(door_close)、ノック(knock)、足音(footsteps)、ガラス割れ(glass_break)、電話(phone_ring)、時計(clock_tick)、チャイム(doorbell)、キーボード(keyboard)、カメラ(camera)、拍手(applause)、歓声(cheer)、笑い声(laugh)、心拍(heartbeat)、車エンジン(car_engine)、クラクション(car_horn)、電車(train)、サイレン(siren)、ヘリ(helicopter)、ロボット(robot)、クリック(click)、コイン(coin)、レベルアップ(level_up)、レーザー(laser)、爆発(explosion)、パンチ(punch)、剣(sword)、魔法(magic)、パワーアップ(power_up)、エラー音(error_beep) …

## フロントエンド(static/)

素の HTML/CSS/JS(ES modules)。外部CDN禁止(wavesurfer は vendor/ に同梱、ESM import)。

レイアウト(1ページ、ダーク基調のモダンなUI、日本語):
1. **ヘッダー**: タイトル + モデル状態バッジ(読込中… / 準備完了 / エラー詳細ツールチップ)。`/api/status` を2秒間隔ポーリング(loaded になったら停止)。
2. **生成パネル**:
   - カテゴリタブ + プリセットボタングリッド(ボタン押下で即 `POST /api/generate {preset_id}`)
   - 自由入力: テキスト(placeholder「例: 錆びた金属のドアがきしみながら開く音(日本語OK)」)+ 長さスライダー(0.5〜30s、数値表示)+ 名前(任意)+ 生成ボタン
   - 生成中はボタン無効化+スピナー。複数連打防止。
3. **確認エリア(コンパクト、高さ~160px)**: wavesurfer.js v7 + regions プラグイン。
   - 波形表示、再生/一時停止、ドラッグで範囲選択 →「選択範囲をカット」ボタンで `POST .../cut` → 波形リロード
   - 「元に戻す」(has_backup 時のみ有効)、ダウンロードボタン、名前のインライン編集
4. **生成音一覧**: テーブル/リスト(名前、長さ、作成日時、▶再生(確認エリアに読込)、ダウンロード、改名、削除ボタン)。生成のたびに更新。個別削除は confirm。
5. **フッター**: 「Powered by Stability AI」(https://stability.ai へのリンク)。

wavesurfer v7 ESM の regions 使用例:
```js
import WaveSurfer from './vendor/wavesurfer.esm.js';
import RegionsPlugin from './vendor/regions.esm.js';
const regions = RegionsPlugin.create();
const ws = WaveSurfer.create({ container, url, plugins: [regions] });
regions.enableDragSelection({});
```

## 起動方法

- 単独起動: `./venv/bin/python -m app.main`(uvicorn.run を main.py 内で呼ぶ。--host/--port/--reload を argparse で)
- または: `./venv/bin/uvicorn app.main:app --port 8600`
- README.md に起動方法・API一覧・ライセンス表記(Stability AI Community License、「Powered by Stability AI」)を記載。
