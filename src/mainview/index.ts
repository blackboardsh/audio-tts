import { Electroview, type RPCSchema } from "electrobun/view";

// ========== Types ==========

interface SetupState {
  uvInstalled: boolean;
  pythonInstalled: boolean;
  depsInstalled: boolean;
  backendRunning: boolean;
  error?: string;
}

type UpdateStatus = 'checking' | 'update-available' | 'downloading' | 'update-ready' | 'no-update' | 'error';

interface UpdateInfo {
  status: UpdateStatus;
  currentVersion: string;
  newVersion?: string;
  error?: string;
}

interface Voice {
  id: string;
  name: string;
  type: "cloned" | "designed";
  created_at: string;
  language: string;
  reference_text?: string;
  instruction?: string;
  sample_audio_path?: string;
}

interface Model {
  id: string;
  name: string;
  type: string;
  size: string;
  capabilities: string[];
  description: string;
  downloaded: boolean;
  loaded: boolean;
}

interface OutputFile {
  filename: string;
  path: string;
  size: number;
  modified: number;
  prompt?: string;
  created_at?: string;
}

// ========== RPC Schema (matching bun side) ==========

type AppRPCSchema = {
  bun: RPCSchema<{
    requests: {
      getSetupState: {
        params: {};
        response: SetupState;
      };
      runSetup: {
        params: {};
        response: SetupState;
      };
      getBackendStatus: {
        params: {};
        response: { running: boolean; port: number; url: string };
      };
      getPaths: {
        params: {};
        response: { appData: string; models: string; voices: string; output: string };
      };
      openFolder: {
        params: { path: string };
        response: void;
      };
      backendRequest: {
        params: { method: string; path: string; body?: any };
        response: { status: number; data: any };
      };
      getUpdateState: {
        params: {};
        response: UpdateInfo;
      };
      applyUpdate: {
        params: {};
        response: void;
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      updateStatus: UpdateInfo;
      backendLog: { stream: "stdout" | "stderr"; text: string };
    };
  }>;
};

// Create the RPC for webview side
const rpc = Electroview.defineRPC<AppRPCSchema>({
  maxRequestTime: 60000,
  handlers: {
    requests: {},
    messages: {
      updateStatus: (info: UpdateInfo) => {
        updateUpdateUI(info);
      },
      backendLog: (msg: { stream: "stdout" | "stderr"; text: string }) => {
        appendLogMessage(msg.stream, msg.text);
      },
    },
  },
});

// Initialize Electroview
const electroview = new Electroview({ rpc });

// ========== Log Panel ==========

let logVisible = false;
const MAX_LOG_LINES = 300;

function appendLogMessage(stream: "stdout" | "stderr", text: string) {
  const logContent = document.getElementById("log-content");
  if (!logContent) return;

  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const el = document.createElement("div");
    el.className = `log-line ${stream === "stderr" ? "log-stderr" : "log-stdout"}`;
    el.textContent = line;
    logContent.appendChild(el);
  }

  while (logContent.childElementCount > MAX_LOG_LINES) {
    logContent.removeChild(logContent.firstChild!);
  }

  if (logVisible) {
    logContent.scrollTop = logContent.scrollHeight;
  }
}

function toggleLogPanel() {
  const panel = document.getElementById("log-panel")!;
  const btn = document.getElementById("btn-toggle-log")!;
  logVisible = !logVisible;

  if (logVisible) {
    panel.classList.remove("hidden");
    btn.classList.add("active");
    const logContent = document.getElementById("log-content")!;
    logContent.scrollTop = logContent.scrollHeight;
  } else {
    panel.classList.add("hidden");
    btn.classList.remove("active");
  }
}

// ========== RPC Helpers ==========

async function getSetupState(): Promise<SetupState> {
  return await rpc.request.getSetupState({});
}

async function runSetup(): Promise<SetupState> {
  return await rpc.request.runSetup({});
}

async function getBackendStatus(): Promise<{ running: boolean; port: number; url: string }> {
  return await rpc.request.getBackendStatus({});
}

async function getPaths(): Promise<{ appData: string; models: string; voices: string; output: string }> {
  return await rpc.request.getPaths({});
}

async function backendRequest<T = any>(
  method: string,
  path: string,
  body?: any
): Promise<T> {
  const response = await rpc.request.backendRequest({ method, path, body });

  if (response.status >= 400) {
    throw new Error((response.data as any)?.detail || "Backend request failed");
  }

  return response.data;
}

// ========== DOM Helpers ==========

