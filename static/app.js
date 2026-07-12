// ============================================================================
// SFX Generator - フロントエンドロジック
// 素の ES modules。フレームワーク不使用。API契約は docs/DESIGN.md 準拠。
// ============================================================================

import WaveSurfer from "./vendor/wavesurfer.esm.js";
import RegionsPlugin from "./vendor/regions.esm.js";

// ----------------------------------------------------------------------------
// 定数 / 状態
// ----------------------------------------------------------------------------

const STATUS_POLL_INTERVAL_MS = 2000;

const CATEGORY_ICONS = {
  "自然": "🌿",
  "動物": "🐾",
  "生活": "🏠",
  "人": "👏",
  "機械・乗り物": "🚗",
  "ゲーム・バトル": "🎮",
};

const state = {
  presets: [], // [{id, label, category, prompt, duration}]
  categories: [],
  activeCategory: null,
  sounds: [], // 一覧(GET /api/sounds の結果)
  currentSound: null, // 確認エリアに表示中の Sound
  lastPreset: null, // 直近にクリックしたプリセット({id, label, ...})。生成ボタンの再生成先。
  isGenerating: false,
  statusTimerId: null,
  modelLoaded: false,
};

let wavesurfer = null;
let regionsPlugin = null;
let activeRegion = null;

// ----------------------------------------------------------------------------
// DOM参照
// ----------------------------------------------------------------------------

const el = {
  toastRoot: document.getElementById("toast-root"),
  modelStatus: document.getElementById("model-status"),
  categoryTabs: document.getElementById("category-tabs"),
  presetGrid: document.getElementById("preset-grid"),
  customPrompt: document.getElementById("custom-prompt"),
  durationSlider: document.getElementById("duration-slider"),
  durationValue: document.getElementById("duration-value"),
  customName: document.getElementById("custom-name"),
  advSeed: document.getElementById("adv-seed"),
  advSteps: document.getElementById("adv-steps"),
  advStepsValue: document.getElementById("adv-steps-value"),
  advCfg: document.getElementById("adv-cfg"),
  advCfgValue: document.getElementById("adv-cfg-value"),
  advNegative: document.getElementById("adv-negative"),
  generateBtn: document.getElementById("generate-btn"),
  previewEmpty: document.getElementById("preview-empty"),
  previewContent: document.getElementById("preview-content"),
  previewName: document.getElementById("preview-name"),
  previewNameInput: document.getElementById("preview-name-input"),
  previewParams: document.getElementById("preview-params"),
  waveformContainer: document.getElementById("waveform"),
  playBtn: document.getElementById("play-btn"),
  selectionInfo: document.getElementById("selection-info"),
  cutBtn: document.getElementById("cut-btn"),
  gainDownBtn: document.getElementById("gain-down-btn"),
  gainUpBtn: document.getElementById("gain-up-btn"),
  normalizeBtn: document.getElementById("normalize-btn"),
  undoBtn: document.getElementById("undo-btn"),
  downloadBtn: document.getElementById("download-btn"),
  soundListBody: document.getElementById("sound-list-body"),
};

// ----------------------------------------------------------------------------
// トースト
// ----------------------------------------------------------------------------

const TOAST_ICONS = { info: "ℹ️", success: "✅", error: "⚠️" };

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  const icon = document.createElement("span");
  icon.className = "toast__icon";
  icon.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(icon);
  toast.appendChild(text);
  el.toastRoot.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast--leaving");
    setTimeout(() => toast.remove(), 200);
  }, 5000);
}

// ----------------------------------------------------------------------------
// API ヘルパー
// ----------------------------------------------------------------------------

/**
 * fetch のラッパー。エラー時は detail を含むトーストを表示し例外を投げる。
 */
