"""/api/* endpoints."""
from typing import Optional
from urllib.parse import quote

import anyio
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import store, translate
from app.config import settings
from app.presets import PRESETS, PRESETS_BY_ID
from app.sfx_model import sfx_model

router = APIRouter(prefix="/api")


class GenerateRequest(BaseModel):
    prompt: Optional[str] = None
    preset_id: Optional[str] = None
    duration: Optional[float] = None
    name: Optional[str] = None
    seed: Optional[int] = None
    steps: Optional[int] = None
    cfg_scale: Optional[float] = None
    negative_prompt: Optional[str] = None


class RenameRequest(BaseModel):
    name: str


class CutRequest(BaseModel):
    start_s: float
    end_s: float


class GainRequest(BaseModel):
    gain_db: Optional[float] = None
    normalize: bool = False


@router.get("/status")
async def get_status():
    translator_ok = await translate.check_translator_ok()
    return {
        "model_loaded": sfx_model.loaded,
        "model_loading": sfx_model.loading,
        "model_error": sfx_model.error,
        "translator_ok": translator_ok,
        "device": settings.device,
    }


@router.get("/presets")
async def get_presets():
    return PRESETS


@router.post("/generate")
async def generate_sound(body: GenerateRequest):
    if not body.prompt and not body.preset_id:
        raise HTTPException(400, "prompt or preset_id is required")

    preset = PRESETS_BY_ID.get(body.preset_id) if body.preset_id else None
    if body.preset_id and preset is None and not body.prompt:
        raise HTTPException(400, f"unknown preset_id: {body.preset_id}")

    if body.prompt:
        prompt_original = body.prompt
        source = "custom"
        duration = body.duration if body.duration is not None else 5.0
        preset_label = None
    else:
        prompt_original = preset["prompt"]
        source = preset["id"]
        duration = body.duration if body.duration is not None else preset.get("duration", 5.0)
        preset_label = preset["label"]

    if not (0.5 <= duration <= 120):
        raise HTTPException(422, "duration must be between 0.5 and 120")
    if body.steps is not None and not (1 <= body.steps <= 100):
        raise HTTPException(422, "steps must be between 1 and 100")
    if body.cfg_scale is not None and not (0.1 <= body.cfg_scale <= 10):
        raise HTTPException(422, "cfg_scale must be between 0.1 and 10")

    async def _translate(text: str) -> str:
        if translate.needs_translation(text):
            try:
                return await translate.translate_to_english(text)
            except Exception:
                raise HTTPException(503, "翻訳サーバに接続できません。ローカルLLMの起動状態を確認してください。")
        return text

    prompt_en = await _translate(prompt_original)
    negative_prompt_en = await _translate(body.negative_prompt) if body.negative_prompt else None

    if not sfx_model.loaded:
        detail = "モデルが読み込まれていません"
        if sfx_model.error:
            detail += f": {sfx_model.error}"
        raise HTTPException(503, detail)

    def _run():
        return sfx_model.generate(
            prompt_en,
            duration,
            seed=body.seed,
            steps=body.steps,
            cfg_scale=body.cfg_scale,
            negative_prompt=negative_prompt_en,
        )

    try:
        audio, sample_rate, seed_used = await anyio.to_thread.run_sync(_run)
    except RuntimeError as e:
        raise HTTPException(503, str(e))

    sound = store.create_sound(
        prompt_original=prompt_original,
        prompt_en=prompt_en,
        source=source,
        duration_s=audio.shape[0] / sample_rate,
        sample_rate=sample_rate,
        audio=audio,
        name=body.name,
        preset_label=preset_label,
        seed=seed_used,
        steps=body.steps if body.steps is not None else 8,
        cfg_scale=body.cfg_scale if body.cfg_scale is not None else 1.0,
        negative_prompt=negative_prompt_en,
    )
    return sound


@router.get("/sounds")
async def list_sounds():
    return store.list_sounds()


@router.get("/sounds/{sound_id}")
async def get_sound(sound_id: str):
    sound = store.get_sound(sound_id)
    if sound is None:
        raise HTTPException(404, "sound not found")
    return sound


@router.get("/sounds/{sound_id}/audio")
async def get_audio(sound_id: str, download: int = Query(0)):
    sound = store.get_sound(sound_id)
    if sound is None:
        raise HTTPException(404, "sound not found")
    path = store.wav_path(sound_id)
    if not path.exists():
        raise HTTPException(404, "audio file not found")
    headers = None
    if download:
        quoted = quote(f"{sound['name']}.wav")
        headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"}
    return FileResponse(path, media_type="audio/wav", headers=headers)


@router.patch("/sounds/{sound_id}")
async def rename_sound(sound_id: str, body: RenameRequest):
    sound = store.rename_sound(sound_id, body.name)
    if sound is None:
        raise HTTPException(404, "sound not found")
    return sound


@router.delete("/sounds/{sound_id}", status_code=204)
async def delete_sound(sound_id: str):
    ok = store.delete_sound(sound_id)
    if not ok:
        raise HTTPException(404, "sound not found")


@router.post("/sounds/{sound_id}/cut")
async def cut_sound(sound_id: str, body: CutRequest):
    try:
        sound = store.cut_sound(sound_id, body.start_s, body.end_s)
    except store.CutError as e:
        raise HTTPException(400, str(e))
    if sound is None:
        raise HTTPException(404, "sound not found")
    return sound


@router.post("/sounds/{sound_id}/gain")
async def gain_sound(sound_id: str, body: GainRequest):
    if not body.normalize:
        if body.gain_db is None:
            raise HTTPException(400, "gain_db or normalize is required")
        if not (-24 <= body.gain_db <= 24):
            raise HTTPException(422, "gain_db must be between -24 and 24")
    try:
        sound = store.gain_sound(sound_id, gain_db=body.gain_db, normalize=body.normalize)
    except store.GainError as e:
        raise HTTPException(400, str(e))
    if sound is None:
        raise HTTPException(404, "sound not found")
    return sound


@router.post("/sounds/{sound_id}/undo")
async def undo_sound(sound_id: str):
    try:
        sound = store.undo_sound(sound_id)
    except FileNotFoundError:
        raise HTTPException(404, "no backup available")
    if sound is None:
        raise HTTPException(404, "sound not found")
    return sound