function $(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

function $$(selector: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll(selector);
}

function show(el: HTMLElement | string) {
  const element = typeof el === "string" ? $(el) : el;
  element?.classList.remove("hidden");
}

function hide(el: HTMLElement | string) {
  const element = typeof el === "string" ? $(el) : el;
  element?.classList.add("hidden");
}

function setStepState(
  stepId: string,
  state: "pending" | "active" | "complete" | "error"
) {
  const step = $(`#${stepId}`);
  if (!step) return;

  step.classList.remove("active", "complete", "error");
  if (state !== "pending") {
    step.classList.add(state);
  }

  const icon = step.querySelector(".step-icon");
  if (icon) {
    switch (state) {
      case "pending":
        icon.textContent = "\u25CB";
        break;
      case "active":
        icon.textContent = "\u25CF";
        break;
      case "complete":
        icon.textContent = "\u2713";
        break;
      case "error":
        icon.textContent = "\u2717";
        break;
    }
  }
}

// ========== State ==========

let voices: Voice[] = [];
let selectedVoiceId: string | null = null;
let currentlyPlayingAudio: HTMLAudioElement | null = null;
let currentlyPlayingVoiceId: string | null = null;
let models: Model[] = [];
let outputFiles: OutputFile[] = [];
let builtInSpeakers: string[] = [];

// ========== Model Slot State ==========

type SlotStatus = "off" | "downloading" | "loading" | "loaded" | "error";

interface SlotState {
  currentSize: string;   // currently loaded size, or "off"
  targetSize: string;    // what we're trying to reach, or "off"
  status: SlotStatus;
  statusText: string;
  errorMessage: string;  // full error message for tooltip
  downloadTaskId: string | null;
}

const modelSlots: Record<string, SlotState> = {
  base: { currentSize: "off", targetSize: "off", status: "off", statusText: "", errorMessage: "", downloadTaskId: null },
  voice_design: { currentSize: "off", targetSize: "off", status: "off", statusText: "", errorMessage: "", downloadTaskId: null },
  custom_voice: { currentSize: "off", targetSize: "off", status: "off", statusText: "", errorMessage: "", downloadTaskId: null },
};

let downloadedModelIds: Set<string> = new Set();
let backendUrl = "";

// ========== Setup Screen ==========

async function checkSetupStatus() {
  try {
    const state = await getSetupState();
    updateSetupUI(state);

    if (state.backendRunning) {
      const backendStatus = await getBackendStatus();
      backendUrl = backendStatus.url;
      showMainScreen();
    }
  } catch (e) {
    console.error("Failed to check setup status:", e);
  }
}

function updateSetupUI(state: SetupState) {
  setStepState("step-uv", state.uvInstalled ? "complete" : "active");
  setStepState(
    "step-python",
    state.pythonInstalled
      ? "complete"
      : state.uvInstalled
        ? "active"
        : "pending"
  );
  setStepState(
    "step-deps",
    state.depsInstalled
      ? "complete"
      : state.pythonInstalled
        ? "active"
        : "pending"
  );
  setStepState(
    "step-backend",
    state.backendRunning
      ? "complete"
      : state.depsInstalled
        ? "active"
        : "pending"
  );

  if (state.error) {
    const errorEl = $("#setup-error")!;
    errorEl.textContent = state.error;
    show(errorEl);
    show("#retry-setup");

    if (!state.uvInstalled) setStepState("step-uv", "error");
    else if (!state.pythonInstalled) setStepState("step-python", "error");
    else if (!state.depsInstalled) setStepState("step-deps", "error");
    else if (!state.backendRunning) setStepState("step-backend", "error");
  }
}

async function showMainScreen() {
  hide("#setup-screen");
  show("#main-screen");

  await Promise.all([loadVoices(), loadModels(), loadOutputFiles()]);

  updateVoiceList();
  updateVoiceSelect();
  updateOutputList();

  // Auto-load models from saved preferences
  autoLoadFromPreferences();
}

// ========== Voice Management ==========

async function loadVoices() {
  try {
    const response = await backendRequest<{ voices: Voice[] }>("GET", "/voices");
    voices = response.voices || [];
  } catch (e) {
    console.error("Failed to load voices:", e);
    voices = [];
  }
}

function updateVoiceList() {
  const container = $("#voice-list")!;

  if (voices.length === 0) {
    container.innerHTML =
      '<div class="empty-state">No voices yet. Design or clone a voice to get started.</div>';
    return;
  }

  container.innerHTML = voices
    .map(
      (voice) => `
    <div class="voice-item ${voice.id === selectedVoiceId ? "selected" : ""}" data-voice-id="${voice.id}">
      <div class="voice-item-icon">${voice.type === "designed" ? "\uD83C\uDFA8" : "\uD83C\uDFA4"}</div>
      <div class="voice-item-info">
        <div class="voice-item-name">${escapeHtml(voice.name)}</div>
        <div class="voice-item-type">${voice.type === "designed" ? "Designed" : "Cloned"} - ${voice.language}</div>
      </div>
      <div class="voice-item-actions">
        <button class="btn btn-icon btn-secondary voice-play-btn" title="${voice.id === currentlyPlayingVoiceId ? "Stop" : "Play sample"}">${voice.id === currentlyPlayingVoiceId ? "\u25A0" : "\u25B6"}</button>
        <button class="btn btn-icon btn-danger voice-delete-btn" title="Delete">&times;</button>
      </div>
    </div>
  `
    )
    .join("");

  container.querySelectorAll(".voice-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (
        target.closest(".voice-play-btn") ||
        target.closest(".voice-delete-btn")
      ) {
        return;
      }

      const voiceId = el.getAttribute("data-voice-id");
      selectVoice(voiceId);
    });
  });

  container.querySelectorAll(".voice-play-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const voiceId = (btn.closest(".voice-item") as HTMLElement)?.getAttribute(
        "data-voice-id"
      );
      playVoiceSample(voiceId);
    });
  });

  container.querySelectorAll(".voice-delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const voiceId = (btn.closest(".voice-item") as HTMLElement)?.getAttribute(
        "data-voice-id"
      );
      deleteVoice(voiceId);
    });
  });
}

function updateVoiceSelect() {
  const select = $("#voice-select") as HTMLSelectElement;
  const currentValue = select.value;
  select.innerHTML = '<option value="">Default Voice</option>';

  // Add built-in speakers from Instruct model
  if (builtInSpeakers.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "Built-in Speakers (Instruct)";
    builtInSpeakers.forEach((speaker) => {
      const option = document.createElement("option");
      option.value = `speaker:${speaker}`;
      option.textContent = speaker;
      group.appendChild(option);
    });
    select.appendChild(group);
  }

  // Add cloned/designed voices
  if (voices.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "My Voices";
    voices.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name;
      group.appendChild(option);
    });
    select.appendChild(group);
  }

  // Restore selection
  if (selectedVoiceId) {
    select.value = selectedVoiceId;
  } else if (currentValue) {
    select.value = currentValue;
  }

  updateInstructionRow();
}