async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    const msg = "サーバーに接続できません。バックエンドが起動しているか確認してください。";
    showToast(msg, "error");
    throw new Error(msg);
  }

  if (!res.ok) {
    let detail = `エラーが発生しました (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body && body.detail) {
        detail = body.detail;
      }
    } catch (_e) {
      // JSONでなければデフォルトメッセージのまま
    }
    showToast(detail, "error");
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }

  if (res.status === 204) {
    return null;
  }
  return res.json();
}

// ----------------------------------------------------------------------------
// モデル状態ポーリング
// ----------------------------------------------------------------------------

function setStatusBadge(mode, text, title = "") {
  el.modelStatus.className = `status-badge status-badge--${mode}`;
  el.modelStatus.querySelector(".status-badge__text").textContent = text;
  el.modelStatus.title = title;
}

async function pollStatus() {
  try {
    const status = await fetchStatusQuiet();
    if (!status) return;

    if (status.model_error) {
      setStatusBadge("error", `エラー: ${status.model_error}`, status.model_error);
      state.modelLoaded = false;
      stopStatusPolling();
      return;
    }

    if (status.model_loaded) {
      setStatusBadge("ready", "準備完了");
      state.modelLoaded = true;
      stopStatusPolling();
      return;
    }

    if (status.model_loading) {
      setStatusBadge("loading", "モデル読込中…");
      state.modelLoaded = false;
    }

    if (status.translator_ok === false) {
      // 翻訳サーバ不通は致命的ではないため、バッジのtitleに補足する程度に留める
    }
  } catch (_e) {
    setStatusBadge("error", "状態取得に失敗しました");
  }
}

/** トースト無しで /api/status を取得(ポーリング用、通信断でトースト連発しないように) */
async function fetchStatusQuiet() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null;
  }
}

function startStatusPolling() {
  pollStatus();
  state.statusTimerId = setInterval(pollStatus, STATUS_POLL_INTERVAL_MS);
}

function stopStatusPolling() {
  if (state.statusTimerId !== null) {
    clearInterval(state.statusTimerId);
    state.statusTimerId = null;
  }
}

// ----------------------------------------------------------------------------
// プリセット
// ----------------------------------------------------------------------------

async function loadPresets() {
  try {
    const presets = await apiFetch("/api/presets");
    state.presets = presets;
    state.categories = [...new Set(presets.map((p) => p.category))];
    state.activeCategory = state.categories[0] || null;
    renderCategoryTabs();
    renderPresetGrid();
  } catch (_e) {
    // apiFetchが既にトースト表示済み
  }
}

function renderCategoryTabs() {
  el.categoryTabs.innerHTML = "";
  state.categories.forEach((category) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn" + (category === state.activeCategory ? " is-active" : "");
    btn.dataset.category = category;
    const icon = CATEGORY_ICONS[category];
    btn.textContent = icon ? `${icon} ${category}` : category;
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => {
      state.activeCategory = category;
      renderCategoryTabs();
      renderPresetGrid();
    });
    el.categoryTabs.appendChild(btn);
  });
}

function renderPresetGrid() {
  el.presetGrid.innerHTML = "";
  el.presetGrid.dataset.category = state.activeCategory || "";
  const presets = state.presets.filter((p) => p.category === state.activeCategory);
  presets.forEach((preset) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn";
    btn.dataset.presetId = preset.id;
    const label = document.createElement("span");
    label.textContent = preset.label;
    const spinner = document.createElement("span");
    spinner.className = "spinner spinner--hidden spinner--dark";
    btn.appendChild(label);
    btn.appendChild(spinner);
    btn.addEventListener("click", () => handlePresetClick(preset, btn));
    el.presetGrid.appendChild(btn);
  });
}

/** 詳細設定パネルの現在値を生成リクエストに追加できる形で返す(未指定項目は省略)。 */
function collectAdvancedParams() {
  const params = {};
  const seed = el.advSeed.value.trim();
  if (seed !== "") params.seed = parseInt(seed, 10);
  const steps = parseInt(el.advSteps.value, 10);
  if (steps !== 8) params.steps = steps;
  const cfgScale = parseFloat(el.advCfg.value);
  if (Math.abs(cfgScale - 1.0) > 1e-9) params.cfg_scale = cfgScale;
  const negative = el.advNegative.value.trim();
  if (negative) params.negative_prompt = negative;
  return params;
}

function handlePresetClick(preset, btn) {
  state.lastPreset = preset;
  updateGenerateButtonLabel();
  generateSound({ preset_id: preset.id, ...collectAdvancedParams() }, btn);
}

// ----------------------------------------------------------------------------
// 生成
// ----------------------------------------------------------------------------

function setAllGenerateControlsDisabled(disabled) {
  el.generateBtn.disabled = disabled;
  el.presetGrid.querySelectorAll(".preset-btn").forEach((b) => {
    b.disabled = disabled;
  });
}

function setButtonSpinner(btn, show) {
  const spinner = btn.querySelector(".spinner");
  if (spinner) {
    spinner.classList.toggle("spinner--hidden", !show);
  }
}

async function generateSound(payload, triggerBtn) {
  if (state.isGenerating) return;
  state.isGenerating = true;
  setAllGenerateControlsDisabled(true);
  if (triggerBtn) setButtonSpinner(triggerBtn, true);

  try {
    const sound = await apiFetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast(`「${sound.name}」を生成しました`, "success");
    await loadSoundList();
    loadSoundIntoPreview(sound);
  } catch (_e) {
    // apiFetchが既にトースト表示済み
  } finally {
    state.isGenerating = false;
    setAllGenerateControlsDisabled(false);
    if (triggerBtn) setButtonSpinner(triggerBtn, false);
  }
}

function handleCustomGenerateClick() {
  const prompt = el.customPrompt.value.trim();

  if (!prompt) {
    // テキスト未入力時は、直前に使ったプリセットを現在の詳細設定で再生成する
    if (state.lastPreset) {
      generateSound({ preset_id: state.lastPreset.id, ...collectAdvancedParams() }, el.generateBtn);
      return;
    }
    showToast("プロンプトを入力するか、プリセットを一度選択してください", "error");
    return;
  }

  const duration = parseFloat(el.durationSlider.value);
  const name = el.customName.value.trim();
  const payload = { prompt, duration, ...collectAdvancedParams() };
  if (name) payload.name = name;

  generateSound(payload, el.generateBtn);
}

/** テキスト未入力時、生成ボタンのラベルを「直前のプリセットを再生成」の旨に切り替える。 */
function updateGenerateButtonLabel() {
  const label = el.generateBtn.querySelector(".btn__label");
  if (!label) return;
  const prompt = el.customPrompt.value.trim();
  if (!prompt && state.lastPreset) {
    label.textContent = `🔁「${state.lastPreset.label}」を再生成`;
  } else {
    label.textContent = "生成";
  }
}

// ----------------------------------------------------------------------------
// 生成音一覧
// ----------------------------------------------------------------------------

async function loadSoundList() {
  try {
    const sounds = await apiFetch("/api/sounds");
    state.sounds = sounds;
    renderSoundList();
  } catch (_e) {
    // apiFetchが既にトースト表示済み
  }
}

function formatDuration(durationS) {
  return `${durationS.toFixed(1)}s`;
}

function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  } catch (_e) {
    return isoString;
  }
}

function renderSoundList() {
  el.soundListBody.innerHTML = "";

  if (state.sounds.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "sound-list__empty-row";
    tr.innerHTML = `<td colspan="4">まだ音がありません</td>`;
    el.soundListBody.appendChild(tr);
    return;
  }

  state.sounds.forEach((sound) => {
    const tr = document.createElement("tr");
    if (state.currentSound && state.currentSound.id === sound.id) {
      tr.classList.add("is-active");
    }

    // 名前セル(クリックでインライン改名)
    const nameTd = document.createElement("td");
    nameTd.className = "col-name";
    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "sound-name-btn";
    nameBtn.textContent = sound.name;
    nameBtn.title = "クリックして改名";
    nameBtn.addEventListener("click", () => startInlineRenameInList(sound, nameTd));
    nameTd.appendChild(nameBtn);

    // 長さ
    const durationTd = document.createElement("td");
    durationTd.className = "col-duration";
    durationTd.textContent = formatDuration(sound.duration_s);

    // 作成日時
    const createdTd = document.createElement("td");
    createdTd.className = "col-created";
    createdTd.textContent = formatDate(sound.created_at);

    // 操作
    const actionsTd = document.createElement("td");
    actionsTd.className = "col-actions";
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "row-actions";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "row-action-btn";
    playBtn.title = "確認エリアに読込";
    playBtn.textContent = "▶";
    playBtn.addEventListener("click", () => loadSoundIntoPreview(sound));

    const dlBtn = document.createElement("a");
    dlBtn.className = "row-action-btn";
    dlBtn.title = "ダウンロード";
    dlBtn.textContent = "⬇";
    dlBtn.href = `/api/sounds/${sound.id}/audio?download=1`;
    dlBtn.setAttribute("download", "");

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "row-action-btn row-action-btn--danger";
    delBtn.title = "削除";
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", () => handleDeleteSound(sound));

    actionsWrap.appendChild(playBtn);
    actionsWrap.appendChild(dlBtn);
    actionsWrap.appendChild(delBtn);
    actionsTd.appendChild(actionsWrap);

    tr.appendChild(nameTd);
    tr.appendChild(durationTd);
    tr.appendChild(createdTd);
    tr.appendChild(actionsTd);

    el.soundListBody.appendChild(tr);
  });
}

function startInlineRenameInList(sound, nameTd) {
  nameTd.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "sound-name-input";
  input.value = sound.name;
  nameTd.appendChild(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === sound.name) {
      renderSoundList();
      return;
    }
    await renameSound(sound.id, newName);
  };

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") input.blur();
    if (ev.key === "Escape") {
      input.value = sound.name;
      input.blur();
    }
  });
  input.addEventListener("blur", commit, { once: true });
}

async function handleDeleteSound(sound) {
  const ok = window.confirm(`「${sound.name}」を削除しますか?この操作は取り消せません。`);
  if (!ok) return;

  try {
    await apiFetch(`/api/sounds/${sound.id}`, { method: "DELETE" });
    showToast(`「${sound.name}」を削除しました`, "success");
    if (state.currentSound && state.currentSound.id === sound.id) {
      clearPreview();
    }
    await loadSoundList();
  } catch (_e) {
    // apiFetchが既にトースト表示済み
  }
}

async function renameSound(soundId, newName) {
  try {
    const updated = await apiFetch(`/api/sounds/${soundId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    showToast(`「${updated.name}」に改名しました`, "success");
    if (state.currentSound && state.currentSound.id === soundId) {
      state.currentSound = updated;
      el.previewName.textContent = updated.name;
    }
    await loadSoundList();
  } catch (_e) {
    // apiFetchが既にトースト表示済み
    await loadSoundList();
  }
}

