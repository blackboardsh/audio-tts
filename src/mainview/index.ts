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
    },
  },
});

// Initialize Electroview
const electroview = new Electroview({ rpc });

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
let models: Model[] = [];
let outputFiles: OutputFile[] = [];
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
        <button class="btn btn-icon btn-secondary voice-play-btn" title="Play sample">&#9654;</button>
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
  select.innerHTML = '<option value="">Default Voice</option>';

  voices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.id;
    option.textContent = voice.name;
    if (voice.id === selectedVoiceId) {
      option.selected = true;
    }
    select.appendChild(option);
  });
}

function selectVoice(voiceId: string | null) {
  selectedVoiceId = voiceId;
  updateVoiceList();

  const select = $("#voice-select") as HTMLSelectElement;
  select.value = voiceId || "";
}

async function playVoiceSample(voiceId: string | null) {
  if (!voiceId) return;

  const voice = voices.find((v) => v.id === voiceId);
  if (!voice?.sample_audio_path) return;

  const audio = new Audio(`${backendUrl}/audio/${voice.sample_audio_path.split("/").pop()}`);
  audio.play().catch(console.error);
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
  hide("#clone-audio-preview");
  $(".file-upload-content")!.classList.remove("hidden");
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
}

function handleCloneAudioFile(file: File) {
  cloneAudioFile = file;
  const preview = $("#clone-audio-preview") as HTMLAudioElement;
  preview.src = URL.createObjectURL(file);
  show(preview);
  $(".file-upload-content")!.classList.add("hidden");
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
    }>("GET", "/models");
    models = response.available || [];
  } catch (e) {
    console.error("Failed to load models:", e);
    models = [];
  }
}

function openModelsModal() {
  const modal = $("#models-modal")!;
  show(modal);
  updateModelsList();
}

function closeModelsModal() {
  hide("#models-modal");
}

// Track download/load states
const modelStates: Map<string, { downloading: boolean; loading: boolean; progress: string }> = new Map();

function updateModelsList() {
  const container = $("#models-list")!;

  if (models.length === 0) {
    container.innerHTML =
      '<div class="empty-state">No models available</div>';
    return;
  }

  const displayModels = models.filter((m) => m.type !== "tokenizer");

  container.innerHTML = displayModels
    .map(
      (model) => {
        const state = modelStates.get(model.id) || { downloading: false, loading: false, progress: "" };

        let actionsHtml = "";
        if (state.downloading) {
          actionsHtml = `<span class="model-card-status downloading">Downloading... ${state.progress}</span>`;
        } else if (state.loading) {
          actionsHtml = `<span class="model-card-status loading">Loading model...</span>`;
        } else if (model.downloaded) {
          if (model.loaded) {
            actionsHtml = '<span class="model-card-status loaded">Loaded</span>';
          } else {
            actionsHtml = `<button class="btn btn-small btn-primary model-load-btn">Load</button>
               <span class="model-card-status downloaded">Downloaded</span>`;
          }
        } else {
          actionsHtml = `<button class="btn btn-small btn-secondary model-download-btn">Download</button>`;
        }

        return `
    <div class="model-card" data-model-id="${model.id}">
      <div class="model-card-header">
        <span class="model-card-title">${escapeHtml(model.name)}</span>
        <span class="model-card-size">${model.size}</span>
      </div>
      <div class="model-card-description">${escapeHtml(model.description)}</div>
      <div class="model-card-capabilities">
        ${model.capabilities.map((c) => `<span class="capability-tag">${c}</span>`).join("")}
      </div>
      <div class="model-card-actions">
        ${actionsHtml}
      </div>
    </div>
  `;
      }
    )
    .join("");

  container.querySelectorAll(".model-download-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modelId = (btn.closest(".model-card") as HTMLElement)?.getAttribute(
        "data-model-id"
      );
      downloadModel(modelId);
    });
  });

  container.querySelectorAll(".model-load-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modelId = (btn.closest(".model-card") as HTMLElement)?.getAttribute(
        "data-model-id"
      );
      loadModel(modelId);
    });
  });
}