async function fetchSpeakers() {
  try {
    const response = await backendRequest<{ speakers: string[] }>("GET", "/models/speakers");
    builtInSpeakers = response.speakers || [];
  } catch (e) {
    console.error("Failed to fetch speakers:", e);
    builtInSpeakers = [];
  }
}

function updateInstructionRow() {
  const select = $("#voice-select") as HTMLSelectElement;
  const row = $("#instruction-row")!;
  const input = $("#voice-instruction") as HTMLInputElement;
  const selectedValue = select.value;

  const isBuiltInSpeaker = selectedValue.startsWith("speaker:");
  const customVoiceSlot = modelSlots["custom_voice"];
  const instructModelLoaded = customVoiceSlot.status === "loaded";

  if (isBuiltInSpeaker && instructModelLoaded) {
    show(row);
    // 0.6B doesn't support instructions
    const is06B = customVoiceSlot.currentSize === "0.6B";
    input.disabled = is06B;
    if (is06B) {
      input.placeholder = "Instructions not supported with 0.6B model";
      input.value = "";
    } else {
      input.placeholder = 'e.g. "Speak slowly and warmly" or "Sound excited and energetic"';
    }
  } else {
    hide(row);
  }
}

function selectVoice(voiceId: string | null) {
  selectedVoiceId = voiceId;
  updateVoiceList();

  const select = $("#voice-select") as HTMLSelectElement;
  select.value = voiceId || "";
  updateInstructionRow();
}

function stopVoiceSample() {
  if (currentlyPlayingAudio) {
    currentlyPlayingAudio.pause();
    currentlyPlayingAudio.src = "";
    currentlyPlayingAudio = null;
  }
  currentlyPlayingVoiceId = null;
  updateVoiceList();
}

async function playVoiceSample(voiceId: string | null) {
  if (!voiceId) return;

  // If already playing this voice, stop it
  if (currentlyPlayingVoiceId === voiceId) {
    stopVoiceSample();
    return;
  }

  // Stop any currently playing sample
  if (currentlyPlayingAudio) {
    currentlyPlayingAudio.pause();
    currentlyPlayingAudio.src = "";
  }

  const voice = voices.find((v) => v.id === voiceId);
  if (!voice?.sample_audio_path) return;

  const audio = new Audio(`${backendUrl}/voices/audio/${voice.sample_audio_path.split("/").pop()}`);
  currentlyPlayingAudio = audio;
  currentlyPlayingVoiceId = voiceId;
  updateVoiceList();

  audio.addEventListener("ended", () => {
    currentlyPlayingAudio = null;
    currentlyPlayingVoiceId = null;
    updateVoiceList();
  });

  audio.play().catch((err) => {
    console.error(err);
    currentlyPlayingAudio = null;
    currentlyPlayingVoiceId = null;
    updateVoiceList();
  });
}

async function deleteVoice(voiceId: string | null) {
  if (!voiceId) {
    console.error("deleteVoice called with null voiceId");
    return;
  }

  const voice = voices.find((v) => v.id === voiceId);
  if (!voice) {
    console.error("Voice not found in local list:", voiceId);
    return;
  }

  const confirmed = await showConfirm(`Delete voice "${voice.name}"?`, "Delete Voice");
  if (!confirmed) return;

  console.log("Deleting voice:", voiceId, voice.name);

  try {
    const result = await backendRequest("DELETE", `/voices/${voiceId}`);
    console.log("Delete result:", result);
    await loadVoices();
    if (selectedVoiceId === voiceId) {
      selectedVoiceId = null;
    }
    updateVoiceList();
    updateVoiceSelect();
  } catch (e) {
    console.error("Failed to delete voice:", e);
    alert(`Failed to delete voice: ${e}`);
  }
}

// ========== Voice Design Modal ==========

function openVoiceDesignModal() {
  const modal = $("#voice-design-modal")!;
  show(modal);

  ($("#design-voice-name") as HTMLInputElement).value = "";
  ($("#design-voice-instruction") as HTMLTextAreaElement).value = "";
  ($("#design-voice-sample") as HTMLTextAreaElement).value =
    "Hello, this is a sample of my voice. I hope you find it pleasant and easy to listen to.";
  ($("#design-voice-language") as HTMLSelectElement).value = "English";
}

function closeVoiceDesignModal() {
  hide("#voice-design-modal");
}