// ----------------------------------------------------------------------------
// 確認エリア(wavesurfer)
// ----------------------------------------------------------------------------

function clearPreview() {
  state.currentSound = null;
  el.previewEmpty.classList.remove("preview-empty--hidden");
  el.previewContent.classList.add("preview-content--hidden");
  if (wavesurfer) {
    wavesurfer.destroy();
    wavesurfer = null;
    regionsPlugin = null;
    activeRegion = null;
  }
  renderSoundList();
}

function renderPreviewParams(sound) {
  const parts = [`シード: ${sound.seed ?? "-"}`, `ステップ: ${sound.steps ?? "-"}`, `ガイダンス: ${sound.cfg_scale ?? "-"}`];
  if (sound.negative_prompt) parts.push(`除外: ${sound.negative_prompt}`);
  el.previewParams.textContent = parts.join(" ・ ");
}

function loadSoundIntoPreview(sound) {
  state.currentSound = sound;
  el.previewEmpty.classList.add("preview-empty--hidden");
  el.previewContent.classList.remove("preview-content--hidden");

  el.previewName.textContent = sound.name;
  el.downloadBtn.href = `/api/sounds/${sound.id}/audio?download=1`;
  el.undoBtn.disabled = !sound.has_backup;
  el.cutBtn.disabled = true;
  el.gainDownBtn.disabled = false;
  el.gainUpBtn.disabled = false;
  el.normalizeBtn.disabled = false;
  el.selectionInfo.textContent = "";
  renderPreviewParams(sound);

  initWaveSurfer(sound);
  renderSoundList();
}