async function downloadModel(modelId: string | null) {
  if (!modelId) return;

  const model = models.find((m) => m.id === modelId);
  if (!model) return;

  // Set downloading state
  modelStates.set(modelId, { downloading: true, loading: false, progress: "Starting..." });
  updateModelsList();

  try {
    // Download tokenizer first if needed
    const tokenizer = models.find((m) => m.type === "tokenizer");
    if (tokenizer && !tokenizer.downloaded) {
      modelStates.set(modelId, { downloading: true, loading: false, progress: "Downloading tokenizer..." });
      updateModelsList();
      const tokenizerResult = await backendRequest<{ task_id: string }>("POST", "/models/download", {
        model_id: tokenizer.id,
      });
      // Wait for tokenizer download to complete
      await pollDownloadProgress(tokenizer.id, tokenizerResult.task_id, (progress) => {
        modelStates.set(modelId, { downloading: true, loading: false, progress: `Tokenizer: ${progress}` });
        updateModelsList();
      });
    }

    // Start model download
    modelStates.set(modelId, { downloading: true, loading: false, progress: "Starting download..." });
    updateModelsList();

    const result = await backendRequest<{ task_id: string }>("POST", "/models/download", { model_id: modelId });

    // Poll for progress
    await pollDownloadProgress(modelId, result.task_id, (progress) => {
      modelStates.set(modelId, { downloading: true, loading: false, progress });
      updateModelsList();
    });

    // Download complete
    modelStates.delete(modelId);
    await loadModels();
    updateModelsList();
  } catch (e) {
    console.error("Failed to download:", e);
    modelStates.delete(modelId);
    updateModelsList();
    alert(`Failed to download: ${e}`);
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

        // Show progress
        if (progress.total_files > 0) {
          onProgress(`${progress.files_completed}/${progress.total_files} files`);
        } else {
          onProgress(progress.status === "downloading" ? "Downloading..." : progress.status);
        }
      } catch (e) {
        // Check if model is now downloaded by refreshing models list
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

async function loadModel(modelId: string | null) {
  if (!modelId) return;

  const model = models.find((m) => m.id === modelId);
  if (!model) return;

  // Set loading state
  modelStates.set(modelId, { downloading: false, loading: true, progress: "" });
  updateModelsList();

  console.log(`Loading model ${modelId}...`);

  try {
    // Use a longer timeout for model loading - it can take minutes
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minute timeout

    const response = await fetch(`${backendUrl}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_type: model.type,
        model_size: model.size,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Load failed");
    }

    const result = await response.json();
    console.log("Model loaded:", result);

    modelStates.delete(modelId);
    await loadModels();
    updateModelsList();
  } catch (e: any) {
    console.error("Failed to load model:", e);
    modelStates.delete(modelId);
    updateModelsList();
    if (e.name === "AbortError") {
      alert("Model loading timed out. The model may still be loading in the background.");
    } else {
      alert(`Failed to load model: ${e.message || e}`);
    }
  }
}

async function unloadAllModels() {
  try {
    await backendRequest("POST", "/models/unload");
    await loadModels();
    updateModelsList();
  } catch (e) {
    console.error("Failed to unload models:", e);
  }
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
  const voiceId = voiceSelect.value || null;

  const languageSelect = $("#language-select") as HTMLSelectElement;
  const language = languageSelect.value;

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

  try {
    if (lines.length === 1) {
      progressText.textContent = "Generating audio...";
      progressFill.style.width = "50%";

      await backendRequest("POST", "/generate", {
        text: lines[0],
        language,
        voice_id: voiceId,
      });

      progressFill.style.width = "100%";
      progressText.textContent = "Complete!";
    } else {
      progressText.textContent = `Generating ${lines.length} audio files...`;

      await backendRequest("POST", "/generate/batch", {
        texts: lines,
        language,
        voice_id: voiceId,
        output_prefix: prefix,
      });

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
        <div class="output-item-meta">${formatFileSize(file.size)}</div>
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
    console.log("Output folder:", paths.output);
    alert(`Output folder: ${paths.output}`);
  } catch (e) {
    console.error("Failed to get paths:", e);
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
    selectVoice(select.value || null);
  });

  $("#btn-models")?.addEventListener("click", openModelsModal);
  $("#btn-unload-models")?.addEventListener("click", unloadAllModels);

  $("#btn-generate")?.addEventListener("click", generateAudio);

  $("#btn-open-output")?.addEventListener("click", openOutputFolder);
  $("#btn-clear-output")?.addEventListener("click", clearAllOutputFiles);

  // Update button
  $("#btn-apply-update")?.addEventListener("click", applyUpdate);
}

// ========== Initialization ==========

async function init() {
  console.log("Audio TTS UI initializing...");

  setupModals();
  setupConfirmModal();
  setupEventListeners();
  setupScriptEditor();
  setupCloneAudioUpload();

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