async function createDesignedVoice() {
  const name = ($("#design-voice-name") as HTMLInputElement).value.trim();
  const instruction = (
    $("#design-voice-instruction") as HTMLTextAreaElement
  ).value.trim();
  const sampleText = (
    $("#design-voice-sample") as HTMLTextAreaElement
  ).value.trim();
  const language = ($("#design-voice-language") as HTMLSelectElement).value;

  if (!name) {
    alert("Please enter a voice name");
    return;
  }

  if (!instruction) {
    alert("Please enter voice instructions");
    return;
  }

  const btn = $("#btn-create-design") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    await backendRequest("POST", "/voices/design", {
      voice_name: name,
      instruction,
      sample_text: sampleText,
      language,
    });

    await loadVoices();
    updateVoiceList();
    updateVoiceSelect();
    closeVoiceDesignModal();
  } catch (e) {
    console.error("Failed to design voice:", e);
    alert(`Failed to design voice: ${e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Voice";
  }
}

// ========== Voice Clone Modal ==========

let cloneAudioFile: File | null = null;

function openVoiceCloneModal() {
  const modal = $("#voice-clone-modal")!;
  show(modal);

  ($("#clone-voice-name") as HTMLInputElement).value = "";
  ($("#clone-voice-text") as HTMLTextAreaElement).value = "";
  cloneAudioFile = null;
  show("#clone-audio-upload");
  hide("#clone-audio-preview-row");
}

function closeVoiceCloneModal() {
  hide("#voice-clone-modal");
}

function setupCloneAudioUpload() {
  const uploadArea = $("#clone-audio-upload")!;
  const fileInput = $("#clone-audio-file") as HTMLInputElement;

  uploadArea.addEventListener("click", () => fileInput.click());

  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });

  uploadArea.addEventListener("dragleave", () => {
    uploadArea.classList.remove("dragover");
  });

  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    const files = e.dataTransfer?.files;
    if (files?.[0]) {
      handleCloneAudioFile(files[0]);
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) {
      handleCloneAudioFile(fileInput.files[0]);
    }
  });

  $("#clone-audio-change")?.addEventListener("click", () => {
    fileInput.click();
  });
}

function handleCloneAudioFile(file: File) {
  cloneAudioFile = file;
  const preview = $("#clone-audio-preview") as HTMLAudioElement;
  preview.src = URL.createObjectURL(file);
  hide("#clone-audio-upload");
  show("#clone-audio-preview-row");
}

async function createClonedVoice() {
  const name = ($("#clone-voice-name") as HTMLInputElement).value.trim();
  const referenceText = (
    $("#clone-voice-text") as HTMLTextAreaElement
  ).value.trim();

  if (!name) {
    alert("Please enter a voice name");
    return;
  }

  if (!cloneAudioFile) {
    alert("Please select an audio file");
    return;
  }

  if (!referenceText) {
    alert("Please enter the reference text (transcript of the audio)");
    return;
  }

  const btn = $("#btn-create-clone") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Cloning...";

  try {
    const formData = new FormData();
    formData.append("voice_name", name);
    formData.append("reference_text", referenceText);
    formData.append("audio_file", cloneAudioFile);

    const response = await fetch(`${backendUrl}/voices/clone`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Clone failed");
    }

    await loadVoices();
    updateVoiceList();
    updateVoiceSelect();
    closeVoiceCloneModal();
  } catch (e) {
    console.error("Failed to clone voice:", e);
    alert(`Failed to clone voice: ${e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Clone Voice";
  }
}

// ========== Model Management ==========

async function loadModels() {
  try {
    const response = await backendRequest<{
      available: Model[];
      downloaded: string[];
      loaded: string[];
      loaded_detail: Record<string, string>;
    }>("GET", "/models");
    models = response.available || [];

    // Sync downloadedModelIds
    downloadedModelIds = new Set(response.downloaded || []);

    // Sync slot states from loaded_detail
    const detail = response.loaded_detail || {};
    for (const slotType of Object.keys(modelSlots)) {
      const slot = modelSlots[slotType];
      if (detail[slotType]) {
        slot.currentSize = detail[slotType];
        slot.targetSize = detail[slotType];
        slot.status = "loaded";
        slot.statusText = "";
      } else if (slot.status === "loaded") {
        // Was loaded but no longer
        slot.currentSize = "off";
        slot.targetSize = "off";
        slot.status = "off";
        slot.statusText = "";
      }
      updateSlotUI(slotType);
    }
  } catch (e) {
    console.error("Failed to load models:", e);
    models = [];
  }
}

function getModelId(slotType: string, size: string): string | null {
  const key = `${slotType}_${size}`;
  const info = models.find(
    (m) => m.type === slotType && m.size === size
  );
  return info?.id || null;
}

function updateSlotUI(slotType: string) {
  const slot = modelSlots[slotType];
  const container = document.querySelector(`.model-slot[data-slot="${slotType}"]`) as HTMLElement;
  if (!container) return;

  const btn = container.querySelector(".model-slot-btn") as HTMLElement;

  // Clear state classes
  container.classList.remove("slot-loaded", "slot-downloading", "slot-loading", "slot-error");

  let label = "Off";
  let spinnerHtml = "";

  switch (slot.status) {
    case "loaded":
      label = slot.currentSize;
      container.classList.add("slot-loaded");
      break;
    case "downloading":
      label = slot.statusText || "...";
      spinnerHtml = '<span class="slot-spinner"></span> ';
      container.classList.add("slot-downloading");
      break;
    case "loading":
      label = slot.statusText || "Loading...";
      spinnerHtml = '<span class="slot-spinner"></span> ';
      container.classList.add("slot-loading");
      break;
    case "error":
      label = "Error";
      container.classList.add("slot-error");
      break;
    default:
      label = "Off";
      break;
  }

  // Show error message as tooltip when in error state
  if (slot.status === "error" && slot.errorMessage) {
    btn.title = slot.errorMessage;
  } else {
    btn.title = "";
  }

  btn.innerHTML = `${spinnerHtml}${escapeHtml(label)} <span class="slot-arrow">&#9662;</span>`;

  updateDropdownOptions(slotType);
}

function updateDropdownOptions(slotType: string) {
  const slot = modelSlots[slotType];
  const dropdown = document.querySelector(`.model-slot-dropdown[data-slot="${slotType}"]`);
  if (!dropdown) return;

  dropdown.querySelectorAll(".dropdown-option").forEach((opt) => {
    const size = (opt as HTMLElement).getAttribute("data-size")!;
    opt.classList.remove("active");

    // Remove old download hint
    const oldHint = opt.querySelector(".download-hint");
    if (oldHint) oldHint.remove();

    if (size === "off") {
      if (slot.status === "off" || slot.status === "error") opt.classList.add("active");
    } else {
      // Check if active
      if (slot.status === "loaded" && slot.currentSize === size) {
        opt.classList.add("active");
      }
      // Check if needs download
      const modelId = getModelId(slotType, size);
      if (modelId && !downloadedModelIds.has(modelId)) {
        const hint = document.createElement("span");
        hint.className = "download-hint";
        hint.textContent = "(download)";
        opt.appendChild(hint);
      }
    }
  });

}

function toggleDropdown(slotType: string) {
  const dropdown = document.querySelector(`.model-slot-dropdown[data-slot="${slotType}"]`) as HTMLElement;
  if (!dropdown) return;

  const isOpen = !dropdown.classList.contains("hidden");
  // Close all dropdowns first
  document.querySelectorAll(".model-slot-dropdown").forEach((d) => d.classList.add("hidden"));

  if (!isOpen) {
    updateDropdownOptions(slotType);
    dropdown.classList.remove("hidden");
  }
}

async function onSlotSelectionChange(slotType: string, newSize: string) {
  const slot = modelSlots[slotType];

  // Close dropdown
  document.querySelectorAll(".model-slot-dropdown").forEach((d) => d.classList.add("hidden"));

  // If already at this state, do nothing
  if (newSize === "off" && slot.status === "off") return;
  if (slot.status === "loaded" && slot.currentSize === newSize) return;

  // If busy, ignore
  if (slot.status === "downloading" || slot.status === "loading") return;

  // Clear previous error
  slot.errorMessage = "";

  if (newSize === "off") {
    // Unload
    slot.targetSize = "off";
    slot.status = "loading";
    slot.statusText = "Unloading...";
    updateSlotUI(slotType);

    try {
      await backendRequest("POST", `/models/unload/${slotType}`);
      slot.currentSize = "off";
      slot.status = "off";
      slot.statusText = "";
      saveSlotPreferences();

      // Clear speakers when Instruct model is unloaded
      if (slotType === "custom_voice") {
        builtInSpeakers = [];
        // Reset voice select if a built-in speaker was selected
        const voiceSelect = $("#voice-select") as HTMLSelectElement;
        if (voiceSelect.value.startsWith("speaker:")) {
          voiceSelect.value = "";
        }
        updateVoiceSelect();
      }
    } catch (e) {
      console.error(`Failed to unload ${slotType}:`, e);
      slot.status = "error";
      slot.statusText = "Unload failed";
      slot.errorMessage = (e as any).message || String(e);
    }
    updateSlotUI(slotType);
    return;
  }

  // Load (possibly after download)
  slot.targetSize = newSize;
  const modelId = getModelId(slotType, newSize);
  if (!modelId) {
    console.error(`No model found for ${slotType} ${newSize}`);
    return;
  }

  await downloadAndLoadSlot(slotType, newSize, modelId);
}

async function downloadAndLoadSlot(slotType: string, size: string, modelId: string) {
  const slot = modelSlots[slotType];

  try {
    // Download tokenizer if needed
    const tokenizer = models.find((m) => m.type === "tokenizer");
    if (tokenizer && !downloadedModelIds.has(tokenizer.id)) {
      slot.status = "downloading";
      slot.statusText = "Tokenizer...";
      updateSlotUI(slotType);

      const tokResult = await backendRequest<{ task_id: string }>("POST", "/models/download", {
        model_id: tokenizer.id,
      });
      await pollDownloadProgress(tokenizer.id, tokResult.task_id, (progress) => {
        slot.statusText = `Tok: ${progress}`;
        updateSlotUI(slotType);
      });
      downloadedModelIds.add(tokenizer.id);
    }

    // Download model if needed
    if (!downloadedModelIds.has(modelId)) {
      slot.status = "downloading";
      slot.statusText = `DL ${size}`;
      updateSlotUI(slotType);

      const dlResult = await backendRequest<{ task_id: string }>("POST", "/models/download", {
        model_id: modelId,
      });
      slot.downloadTaskId = dlResult.task_id;

      await pollDownloadProgress(modelId, dlResult.task_id, (progress) => {
        slot.statusText = progress;
        updateSlotUI(slotType);
      });
      downloadedModelIds.add(modelId);
      slot.downloadTaskId = null;
    }

    // Load the model
    await loadSlot(slotType, size);
  } catch (e: any) {
    console.error(`Failed to download/load ${slotType} ${size}:`, e);
    slot.status = "error";
    slot.statusText = "Failed";
    slot.errorMessage = e.message || String(e);
    slot.downloadTaskId = null;
    updateSlotUI(slotType);
  }
}

async function loadSlot(slotType: string, size: string) {
  const slot = modelSlots[slotType];

  // Unload current if different size is loaded
  if (slot.status === "loaded" && slot.currentSize !== size) {
    slot.status = "loading";
    slot.statusText = "Swapping...";
    updateSlotUI(slotType);

    await backendRequest("POST", `/models/unload/${slotType}`);
  }

  slot.status = "loading";
  slot.statusText = `Loading ${size}...`;
  updateSlotUI(slotType);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000);

    const response = await fetch(`${backendUrl}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_type: slotType, model_size: size }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Load failed");
    }

    slot.currentSize = size;
    slot.targetSize = size;
    slot.status = "loaded";
    slot.statusText = "";
    saveSlotPreferences();
    updateSlotUI(slotType);

    // Fetch speakers when Instruct model loads
    if (slotType === "custom_voice") {
      await fetchSpeakers();
      updateVoiceSelect();
    }
  } catch (e: any) {
    console.error(`Failed to load ${slotType} ${size}:`, e);
    slot.status = "error";
    slot.statusText = e.name === "AbortError" ? "Timeout" : "Load failed";
    slot.errorMessage = e.message || String(e);
    updateSlotUI(slotType);
  }
}

async function pollDownloadProgress(
  modelId: string,
  taskId: string,
  onProgress: (progress: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(async () => {
      try {
        const progress = await backendRequest<{
          status: string;
          progress: number;
          total_files: number;
          files_completed: number;
          error?: string;
          completed: boolean;
        }>("GET", `/models/download/${taskId}`);

        if (progress.error) {
          clearInterval(checkInterval);
          reject(new Error(progress.error));
          return;
        }

        if (progress.completed) {
          clearInterval(checkInterval);
          onProgress("Complete!");
          resolve();
          return;
        }

        if (progress.total_files > 0) {
          onProgress(`${progress.files_completed}/${progress.total_files} files`);
        } else {
          onProgress(progress.status === "downloading" ? "Downloading..." : progress.status);
        }
      } catch (e) {
        await loadModels();
        const model = models.find((m) => m.id === modelId);
        if (model?.downloaded) {
          clearInterval(checkInterval);
          onProgress("Complete!");
          resolve();
          return;
        }
      }
    }, 2000);
  });
}

// ========== Slot Preferences ==========

function saveSlotPreferences() {
  const prefs: Record<string, string> = {};
  for (const [type, slot] of Object.entries(modelSlots)) {
    prefs[type] = slot.status === "loaded" ? slot.currentSize : "off";
  }
  localStorage.setItem("modelSlotPrefs", JSON.stringify(prefs));
}

function getSlotPreferences(): Record<string, string> {
  try {
    const raw = localStorage.getItem("modelSlotPrefs");
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function autoLoadFromPreferences() {
  const prefs = getSlotPreferences();
  // Only auto-load the base model; Design and Instruct reset to off on launch
  const baseSize = prefs["base"];
  if (baseSize && baseSize !== "off" && modelSlots["base"]) {
    const slot = modelSlots["base"];
    if (slot.status !== "loaded" || slot.currentSize !== baseSize) {
      try {
        await onSlotSelectionChange("base", baseSize);
      } catch (e) {
        console.error("Auto-load failed for base:", e);
      }
    }
  }
}

// ========== Dropdown Event Wiring ==========

function setupDropdowns() {
  // Button clicks toggle dropdown
  document.querySelectorAll(".model-slot-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slotType = (btn as HTMLElement).getAttribute("data-slot")!;
      toggleDropdown(slotType);
    });
  });

  // Option clicks
  document.querySelectorAll(".dropdown-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const dropdown = (opt as HTMLElement).closest(".model-slot-dropdown") as HTMLElement;
      const slotType = dropdown.getAttribute("data-slot")!;
      const size = (opt as HTMLElement).getAttribute("data-size")!;
      onSlotSelectionChange(slotType, size);
    });
  });

  // Click outside closes dropdowns
  document.addEventListener("click", () => {
    document.querySelectorAll(".model-slot-dropdown").forEach((d) => d.classList.add("hidden"));
  });
}

// ========== Script Editor ==========

function setupScriptEditor() {
  const editor = $("#script-editor") as HTMLTextAreaElement;
  const lineCount = $("#line-count")!;

  editor.addEventListener("input", () => {
    const lines = editor.value.split("\n").filter((l) => l.trim()).length;
    lineCount.textContent = `${lines} line${lines !== 1 ? "s" : ""}`;
  });

  $("#btn-split-sentences")?.addEventListener("click", () => {
    const text = editor.value;
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s);
    editor.value = sentences.join("\n");
    editor.dispatchEvent(new Event("input"));
  });
}

// ========== Advanced Settings ==========

function setupAdvancedSettings() {
  const sliders = [
    { id: "slider-temperature", valId: "val-temperature" },
    { id: "slider-top-p", valId: "val-top-p" },
    { id: "slider-repetition-penalty", valId: "val-repetition-penalty" },
  ];

  for (const { id, valId } of sliders) {
    const slider = $(`#${id}`) as HTMLInputElement;
    const valEl = $(`#${valId}`)!;
    slider.addEventListener("input", () => {
      valEl.textContent = slider.value;
    });
  }
}