function initWaveSurfer(sound) {
  if (wavesurfer) {
    wavesurfer.destroy();
    wavesurfer = null;
    regionsPlugin = null;
    activeRegion = null;
  }

  regionsPlugin = RegionsPlugin.create();

  wavesurfer = WaveSurfer.create({
    container: el.waveformContainer,
    height: 120,
    waveColor: "#8b8fb8",
    progressColor: "#d946ef",
    cursorColor: "#ff8a3d",
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    plugins: [regionsPlugin],
  });

  const cacheBustedUrl = `${sound.url}?t=${Date.now()}`;
  wavesurfer.load(cacheBustedUrl);

  regionsPlugin.enableDragSelection({
    color: "rgba(124, 92, 255, 0.3)",
  });

  regionsPlugin.on("region-created", (region) => {
    // ドラッグ選択は単一のみ許可(新規作成時に既存を削除)
    if (activeRegion && activeRegion !== region) {
      activeRegion.remove();
    }
    activeRegion = region;
    updateSelectionInfo(region);
    el.cutBtn.disabled = false;
  });

  regionsPlugin.on("region-updated", (region) => {
    activeRegion = region;
    updateSelectionInfo(region);
    el.cutBtn.disabled = false;
  });

  regionsPlugin.on("region-removed", () => {
    if (activeRegion) {
      activeRegion = null;
      el.selectionInfo.textContent = "";
      el.cutBtn.disabled = true;
    }
  });

  wavesurfer.on("finish", () => {
    el.playBtn.textContent = "▶";
  });
}

