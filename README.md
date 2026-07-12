# SFX Generator

Stable Audio 3 Small SFX を使ったローカル効果音生成アプリ。
バックエンド: FastAPI(単独起動、外部アプリからREST呼び出し可)。フロントエンド: 静的SPA(FastAPIが配信)。

## 起動方法

```bash
cd /home/animede/sound-efect
./venv/bin/python -m app.main                  # host/port は既定値(0.0.0.0:8600)
./venv/bin/python -m app.main --port 8080       # ポート変更
./venv/bin/python -m app.main --reload          # 開発用オートリロード
# または
./venv/bin/uvicorn app.main:app --port 8600
```

ブラウザで `http://<host>:8600/` を開く。

初回起動時、`stable_audio_3.StableAudioModel.from_pretrained("small-sfx")` がバックグラウンドスレッドで
Hugging Face からモデルをダウンロードする。[stabilityai/stable-audio-3-small-sfx](https://huggingface.co/stabilityai/stable-audio-3-small-sfx)
のゲート(ライセンス同意)が未承認だと 403 で失敗し、そのエラーは `/api/status` の `model_error` に保持される
(生成エンドポイントは 503 を返す)。承認後は `huggingface-cli login` 等でトークンを設定してから再起動すること。

## 設定(環境変数)

| 変数 | 既定値 | 説明 |
|---|---|---|
| `SFX_HOST` | `0.0.0.0` | 待受ホスト |
| `SFX_PORT` | `8600` | 待受ポート |
| `SFX_MODEL` | `small-sfx` | `StableAudioModel.from_pretrained` に渡すモデル名 |
| `SFX_DEVICE` | `cuda` | `cuda` / `cpu` |
| `SFX_DATA_DIR` | `./generated` | WAV と `sounds.db` の置き場所 |
| `SFX_LLM_URL` | `http://127.0.0.1:64652/v1` | 翻訳用ローカルLLM(OpenAI互換API) |
| `SFX_LLM_MODEL` | `unsloth/gemma-4-E4B-it-GGUF` | 翻訳に使うモデル名 |

## API 一覧

すべて JSON。エラーは `{"detail": "..."}`。

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/status` | モデル/翻訳サーバの状態 |
| GET | `/api/presets` | プリセット一覧(約40種) |
| POST | `/api/generate` | 効果音を生成(`prompt` または `preset_id`) |
| GET | `/api/sounds` | 生成済み一覧(新しい順) |
| GET | `/api/sounds/{id}` | 1件取得 |
| GET | `/api/sounds/{id}/audio?download=0\|1` | WAV 取得/ダウンロード |
| PATCH | `/api/sounds/{id}` | 改名(`{"name": "..."}`) |
| DELETE | `/api/sounds/{id}` | 削除 |
| POST | `/api/sounds/{id}/cut` | 区間削除(`{"start_s", "end_s"}`) |
| POST | `/api/sounds/{id}/undo` | 直前のカットを1段階アンドゥ |
| GET | `/` | `static/index.html` を配信 |

詳細な仕様(リクエスト/レスポンスの形状、バリデーション)は [`docs/DESIGN.md`](docs/DESIGN.md) を参照。

## ディレクトリ構成

```
app/            FastAPI バックエンド
  main.py       起動エントリポイント
  config.py     設定(環境変数)
  sfx_model.py  StableAudioModel ラッパー
  translate.py  日本語→英語翻訳
  store.py      SQLite + WAV 管理
  presets.py    プリセット定義
  routers/api.py  /api/* エンドポイント
static/         フロントエンド(素のHTML/CSS/JS, wavesurfer.js vendor同梱)
generated/      生成された WAV と sounds.db(git管理外)
docs/DESIGN.md  API契約
```

## ライセンス

本アプリは音声生成に [Stability AI](https://stability.ai) の Stable Audio 3 Small SFX モデルを使用しています。

**Powered by [Stability AI](https://stability.ai)**

モデル本体は [Stability AI Community License](https://huggingface.co/stabilityai/stable-audio-3-small-sfx/blob/main/LICENSE.md)
の下で提供されており、利用にはライセンスへの同意(Hugging Face 上でのゲート承認)が必要です。
本リポジトリのアプリケーションコード自体のライセンスはモデルのライセンスとは別です。