function getGenerationKwargs(): Record<string, number> {
  const kwargs: Record<string, number> = {};
  const temp = ($("#slider-temperature") as HTMLInputElement)?.value;
  const topP = ($("#slider-top-p") as HTMLInputElement)?.value;
  const repPenalty = ($("#slider-repetition-penalty") as HTMLInputElement)?.value;
  if (temp) kwargs.temperature = parseFloat(temp);
  if (topP) kwargs.top_p = parseFloat(topP);
  if (repPenalty) kwargs.repetition_penalty = parseFloat(repPenalty);
  return kwargs;
}

// ========== Audio Generation ==========

async function generateAudio() {
  const editor = $("#script-editor") as HTMLTextAreaElement;
  const text = editor.value.trim();

  if (!text) {
    alert("Please enter some text to generate");
    return;
  }

  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    alert("Please enter some text to generate");
    return;
  }

  const voiceSelect = $("#voice-select") as HTMLSelectElement;
  const voiceValue = voiceSelect.value;
  const isBuiltInSpeaker = voiceValue.startsWith("speaker:");
  const speakerName = isBuiltInSpeaker ? voiceValue.slice("speaker:".length) : null;
  const voiceId = isBuiltInSpeaker ? null : (voiceValue || null);

  const languageSelect = $("#language-select") as HTMLSelectElement;
  const language = languageSelect.value;

  const instructionInput = $("#voice-instruction") as HTMLInputElement;
  const instruction = (isBuiltInSpeaker && !instructionInput.disabled && instructionInput.value.trim())
    ? instructionInput.value.trim() : null;

  const prefixInput = $("#output-prefix") as HTMLInputElement;
  const prefix = prefixInput.value.trim() || "audio";

  const btn = $("#btn-generate") as HTMLButtonElement;
  const progressContainer = $("#generation-progress")!;
  const progressFill = progressContainer.querySelector(
    ".progress-fill"
  ) as HTMLElement;
  const progressText = progressContainer.querySelector(
    ".progress-text"
  ) as HTMLElement;

  btn.disabled = true;
  show(progressContainer);
  progressFill.style.width = "0%";
  progressText.textContent = "Preparing...";

  const genKwargs = getGenerationKwargs();

  try {
    if (lines.length === 1) {
      progressText.textContent = "Generating audio...";
      progressFill.style.width = "50%";

      const body = {
        text: lines[0],
        language,
        voice_id: voiceId,
        speaker: speakerName,
        instruction,
        ...genKwargs,
      };
      console.log("Generate request:", body);
      await backendRequest("POST", "/generate", body);

      progressFill.style.width = "100%";
      progressText.textContent = "Complete!";
    } else {
      progressText.textContent = `Generating ${lines.length} audio files...`;

      const body = {
        texts: lines,
        language,
        voice_id: voiceId,
        speaker: speakerName,
        instruction,
        output_prefix: prefix,
        ...genKwargs,
      };
      console.log("Batch generate request:", body);
      await backendRequest("POST", "/generate/batch", body);

      progressFill.style.width = "100%";
      progressText.textContent = `Generated ${lines.length} files!`;
    }

    await loadOutputFiles();
    updateOutputList();
  } catch (e) {
    console.error("Failed to generate audio:", e);
    progressText.textContent = `Error: ${e}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => hide(progressContainer), 3000);
  }
}

// ========== Output Files ==========

async function loadOutputFiles() {
  try {
    const response = await backendRequest<{ files: OutputFile[] }>(
      "GET",
      "/output"
    );
    outputFiles = response.files || [];
  } catch (e) {
    console.error("Failed to load output files:", e);
    outputFiles = [];
  }
}

function updateOutputList() {
  const container = $("#output-list")!;

  if (outputFiles.length === 0) {
    container.innerHTML =
      '<div class="empty-state">Generated audio files will appear here.</div>';
    return;
  }

  container.innerHTML = outputFiles
    .map(
      (file) => `
    <div class="output-item" data-filename="${escapeHtml(file.filename)}">
      <div class="output-item-info">
        <div class="output-item-name">${escapeHtml(file.filename)}</div>
        <div class="output-item-meta">${formatFileSize(file.size)}${file.created_at ? " &middot; " + formatDate(file.created_at) : ""}</div>
        ${file.prompt ? `<div class="output-item-prompt" title="${escapeHtml(file.prompt)}">${escapeHtml(file.prompt)}</div>` : ""}
      </div>
      <audio controls src="${backendUrl}/audio/${encodeURIComponent(file.filename)}"></audio>
      <div class="output-item-actions">
        <button class="btn btn-icon btn-danger output-delete-btn" title="Delete">&times;</button>
      </div>
    </div>
  `
    )
    .join("");

  container.querySelectorAll(".output-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const filename = (
        btn.closest(".output-item") as HTMLElement
      )?.getAttribute("data-filename");
      deleteOutputFile(filename);
    });
  });
}

async function deleteOutputFile(filename: string | null) {
  if (!filename) return;

  try {
    await backendRequest("DELETE", `/output/${encodeURIComponent(filename)}`);
    await loadOutputFiles();
    updateOutputList();
  } catch (e) {
    console.error("Failed to delete file:", e);
  }
}

async function clearAllOutputFiles() {
  const confirmed = await showConfirm("Delete all generated audio files?", "Clear Output", "Clear All");
  if (!confirmed) return;

  try {
    for (const file of outputFiles) {
      await backendRequest(
        "DELETE",
        `/output/${encodeURIComponent(file.filename)}`
      );
    }
    await loadOutputFiles();
    updateOutputList();
  } catch (e) {
    console.error("Failed to clear files:", e);
  }
}

async function openOutputFolder() {
  try {
    const paths = await getPaths();
    await rpc.request.openFolder({ path: paths.output });
  } catch (e) {
    console.error("Failed to open output folder:", e);
  }
}

async function openModelsFolder() {
  try {
    const paths = await getPaths();
    await rpc.request.openFolder({ path: paths.models });
  } catch (e) {
    console.error("Failed to open models folder:", e);
  }
}

// ========== Utility Functions ==========

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    const now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    // If today, just show time
    if (d.toDateString() === now.toDateString()) return time;
    // If this year, show month/day + time
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (d.getFullYear() === now.getFullYear()) return `${date} ${time}`;
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} ${time}`;
  } catch {
    return "";
  }
}

