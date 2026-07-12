"""SQLite metadata + WAV file management for generated sounds."""
import re
import shutil
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from app.config import settings

DB_PATH = settings.data_dir / "sounds.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sounds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt_original TEXT NOT NULL,
  prompt_en TEXT NOT NULL,
  source TEXT NOT NULL,
  duration_s REAL NOT NULL,
  sample_rate INTEGER NOT NULL,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL
)
"""

# name -> column definition, added via ALTER TABLE if missing (schema migration for
# generation-parameter fields added after the initial release).
_EXTRA_COLUMNS = {
    "seed": "INTEGER",
    "steps": "INTEGER",
    "cfg_scale": "REAL",
    "negative_prompt": "TEXT",
}

_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _lock:
        conn = _connect()
        try:
            conn.execute(SCHEMA)
            existing = {row["name"] for row in conn.execute("PRAGMA table_info(sounds)")}
            for col, col_type in _EXTRA_COLUMNS.items():
                if col not in existing:
                    conn.execute(f"ALTER TABLE sounds ADD COLUMN {col} {col_type}")
            conn.commit()
        finally:
            conn.close()


def _wav_path(sound_id: str) -> Path:
    return settings.data_dir / f"{sound_id}.wav"


def _bak_path(sound_id: str) -> Path:
    return settings.data_dir / f"{sound_id}.wav.bak"


def wav_path(sound_id: str) -> Path:
    return _wav_path(sound_id)


def row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "prompt_original": row["prompt_original"],
        "prompt_en": row["prompt_en"],
        "source": row["source"],
        "duration_s": row["duration_s"],
        "sample_rate": row["sample_rate"],
        "url": f"/api/sounds/{row['id']}/audio",
        "created_at": row["created_at"],
        "has_backup": _bak_path(row["id"]).exists(),
        "seed": row["seed"],
        "steps": row["steps"],
        "cfg_scale": row["cfg_scale"],
        "negative_prompt": row["negative_prompt"],
    }


_SYMBOL_RE = re.compile(r"[^\w\s]", re.UNICODE)
_NEWLINE_RE = re.compile(r"[\r\n]+")


def clean_free_text_base(text: str) -> str:
    """Strip newlines/symbols, then take first 20 chars, for auto-naming free-input sounds."""
    t = _NEWLINE_RE.sub(" ", text)
    t = _SYMBOL_RE.sub("", t)
    t = t.strip()
    if not t:
        t = "sound"
    return t[:20]


def _unique_exact_name(conn: sqlite3.Connection, name: str, exclude_id: Optional[str] = None) -> str:
    """Dedup an explicitly-given name by appending _2, _3, ..."""
    rows = conn.execute("SELECT id, name FROM sounds").fetchall()
    existing = {r["name"] for r in rows if r["id"] != exclude_id}
    if name not in existing:
        return name
    n = 2
    while f"{name}_{n}" in existing:
        n += 1
    return f"{name}_{n}"


def _next_auto_name(conn: sqlite3.Connection, base: str) -> str:
    """base + '_' + 3-digit sequence, sequence = existing count with this base + 1."""
    count = conn.execute(
        "SELECT COUNT(*) FROM sounds WHERE name LIKE ? ESCAPE '\\'",
        (base.replace("\\", "\\\\").replace("_", "\\_").replace("%", "\\%") + "\\_%",),
    ).fetchone()[0]
    seq = count + 1
    return f"{base}_{seq:03d}"


def create_sound(
    *,
    prompt_original: str,
    prompt_en: str,
    source: str,
    duration_s: float,
    sample_rate: int,
    audio: np.ndarray,
    name: Optional[str] = None,
    preset_label: Optional[str] = None,
    seed: Optional[int] = None,
    steps: Optional[int] = None,
    cfg_scale: Optional[float] = None,
    negative_prompt: Optional[str] = None,
) -> dict:
    """audio: numpy array shaped (samples, channels), float32 in [-1, 1]."""
    sound_id = uuid.uuid4().hex
    filename = f"{sound_id}.wav"

    with _lock:
        conn = _connect()
        try:
            if name:
                final_name = _unique_exact_name(conn, name)
            else:
                base = preset_label if preset_label else clean_free_text_base(prompt_original)
                final_name = _next_auto_name(conn, base)

            sf.write(str(_wav_path(sound_id)), audio, sample_rate, subtype="PCM_16")

            created_at = datetime.now(timezone.utc).isoformat()
            conn.execute(
                "INSERT INTO sounds (id, name, prompt_original, prompt_en, source, "
                "duration_s, sample_rate, filename, created_at, seed, steps, cfg_scale, "
                "negative_prompt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (sound_id, final_name, prompt_original, prompt_en, source,
                 round(duration_s, 3), sample_rate, filename, created_at,
                 seed, steps, cfg_scale, negative_prompt),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM sounds WHERE id = ?", (sound_id,)).fetchone()
            return row_to_dict(row)
        finally:
            conn.close()


def list_sounds() -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM sounds ORDER BY created_at DESC").fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_sound(sound_id: str) -> Optional[dict]:
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM sounds WHERE id = ?", (sound_id,)).fetchone()
        return row_to_dict(row) if row else None
    finally:
        conn.close()


def _get_row(conn: sqlite3.Connection, sound_id: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM sounds WHERE id = ?", (sound_id,)).fetchone()


def rename_sound(sound_id: str, new_name: str) -> Optional[dict]:
    with _lock:
        conn = _connect()
        try:
            row = _get_row(conn, sound_id)
            if row is None:
                return None
            final_name = _unique_exact_name(conn, new_name, exclude_id=sound_id)
            conn.execute("UPDATE sounds SET name = ? WHERE id = ?", (final_name, sound_id))
            conn.commit()
            row = _get_row(conn, sound_id)
            return row_to_dict(row)
        finally:
            conn.close()


def delete_sound(sound_id: str) -> bool:
    with _lock:
        conn = _connect()
        try:
            row = _get_row(conn, sound_id)
            if row is None:
                return False
            _wav_path(sound_id).unlink(missing_ok=True)
            _bak_path(sound_id).unlink(missing_ok=True)
            conn.execute("DELETE FROM sounds WHERE id = ?", (sound_id,))
            conn.commit()
            return True
        finally:
            conn.close()


class CutError(Exception):
    pass


def cut_sound(sound_id: str, start_s: float, end_s: float) -> Optional[dict]:
    """Delete [start_s, end_s) from the audio and splice the rest together."""
    with _lock:
        conn = _connect()
        try:
            row = _get_row(conn, sound_id)
            if row is None:
                return None

            duration = row["duration_s"]
            if not (0 <= start_s < end_s <= duration):
                raise CutError("invalid range: 0 <= start_s < end_s <= duration_s")

            path = _wav_path(sound_id)
            data, sr = sf.read(str(path), dtype="float32", always_2d=True)
            n = data.shape[0]
            start_sample = min(int(round(start_s * sr)), n)
            end_sample = min(int(round(end_s * sr)), n)

            new_data = np.concatenate([data[:start_sample], data[end_sample:]], axis=0)
            new_duration = new_data.shape[0] / sr
            if new_duration < 0.1:
                raise CutError("resulting duration would be under 0.1s")

            shutil.copy2(path, _bak_path(sound_id))
            sf.write(str(path), new_data, sr, subtype="PCM_16")

            conn.execute(
                "UPDATE sounds SET duration_s = ? WHERE id = ?",
                (round(new_duration, 3), sound_id),
            )
            conn.commit()
            row = _get_row(conn, sound_id)
            return row_to_dict(row)
        finally:
            conn.close()


class GainError(Exception):
    pass


def gain_sound(sound_id: str, gain_db: Optional[float] = None, normalize: bool = False) -> Optional[dict]:
    """Amplify/attenuate the audio. normalize=True scales the peak to 0.99."""
    with _lock:
        conn = _connect()
        try:
            row = _get_row(conn, sound_id)
            if row is None:
                return None

            path = _wav_path(sound_id)
            data, sr = sf.read(str(path), dtype="float32", always_2d=True)
            peak = float(np.abs(data).max())

            if normalize:
                if peak < 1e-6:
                    raise GainError("ほぼ無音のためノーマライズできません")
                factor = 0.99 / peak
            else:
                factor = float(10 ** (gain_db / 20.0))

            new_data = np.clip(data * factor, -1.0, 1.0)

            shutil.copy2(path, _bak_path(sound_id))
            sf.write(str(path), new_data, sr, subtype="PCM_16")

            return row_to_dict(_get_row(conn, sound_id))
        finally:
            conn.close()


def undo_sound(sound_id: str) -> Optional[dict]:
    with _lock:
        conn = _connect()
        try:
            row = _get_row(conn, sound_id)
            if row is None:
                return None
            bak = _bak_path(sound_id)
            if not bak.exists():
                raise FileNotFoundError("no backup available")

            path = _wav_path(sound_id)
            shutil.move(str(bak), str(path))
            info = sf.info(str(path))
            duration = info.frames / info.samplerate

            conn.execute(
                "UPDATE sounds SET duration_s = ? WHERE id = ?",
                (round(duration, 3), sound_id),
            )
            conn.commit()
            row = _get_row(conn, sound_id)
            return row_to_dict(row)
        finally:
            conn.close()
