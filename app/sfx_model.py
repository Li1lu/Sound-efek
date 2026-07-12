"""StableAudioModel wrapper: background load + serialized inference.

Real API confirmed by reading venv/lib/python3.12/site-packages/stable_audio_3/model.py:
- StableAudioModel.from_pretrained(model_name, device=None, model_half=True) -> StableAudioModel
- model.generate(prompt=str, duration=float, seed=int (-1=random), steps=int, ...) -> torch.Tensor
  shaped (batch, channels, samples), float in [-1, 1].
- Sample rate is available as model.model.sample_rate (the underlying diffusion_cond model).
- Gated repo (HF license not accepted) raises huggingface_hub.errors.GatedRepoError (403).
"""
import logging
import threading

import numpy as np
import torch

from app.config import settings

logger = logging.getLogger(__name__)

GATE_HINT = (
    "https://huggingface.co/stabilityai/stable-audio-3-small-sfx でライセンス同意が必要です"
)


class SfxModel:
    def __init__(self):
        self.model = None
        self.sample_rate: int | None = None
        self.loading = True
        self.error: str | None = None
        self._infer_lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        try:
            from stable_audio_3 import StableAudioModel

            model = StableAudioModel.from_pretrained(settings.model, device=settings.device)
            self.sample_rate = model.model.sample_rate
            self.model = model
            logger.info("model loaded: %s (sr=%s)", settings.model, self.sample_rate)
        except Exception as exc:  # noqa: BLE001 - want to surface any load failure
            msg = str(exc)
            if type(exc).__name__ == "GatedRepoError" or "403" in msg:
                msg = f"{msg}\n{GATE_HINT}"
            self.error = msg
            logger.error("model load failed: %s", msg)
        finally:
            self.loading = False

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def generate(
        self,
        prompt: str,
        duration: float,
        seed: int | None = None,
        steps: int | None = None,
        cfg_scale: float | None = None,
        negative_prompt: str | None = None,
    ) -> tuple[np.ndarray, int, int]:
        """Returns (audio, sample_rate, seed_used). audio shaped (samples, channels), float32.

        seed is resolved here (rather than left to the library's internal -1-means-random
        handling) so the actual seed used can be reported back and reused later.
        """
        if self.model is None:
            raise RuntimeError("model not loaded")

        seed_used = seed if seed is not None and seed >= 0 else int(np.random.randint(0, 2**31 - 1))

        kwargs = {}
        if steps is not None:
            kwargs["steps"] = steps
        if cfg_scale is not None:
            kwargs["cfg_scale"] = cfg_scale
        if negative_prompt:
            kwargs["negative_prompt"] = negative_prompt

        with self._infer_lock:
            result = self.model.generate(prompt=prompt, duration=duration, seed=seed_used, **kwargs)

        # result: (batch, channels, samples) -> take first item, transpose to (samples, channels)
        audio = result[0].to(torch.float32).cpu().numpy()
        audio = np.ascontiguousarray(audio.T)
        return audio, self.sample_rate, seed_used


sfx_model = SfxModel()