// ========== Modal Helpers ==========

let confirmResolve: ((value: boolean) => void) | null = null;

function showConfirm(message: string, title = "Confirm", okText = "Delete"): Promise<boolean> {
  return new Promise((resolve) => {
    confirmResolve = resolve;

    const modal = $("#confirm-modal")!;
    $("#confirm-modal-title")!.textContent = title;
    $("#confirm-modal-message")!.textContent = message;
    $("#confirm-modal-ok")!.textContent = okText;

    show(modal);
  });
}

function setupConfirmModal() {
  $("#confirm-modal-ok")?.addEventListener("click", () => {
    hide("#confirm-modal");
    if (confirmResolve) {
      confirmResolve(true);
      confirmResolve = null;
    }
  });

  $("#confirm-modal-cancel")?.addEventListener("click", () => {
    hide("#confirm-modal");
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
    }
  });

  // Handle overlay click for confirm modal specifically
  $("#confirm-modal .modal-overlay")?.addEventListener("click", () => {
    hide("#confirm-modal");
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
    }
  });
}

function setupModals() {
  $$(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", () => {
      const modal = overlay.closest(".modal");
      // Skip confirm modal - it has its own handler that resolves the promise
      if (modal && modal.id !== "confirm-modal") {
        hide(modal as HTMLElement);
      }
    });
  });

  $$(".modal-close, .modal-cancel").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.closest(".modal");
      // Skip confirm modal - it has its own handlers that resolve the promise
      if (modal && modal.id !== "confirm-modal") {
        hide(modal as HTMLElement);
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Handle confirm modal specially to resolve its promise
      const confirmModal = $("#confirm-modal");
      if (confirmModal && !confirmModal.classList.contains("hidden")) {
        hide(confirmModal);
        if (confirmResolve) {
          confirmResolve(false);
          confirmResolve = null;
        }
        return;
      }
      $$(".modal:not(.hidden)").forEach((modal) => hide(modal));
    }
  });
}