function updateSelectionInfo(region) {
  const start = region.start.toFixed(2);
  const end = region.end.toFixed(2);
  const len = (region.end - region.start).toFixed(2);
  el.selectionInfo.textContent = `選択範囲: ${start}s 〜 ${end}s (${len}s)`;
}

function handlePlayPause() {
  if (!wavesurfer) return;
  wavesurfer.playPause();
  el.playBtn.textContent = wavesurfer.isPlaying() ? "⏸" : "▶";
}

async function handleCut() {
  if (!state.currentSound || !activeRegion) return;

  const startS = activeRegion.start;
  const endS = activeRegion.end;

  el.cutBtn.disabled = true;

  try {
    const updated = await apiFetch(`/api/sounds/${state.currentSound.id}/cut`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_s: startS, end_s: endS }),
    });
    showToast("選択範囲をカットしました", "success");
    state.currentSound = updated;
    activeRegion = null;
    el.selectionInfo.textContent = "";
    el.undoBtn.disabled = !updated.has_backup;
    el.previewName.textContent = updated.name;
    el.downloadBtn.href = `/api/sounds/${updated.id}/audio?download=1`;
    initWaveSurfer(updated);
    await loadSoundList();
  } catch (_e) {
    // apiFetchが既にトースト表示済み
    el.cutBtn.disabled = activeRegion ? false : true;
  }
}