// ========== Update UI ==========

function updateUpdateUI(info: UpdateInfo) {
  const banner = $("#update-banner");
  const statusText = $("#update-status-text");
  const updateBtn = $("#btn-apply-update") as HTMLButtonElement;

  if (!banner || !statusText || !updateBtn) return;

  switch (info.status) {
    case 'checking':
      hide(banner);
      break;
    case 'no-update':
      hide(banner);
      break;
    case 'update-available':
      statusText.textContent = `Version ${info.newVersion} is available`;
      updateBtn.textContent = 'Downloading...';
      updateBtn.disabled = true;
      show(banner);
      break;
    case 'downloading':
      statusText.textContent = `Downloading ${info.newVersion}...`;
      updateBtn.textContent = 'Downloading...';
      updateBtn.disabled = true;
      show(banner);
      break;
    case 'update-ready':
      statusText.textContent = `Version ${info.newVersion} is ready to install`;
      updateBtn.textContent = 'Update Now';
      updateBtn.disabled = false;
      show(banner);
      break;
    case 'error':
      hide(banner);
      break;
  }
}

async function applyUpdate() {
  const updateBtn = $("#btn-apply-update") as HTMLButtonElement;
  if (updateBtn) {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Restarting...';
  }

  try {
    await rpc.request.applyUpdate({});
  } catch (e) {
    console.error("Failed to apply update:", e);
    if (updateBtn) {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update Now';
    }
  }
}

// ========== Event Listeners ==========

function setupEventListeners() {
  $("#retry-setup")?.addEventListener("click", async () => {
    hide("#setup-error");
    hide("#retry-setup");
    setStepState("step-uv", "pending");
    setStepState("step-python", "pending");
    setStepState("step-deps", "pending");
    setStepState("step-backend", "pending");

    const state = await runSetup();
    updateSetupUI(state);

    if (state.backendRunning) {
      const backendStatus = await getBackendStatus();
      backendUrl = backendStatus.url;
      showMainScreen();
    }
  });

  $("#btn-design-voice")?.addEventListener("click", openVoiceDesignModal);
  $("#btn-clone-voice")?.addEventListener("click", openVoiceCloneModal);
  $("#btn-create-design")?.addEventListener("click", createDesignedVoice);
  $("#btn-create-clone")?.addEventListener("click", createClonedVoice);

  $("#voice-select")?.addEventListener("change", (e) => {
    const select = e.target as HTMLSelectElement;
    const value = select.value;
    // Built-in speakers don't use selectVoice (they aren't voice profiles)
    if (value.startsWith("speaker:")) {
      selectedVoiceId = null;
      updateVoiceList();
    } else {
      selectVoice(value || null);
    }
    updateInstructionRow();
  });

  $("#btn-generate")?.addEventListener("click", generateAudio);

  $("#btn-open-output")?.addEventListener("click", openOutputFolder);
  $("#btn-open-models")?.addEventListener("click", openModelsFolder);
  $("#btn-clear-output")?.addEventListener("click", clearAllOutputFiles);
  $("#btn-toggle-log")?.addEventListener("click", toggleLogPanel);

  // Update button
  $("#btn-apply-update")?.addEventListener("click", applyUpdate);
}

// ========== Initialization ==========

async function init() {
  console.log("Audio TTS UI initializing...");

  setupModals();
  setupConfirmModal();
  setupEventListeners();
  setupDropdowns();
  setupScriptEditor();
  setupCloneAudioUpload();
  setupAdvancedSettings();

  // Small delay to ensure RPC is ready
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Get initial update state
  try {
    const updateInfo = await rpc.request.getUpdateState({});
    updateUpdateUI(updateInfo);
  } catch (e) {
    console.error("Failed to get update state:", e);
  }

  await checkSetupStatus();

  if (!$("#setup-screen")?.classList.contains("hidden")) {
    const pollInterval = setInterval(async () => {
      try {
        const state = await getSetupState();
        updateSetupUI(state);

        if (state.backendRunning) {
          clearInterval(pollInterval);
          const backendStatus = await getBackendStatus();
          backendUrl = backendStatus.url;
          showMainScreen();
        }
      } catch (e) {
        console.error("Setup poll error:", e);
      }
    }, 2000);
  }
}

// Start the app
init();