async function handleGain(payload, message) {
  if (!state.currentSound) return;

  const btns = [el.gainDownBtn, el.gainUpBtn, el.normalizeBtn];
  btns.forEach((b) => (b.disabled = true));

  try {
    const updated = await apiFetch(`/api/sounds/${state.currentSound.id}/gain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast(message, "success");
    state.currentSound = updated;
    activeRegion = null;
    el.selectionInfo.textContent = "";
    el.cutBtn.disabled = true;
    el.undoBtn.disabled = !updated.has_backup;
    initWaveSurfer(updated);
    await loadSoundList();
  } catch (_e) {
    // apiFetchが既にトースト表示済み
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

async function handleUndo() {
  if (!state.currentSound) return;

  el.undoBtn.disabled = true;

  try {
    const updated = await apiFetch(`/api/sounds/${state.currentSound.id}/undo`, {
      method: "POST",
    });
    showToast("元に戻しました", "success");
    state.currentSound = updated;
    activeRegion = null;
    el.selectionInfo.textContent = "";
    el.cutBtn.disabled = true;
    el.undoBtn.disabled = !updated.has_backup;
    el.previewName.textContent = updated.name;
    el.downloadBtn.href = `/api/sounds/${updated.id}/audio?download=1`;
    initWaveSurfer(updated);
    await loadSoundList();
  } catch (_e) {
    // apiFetchが既にトースト表示済み
    if (state.currentSound) {
      el.undoBtn.disabled = !state.currentSound.has_backup;
    }
  }
}

function startInlineRenamePreview() {
  if (!state.currentSound) return;
  el.previewName.style.display = "none";
  el.previewNameInput.classList.remove("preview-name-input--hidden");
  el.previewNameInput.value = state.currentSound.name;
  el.previewNameInput.style.display = "inline-block";
  el.previewNameInput.focus();
  el.previewNameInput.select();
}

function endInlineRenamePreview() {
  el.previewName.style.display = "";
  el.previewNameInput.classList.add("preview-name-input--hidden");
  el.previewNameInput.style.display = "none";
}

async function commitInlineRenamePreview() {
  if (!state.currentSound) {
    endInlineRenamePreview();
    return;
  }
  const newName = el.previewNameInput.value.trim();
  endInlineRenamePreview();
  if (!newName || newName === state.currentSound.name) return;
  await renameSound(state.currentSound.id, newName);
}

// ----------------------------------------------------------------------------
// イベント登録 / 初期化
// ----------------------------------------------------------------------------

function registerEventListeners() {
  el.durationSlider.addEventListener("input", () => {
    el.durationValue.textContent = parseFloat(el.durationSlider.value).toFixed(1);
  });
  el.advSteps.addEventListener("input", () => {
    el.advStepsValue.textContent = el.advSteps.value;
  });
  el.advCfg.addEventListener("input", () => {
    el.advCfgValue.textContent = parseFloat(el.advCfg.value).toFixed(1);
  });

  el.customPrompt.addEventListener("input", updateGenerateButtonLabel);
  el.generateBtn.addEventListener("click", handleCustomGenerateClick);

  el.playBtn.addEventListener("click", handlePlayPause);
  el.cutBtn.addEventListener("click", handleCut);
  el.gainDownBtn.addEventListener("click", () => handleGain({ gain_db: -3 }, "音量を3dB下げました"));
  el.gainUpBtn.addEventListener("click", () => handleGain({ gain_db: 3 }, "音量を3dB上げました"));
  el.normalizeBtn.addEventListener("click", () => handleGain({ normalize: true }, "音量を最大化しました"));
  el.undoBtn.addEventListener("click", handleUndo);

  el.previewName.addEventListener("click", startInlineRenamePreview);
  el.previewNameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") el.previewNameInput.blur();
    if (ev.key === "Escape") {
      endInlineRenamePreview();
    }
  });
  el.previewNameInput.addEventListener("blur", commitInlineRenamePreview);
}

async function init() {
  registerEventListeners();
  updateGenerateButtonLabel();
  startStatusPolling();
  await loadPresets();
  await loadSoundList();
}

init();
