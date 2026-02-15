#!/usr/bin/env python3
"""
TTS Service - Handles Qwen3-TTS model operations.
"""

import os
import sys
import json
import uuid
import logging
import threading
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime

import torch
import soundfile as sf
import numpy as np

logger = logging.getLogger(__name__)

# Default generation kwargs for tighter sampling
DEFAULT_GENERATION_KWARGS = {
    "temperature": 0.7,
    "top_p": 0.9,
    "top_k": 50,
    "repetition_penalty": 1.1,
    "max_new_tokens": 2048,
}

# Model registry
AVAILABLE_MODELS = {
    "base_0.6B": {
        "id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        "name": "Base 0.6B (Required)",
        "type": "base",
        "size": "0.6B",
        "capabilities": ["voice_clone", "generate"],
        "description": "REQUIRED for audio generation. Smaller & faster model (~1.3GB)"
    },
    "base_1.7B": {
        "id": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "name": "Base 1.7B (Better Quality)",
        "type": "base",
        "size": "1.7B",
        "capabilities": ["voice_clone", "generate"],
        "description": "REQUIRED for audio generation. Better quality but slower (~3.8GB)"
    },
    "voice_design_1.7B": {
        "id": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        "name": "Voice Design 1.7B",
        "type": "voice_design",
        "size": "1.7B",
        "capabilities": ["voice_design"],
        "description": "Optional: Create voices from text descriptions (~3.8GB)"
    },
    "custom_voice_0.6B": {
        "id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        "name": "Custom Voice 0.6B",
        "type": "custom_voice",
        "size": "0.6B",
        "capabilities": ["voice_clone", "instruction_control"],
        "description": "Optional: Voice cloning with instruction control (~1.3GB)"
    },
    "custom_voice_1.7B": {
        "id": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        "name": "Custom Voice 1.7B",
        "type": "custom_voice",
        "size": "1.7B",
        "capabilities": ["voice_clone", "instruction_control"],
        "description": "Optional: Better voice cloning with instruction control (~3.8GB)"
    },
    "tokenizer": {
        "id": "Qwen/Qwen3-TTS-Tokenizer-12Hz",
        "name": "Tokenizer",
        "type": "tokenizer",
        "size": "small",
        "capabilities": [],
        "description": "Audio tokenizer (auto-downloaded with models)"
    }
}


@dataclass
class ModelInfo:
    id: str
    name: str
    type: str
    size: str
    capabilities: List[str]
    description: str
    downloaded: bool = False
    loaded: bool = False


@dataclass
class VoiceProfile:
    id: str
    name: str
    type: str  # "cloned" or "designed"
    created_at: str
    language: str
    reference_text: Optional[str] = None
    instruction: Optional[str] = None
    sample_audio_path: Optional[str] = None

    def model_dump(self) -> dict:
        return asdict(self)


class DownloadTask:
    def __init__(self, model_id: str):
        self.task_id = str(uuid.uuid4())
        self.model_id = model_id
        self.status = "pending"
        self.progress = 0.0
        self.downloaded_bytes = 0
        self.total_bytes = 0
        self.current_file = ""
        self.files_completed = 0
        self.total_files = 0
        self.error: Optional[str] = None
        self.completed = False


class TTSService:
    def __init__(self, models_dir: Path, voices_dir: Path, output_dir: Path):
        self.models_dir = models_dir
        self.voices_dir = voices_dir
        self.output_dir = output_dir

        # Set HuggingFace environment variables to use our models directory
        os.environ["HF_HOME"] = str(models_dir)
        os.environ["HUGGINGFACE_HUB_CACHE"] = str(models_dir)
        os.environ["HF_HUB_CACHE"] = str(models_dir)

        # Ensure SSL certificates are available (standalone Python from uv
        # may not find system certs)
        try:
            import certifi
            os.environ.setdefault("SSL_CERT_FILE", certifi.where())
            os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
        except ImportError:
            pass

        # Loaded models
        self.base_model = None
        self.voice_design_model = None
        self.custom_voice_model = None
        self.tokenizer = None

        # Track which size is loaded per model type
        self._loaded_model_sizes: Dict[str, str] = {}

        # Voice profiles cache
        self.voice_profiles: Dict[str, VoiceProfile] = {}
        self.voice_clone_prompts: Dict[str, Any] = {}

        # Download tasks
        self.download_tasks: Dict[str, DownloadTask] = {}

        # Determine device
        self.device = self._get_device()
        # Use float32 for MPS - float16 causes numerical instability (inf/nan in softmax)
        self.dtype = torch.float32 if self.device == "mps" else torch.float16

        # Output metadata index (filename -> {prompt, created_at, ...})
        self._output_metadata: Dict[str, dict] = {}
        self._load_output_metadata()

        # Load existing voice profiles
        self._load_voice_profiles()

        logger.info(f"TTS Service initialized. Device: {self.device}, Dtype: {self.dtype}")
        logger.info(f"Models directory: {models_dir}")

    def _get_device(self) -> str:
        """Determine the best available device."""
        if torch.cuda.is_available():
            return "cuda:0"
        elif torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    def _load_voice_profiles(self):
        """Load existing voice profiles from disk."""
        profiles_file = self.voices_dir / "profiles.json"
        if profiles_file.exists():
            try:
                with open(profiles_file) as f:
                    data = json.load(f)
                    for profile_data in data.get("profiles", []):
                        profile = VoiceProfile(**profile_data)
                        self.voice_profiles[profile.id] = profile
                logger.info(f"Loaded {len(self.voice_profiles)} voice profiles")
            except Exception as e:
                logger.error(f"Failed to load voice profiles: {e}")

    def _save_voice_profiles(self):
        """Save voice profiles to disk."""
        profiles_file = self.voices_dir / "profiles.json"
        try:
            data = {
                "profiles": [p.model_dump() for p in self.voice_profiles.values()]
            }
            with open(profiles_file, "w") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save voice profiles: {e}")

    def _load_output_metadata(self):
        """Load output metadata index from disk."""
        meta_file = self.output_dir / "metadata.json"
        if meta_file.exists():
            try:
                with open(meta_file) as f:
                    self._output_metadata = json.load(f)
            except Exception as e:
                logger.error(f"Failed to load output metadata: {e}")
                self._output_metadata = {}

    def _save_output_metadata(self):
        """Save output metadata index to disk."""
        meta_file = self.output_dir / "metadata.json"
        try:
            with open(meta_file, "w") as f:
                json.dump(self._output_metadata, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save output metadata: {e}")

    def _record_output_metadata(self, filename: str, text: str, **extra):
        """Record metadata for a generated output file."""
        self._output_metadata[filename] = {
            "prompt": text,
            "created_at": datetime.now().isoformat(),
            **extra,
        }
        self._save_output_metadata()

    def get_output_metadata(self, filename: str) -> Optional[dict]:
        """Get metadata for a specific output file."""
        return self._output_metadata.get(filename)

    def get_all_output_metadata(self) -> Dict[str, dict]:
        """Get all output metadata."""
        return dict(self._output_metadata)

    def delete_output_metadata(self, filename: str):
        """Remove metadata for a deleted output file."""
        if filename in self._output_metadata:
            del self._output_metadata[filename]
            self._save_output_metadata()

    def get_available_models(self) -> List[dict]:
        """Get list of all available models."""
        models = []
        for key, info in AVAILABLE_MODELS.items():
            model_info = ModelInfo(
                **info,
                downloaded=self._is_model_downloaded(info["id"]),
                loaded=self._is_model_loaded(info["type"])
            )
            models.append(asdict(model_info))
        return models

    def get_downloaded_models(self) -> List[str]:
        """Get list of downloaded model IDs."""
        return [
            info["id"] for info in AVAILABLE_MODELS.values()
            if self._is_model_downloaded(info["id"])
        ]

    def get_loaded_models(self) -> List[str]:
        """Get list of currently loaded models."""
        loaded = []
        if self.base_model is not None:
            loaded.append("base")
        if self.voice_design_model is not None:
            loaded.append("voice_design")
        if self.custom_voice_model is not None:
            loaded.append("custom_voice")
        if self.tokenizer is not None:
            loaded.append("tokenizer")
        return loaded

    def _is_model_downloaded(self, model_id: str) -> bool:
        """Check if a model is downloaded."""
        # Check local simple folder format
        model_name = model_id.split("/")[-1]
        model_path = self.models_dir / model_name
        if model_path.exists():
            # Check if there are actual model files (not just config)
            files = list(model_path.glob("*.safetensors")) + list(model_path.glob("*.bin"))
            if files:
                return True

        # Check HuggingFace cache format (models--org--name)
        hf_cache_name = f"models--{model_id.replace('/', '--')}"
        hf_cache_path = self.models_dir / hf_cache_name
        if hf_cache_path.exists():
            blobs_path = hf_cache_path / "blobs"
            if blobs_path.exists() and any(blobs_path.iterdir()):
                return True

        # Also check default HuggingFace cache location
        try:
            from huggingface_hub import scan_cache_dir
            cache_info = scan_cache_dir()
            for repo in cache_info.repos:
                if repo.repo_id == model_id:
                    return True
        except Exception:
            pass

        # Check our custom cache location
        try:
            from huggingface_hub import scan_cache_dir
            cache_info = scan_cache_dir(str(self.models_dir))
            for repo in cache_info.repos:
                if repo.repo_id == model_id:
                    return True
        except Exception:
            pass

        return False

    def delete_model(self, model_id: str) -> bool:
        """Delete a downloaded model from disk."""
        import shutil
        deleted = False

        # Check local simple folder format
        model_name = model_id.split("/")[-1]
        model_path = self.models_dir / model_name
        if model_path.exists():
            shutil.rmtree(model_path)
            logger.info(f"Deleted model folder: {model_path}")
            deleted = True

        # Check HuggingFace cache format
        hf_cache_name = f"models--{model_id.replace('/', '--')}"
        hf_cache_path = self.models_dir / hf_cache_name
        if hf_cache_path.exists():
            shutil.rmtree(hf_cache_path)
            logger.info(f"Deleted HF cache folder: {hf_cache_path}")
            deleted = True

        return deleted

    def _is_model_loaded(self, model_type: str) -> bool:
        """Check if a model type is loaded."""
        if model_type == "base":
            return self.base_model is not None
        elif model_type == "voice_design":
            return self.voice_design_model is not None
        elif model_type == "custom_voice":
            return self.custom_voice_model is not None
        elif model_type == "tokenizer":
            return self.tokenizer is not None
        return False

    def _get_model_path(self, model_id: str) -> Path:
        """Get local path for a model."""
        model_name = model_id.split("/")[-1]
        return self.models_dir / model_name

    def start_model_download(self, model_id: str) -> str:
        """Start downloading a model in the background."""
        task = DownloadTask(model_id)
        self.download_tasks[task.task_id] = task

        def download_thread():
            try:
                task.status = "downloading"
                from huggingface_hub import snapshot_download, HfApi, hf_hub_download
                import os

                logger.info(f"Starting download for {model_id}")

                # Get repo info to count files and sizes
                try:
                    api = HfApi()
                    repo_info = api.repo_info(model_id, files_metadata=True)
                    siblings = list(repo_info.siblings) if repo_info.siblings else []
                    task.total_files = len(siblings)
                    task.total_bytes = sum(s.size or 0 for s in siblings)
                    logger.info(f"Model has {task.total_files} files, total size: {task.total_bytes / 1e9:.2f} GB")
                except Exception as e:
                    logger.warning(f"Could not get repo info: {e}")
                    task.total_files = 0
                    task.total_bytes = 0

                # Custom tqdm class to track per-file download progress
                from tqdm.auto import tqdm as base_tqdm

                class DownloadProgressTqdm(base_tqdm):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, **kwargs)
                        # Each tqdm instance tracks one file download
                        desc = kwargs.get('desc', '') or (args[0] if args and isinstance(args[0], str) else '')
                        if hasattr(self, 'desc') and self.desc:
                            task.current_file = self.desc
                            logger.info(f"Downloading: {self.desc}")

                    def update(self, n=1):
                        result = super().update(n)
                        # Update byte-level progress
                        if self.total and self.total > 0:
                            task.downloaded_bytes += n
                        return result

                    def close(self):
                        super().close()
                        # When a file finishes, increment file count
                        if self.total and self.n >= self.total:
                            task.files_completed += 1
                            if task.total_files > 0:
                                task.progress = (task.files_completed / task.total_files) * 100
                            logger.info(f"Completed file {task.files_completed}/{task.total_files}: {self.desc}")

                # Download using snapshot_download which downloads ALL files
                local_path = snapshot_download(
                    repo_id=model_id,
                    cache_dir=str(self.models_dir),
                    tqdm_class=DownloadProgressTqdm,
                )

                logger.info(f"Download completed to: {local_path}")

                # Verify the download by checking for model files
                model_files = []
                for ext in ['*.safetensors', '*.bin', '*.pt']:
                    import glob
                    model_files.extend(glob.glob(os.path.join(local_path, '**', ext), recursive=True))

                if model_files:
                    logger.info(f"Found {len(model_files)} model weight files")
                else:
                    logger.warning(f"No model weight files found in {local_path}")

                # Also download the tokenizer if not already present
                tokenizer_id = AVAILABLE_MODELS["tokenizer"]["id"]
                if not self._is_model_downloaded(tokenizer_id):
                    logger.info(f"Also downloading tokenizer: {tokenizer_id}")
                    task.current_file = "tokenizer"
                    snapshot_download(
                        repo_id=tokenizer_id,
                        cache_dir=str(self.models_dir),
                    )
                    logger.info("Tokenizer downloaded successfully")

                task.status = "completed"
                task.progress = 100.0
                task.completed = True
                task.files_completed = task.total_files
                logger.info(f"Model {model_id} downloaded successfully")

            except Exception as e:
                task.status = "error"
                task.error = str(e)
                logger.error(f"Failed to download model {model_id}: {e}")
                import traceback
                logger.error(traceback.format_exc())

        thread = threading.Thread(target=download_thread, daemon=True)
        thread.start()

        return task.task_id

    def get_download_progress(self, task_id: str) -> Optional[dict]:
        """Get download progress for a task."""
        task = self.download_tasks.get(task_id)
        if not task:
            return None

        return {
            "task_id": task.task_id,
            "model_id": task.model_id,
            "status": task.status,
            "progress": task.progress,
            "downloaded_bytes": task.downloaded_bytes,
            "total_bytes": task.total_bytes,
            "current_file": task.current_file,
            "files_completed": task.files_completed,
            "total_files": task.total_files,
            "error": task.error,
            "completed": task.completed
        }

    def load_model(self, model_type: str, model_size: str = "1.7B") -> str:
        """Load a model into memory."""
        logger.info(f"=== Starting load_model: type={model_type}, size={model_size} ===")

        try:
            from qwen_tts import Qwen3TTSModel, Qwen3TTSTokenizer
            logger.info("Successfully imported qwen_tts")
        except ImportError as e:
            logger.error(f"Failed to import qwen_tts: {e}")
            raise RuntimeError(f"qwen_tts not installed: {e}")

        # Determine which model to load
        if model_type == "base":
            model_key = f"base_{model_size}"
        elif model_type == "voice_design":
            model_key = f"voice_design_{model_size}"
        elif model_type == "custom_voice":
            model_key = f"custom_voice_{model_size}"
        else:
            raise ValueError(f"Unknown model type: {model_type}")

        if model_key not in AVAILABLE_MODELS:
            raise ValueError(f"Unknown model: {model_key}")

        model_info = AVAILABLE_MODELS[model_key]
        model_id = model_info["id"]
        logger.info(f"Will load model: {model_id}")

        # Set HF_HOME to use our models directory for consistency
        import os
        os.environ["HF_HOME"] = str(self.models_dir)
        os.environ["HUGGINGFACE_HUB_CACHE"] = str(self.models_dir)

        # Load tokenizer first if not loaded
        if self.tokenizer is None:
            tokenizer_id = AVAILABLE_MODELS["tokenizer"]["id"]
            logger.info(f"Loading tokenizer {tokenizer_id}...")
            try:
                self.tokenizer = Qwen3TTSTokenizer.from_pretrained(
                    tokenizer_id,
                    device_map=self.device,
                )
                logger.info("Tokenizer loaded successfully")
            except Exception as e:
                logger.error(f"Failed to load tokenizer: {e}")
                import traceback
                logger.error(traceback.format_exc())
                raise RuntimeError(f"Failed to load tokenizer: {e}")

        # Load the model using HuggingFace ID directly
        # Note: Using device_map and dtype compatible with MPS
        model_kwargs = {
            "device_map": self.device,
            "torch_dtype": self.dtype,
        }

        # Only use flash_attention_2 on CUDA
        if self.device.startswith("cuda"):
            model_kwargs["attn_implementation"] = "flash_attention_2"

        logger.info(f"Loading model {model_id} with kwargs: {model_kwargs}")
        logger.info("This may take a while if the model needs to be downloaded...")

        try:
            model = Qwen3TTSModel.from_pretrained(model_id, **model_kwargs)
            logger.info(f"Model loaded, type: {type(model)}")
        except Exception as e:
            logger.error(f"Failed to load model {model_id}: {e}")
            import traceback
            logger.error(traceback.format_exc())
            raise RuntimeError(f"Failed to load model: {e}")

        # Assign to appropriate slot
        if model_type == "base":
            self.base_model = model
            logger.info("Assigned to base_model slot")
        elif model_type == "voice_design":
            self.voice_design_model = model
            logger.info("Assigned to voice_design_model slot")
        elif model_type == "custom_voice":
            self.custom_voice_model = model
            logger.info("Assigned to custom_voice_model slot")

        self._loaded_model_sizes[model_type] = model_size
        logger.info(f"=== Model {model_id} loaded successfully ===")
        return model_id

    def _clear_memory_cache(self):
        """Force garbage collection and clear GPU/MPS memory caches."""
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

    def unload_models(self):
        """Unload all models from memory."""
        self.base_model = None
        self.voice_design_model = None
        self.custom_voice_model = None
        self.tokenizer = None
        self.voice_clone_prompts.clear()
        self._loaded_model_sizes.clear()

        self._clear_memory_cache()
        logger.info("All models unloaded")

    def unload_model(self, model_type: str):
        """Unload a single model slot."""
        if model_type == "base":
            self.base_model = None
            self.voice_clone_prompts.clear()
        elif model_type == "voice_design":
            self.voice_design_model = None
        elif model_type == "custom_voice":
            self.custom_voice_model = None
        else:
            raise ValueError(f"Unknown model type: {model_type}")

        self._loaded_model_sizes.pop(model_type, None)

        # Unload tokenizer if no models remain loaded
        if not any([self.base_model, self.voice_design_model, self.custom_voice_model]):
            self.tokenizer = None

        self._clear_memory_cache()
        logger.info(f"Model slot '{model_type}' unloaded")

    def get_loaded_models_detail(self) -> Dict[str, str]:
        """Return mapping of model_type -> loaded size (e.g. {'base': '1.7B'})."""
        return dict(self._loaded_model_sizes)

    def list_voices(self) -> List[dict]:
        """List all saved voice profiles."""
        return [p.model_dump() for p in self.voice_profiles.values()]

    def get_voice(self, voice_id: str) -> Optional[dict]:
        """Get a specific voice profile."""
        profile = self.voice_profiles.get(voice_id)
        return profile.model_dump() if profile else None

    def delete_voice(self, voice_id: str) -> bool:
        """Delete a voice profile."""
        if voice_id not in self.voice_profiles:
            return False

        profile = self.voice_profiles[voice_id]

        # Delete sample audio if exists
        if profile.sample_audio_path:
            sample_path = Path(profile.sample_audio_path)
            if sample_path.exists():
                sample_path.unlink()

        # Remove from cache
        del self.voice_profiles[voice_id]
        if voice_id in self.voice_clone_prompts:
            del self.voice_clone_prompts[voice_id]

        self._save_voice_profiles()
        return True

    def clone_voice(
        self,
        voice_name: str,
        audio_path: str,
        reference_text: str
    ) -> VoiceProfile:
        """Clone a voice from an audio sample."""
        if self.base_model is None:
            raise RuntimeError("Base model not loaded. Load a base model first.")

        # Generate unique ID
        voice_id = str(uuid.uuid4())[:8]

        # Save the reference audio to voices directory
        source_path = Path(audio_path)
        sample_filename = f"voice_{voice_id}_sample.wav"
        sample_path = self.voices_dir / sample_filename

        # If source is different from destination, copy it
        if source_path != sample_path:
            import shutil
            shutil.copy(source_path, sample_path)

        # Create voice clone prompt
        try:
            voice_clone_prompt = self.base_model.create_voice_clone_prompt(
                ref_audio=str(sample_path),
                ref_text=reference_text,
                x_vector_only_mode=False
            )
            self.voice_clone_prompts[voice_id] = voice_clone_prompt
        except Exception as e:
            logger.error(f"Failed to create voice clone prompt: {e}")
            # Continue anyway, we can recreate the prompt later

        # Create voice profile
        profile = VoiceProfile(
            id=voice_id,
            name=voice_name,
            type="cloned",
            created_at=datetime.now().isoformat(),
            language="English",
            reference_text=reference_text,
            sample_audio_path=str(sample_path)
        )

        self.voice_profiles[voice_id] = profile
        self._save_voice_profiles()

        logger.info(f"Voice cloned: {voice_name} ({voice_id})")
        return profile

    def design_voice(
        self,
        voice_name: str,
        instruction: str,
        sample_text: str,
        language: str = "English",
        **generation_kwargs
    ) -> VoiceProfile:
        """Design a new voice from text instructions."""
        if self.voice_design_model is None:
            raise RuntimeError("Voice design model not loaded. Load the voice design model first.")

        # Merge defaults with caller overrides
        gen_kwargs = {**DEFAULT_GENERATION_KWARGS, **generation_kwargs}

        # Generate unique ID
        voice_id = str(uuid.uuid4())[:8]

        # Generate sample audio with the designed voice
        wavs, sr = self.voice_design_model.generate_voice_design(
            text=sample_text,
            language=language,
            instruct=instruction,
            **gen_kwargs
        )

        # Save the sample audio
        sample_filename = f"voice_{voice_id}_sample.wav"
        sample_path = self.voices_dir / sample_filename
        sf.write(str(sample_path), wavs[0], sr)

        del wavs
        self._clear_memory_cache()

        # Now create a clone prompt from the designed voice
        if self.base_model is not None:
            try:
                voice_clone_prompt = self.base_model.create_voice_clone_prompt(
                    ref_audio=(wavs[0], sr),
                    ref_text=sample_text,
                    x_vector_only_mode=False
                )
                self.voice_clone_prompts[voice_id] = voice_clone_prompt
            except Exception as e:
                logger.error(f"Failed to create voice clone prompt from designed voice: {e}")

        # Create voice profile
        profile = VoiceProfile(
            id=voice_id,
            name=voice_name,
            type="designed",
            created_at=datetime.now().isoformat(),
            language=language,
            reference_text=sample_text,
            instruction=instruction,
            sample_audio_path=str(sample_path)
        )

        self.voice_profiles[voice_id] = profile
        self._save_voice_profiles()

        logger.info(f"Voice designed: {voice_name} ({voice_id})")
        return profile

    def get_speakers(self) -> List[str]:
        """Get list of predefined speakers from the custom voice model."""
        if self.custom_voice_model is None:
            return []
        try:
            return list(self.custom_voice_model.get_supported_speakers())
        except Exception as e:
            logger.error(f"Failed to get speakers: {e}")
            return []

    def generate_custom(
        self,
        text: str,
        speaker: str,
        language: str = "English",
        instruction: Optional[str] = None,
        **generation_kwargs
    ) -> Path:
        """Generate audio using the custom voice model with a predefined speaker."""
        if self.custom_voice_model is None:
            raise RuntimeError("Custom voice model not loaded.")

        # Merge defaults with caller overrides
        gen_kwargs = {**DEFAULT_GENERATION_KWARGS, **generation_kwargs}
        logger.info(f"generate_custom() params: text={text[:80]!r}, speaker={speaker}, language={language}, instruction={instruction!r}, gen_kwargs={gen_kwargs}")

        output_filename = f"output_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.wav"
        output_path = self.output_dir / output_filename

        kwargs = {
            "text": text,
            "speaker": speaker,
            "language": language,
            **gen_kwargs,
        }
        if instruction:
            kwargs["instruct"] = instruction

        wavs, sr = self.custom_voice_model.generate_custom_voice(**kwargs)
        sf.write(str(output_path), wavs[0], sr)
        del wavs
        self._clear_memory_cache()
        self._record_output_metadata(
            output_path.name, text,
            language=language, speaker=speaker, instruction=instruction,
        )
        logger.info(f"Generated custom voice audio: {output_path}")

        return output_path

    def batch_generate_custom(
        self,
        texts: List[str],
        speaker: str,
        language: str = "English",
        instruction: Optional[str] = None,
        output_prefix: str = "audio",
        **generation_kwargs
    ) -> List[Path]:
        """Batch generate audio using the custom voice model with a predefined speaker."""
        if self.custom_voice_model is None:
            raise RuntimeError("Custom voice model not loaded.")

        # Merge defaults with caller overrides
        gen_kwargs = {**DEFAULT_GENERATION_KWARGS, **generation_kwargs}
        logger.info(f"batch_generate_custom() params: {len(texts)} texts, speaker={speaker}, language={language}, instruction={instruction!r}, gen_kwargs={gen_kwargs}")

        output_paths = []
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

        kwargs = {
            "text": texts,
            "speaker": [speaker] * len(texts),
            "language": [language] * len(texts),
            **gen_kwargs,
        }
        if instruction:
            kwargs["instruct"] = [instruction] * len(texts)

        wavs, sr = self.custom_voice_model.generate_custom_voice(**kwargs)

        for i, wav in enumerate(wavs):
            output_filename = f"{output_prefix}_{timestamp}_{i+1:03d}.wav"
            output_path = self.output_dir / output_filename
            sf.write(str(output_path), wav, sr)
            output_paths.append(output_path)
            self._record_output_metadata(
                output_filename, texts[i],
                language=language, speaker=speaker, instruction=instruction,
            )
            logger.info(f"Generated custom voice audio: {output_path}")

        del wavs
        self._clear_memory_cache()

        return output_paths

    def _get_voice_clone_prompt(self, voice_id: str) -> Any:
        """Get or recreate voice clone prompt."""
        if voice_id in self.voice_clone_prompts:
            return self.voice_clone_prompts[voice_id]

        profile = self.voice_profiles.get(voice_id)
        if not profile:
            raise ValueError(f"Voice not found: {voice_id}")

        if not profile.sample_audio_path:
            raise ValueError(f"Voice has no sample audio: {voice_id}")

        # Recreate the prompt
        voice_clone_prompt = self.base_model.create_voice_clone_prompt(
            ref_audio=profile.sample_audio_path,
            ref_text=profile.reference_text or "",
            x_vector_only_mode=False
        )
        self.voice_clone_prompts[voice_id] = voice_clone_prompt

        return voice_clone_prompt

    def _ensure_default_reference_audio(self) -> Path:
        """Ensure default reference audio exists, create if needed."""
        ref_path = self.voices_dir / "default_reference.wav"
        if not ref_path.exists():
            # Create default reference using macOS say command if available
            import subprocess
            try:
                aiff_path = self.voices_dir / "default_reference.aiff"
                subprocess.run([
                    "say", "-v", "Samantha",
                    "Hello, this is a sample of my voice. I hope you find it pleasant and easy to listen to.",
                    "-o", str(aiff_path)
                ], check=True, capture_output=True)

                subprocess.run([
                    "afconvert", "-f", "WAVE", "-d", "LEI16",
                    str(aiff_path), str(ref_path)
                ], check=True, capture_output=True)

                aiff_path.unlink()
                logger.info(f"Created default reference audio: {ref_path}")
            except Exception as e:
                logger.warning(f"Could not create default reference audio: {e}")
                # Create a simple sine wave as fallback
                import numpy as np
                duration = 3.0
                sr = 24000
                t = np.linspace(0, duration, int(sr * duration))
                # Create a simple tone (this won't sound good but will work)
                audio = 0.3 * np.sin(2 * np.pi * 440 * t).astype(np.float32)
                sf.write(str(ref_path), audio, sr)
                logger.info(f"Created fallback reference audio: {ref_path}")

        return ref_path

    def generate(
        self,
        text: str,
        language: str = "English",
        voice_id: Optional[str] = None,
        **generation_kwargs
    ) -> Path:
        """Generate audio from text."""
        if self.base_model is None:
            raise RuntimeError("Base model not loaded. Load a base model first.")

        # Merge defaults with caller overrides
        gen_kwargs = {**DEFAULT_GENERATION_KWARGS, **generation_kwargs}
        logger.info(f"generate() params: text={text[:80]!r}, language={language}, voice_id={voice_id}, gen_kwargs={gen_kwargs}")

        # Generate unique output filename
        output_filename = f"output_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.wav"
        output_path = self.output_dir / output_filename

        if voice_id:
            # Generate with cloned voice
            voice_clone_prompt = self._get_voice_clone_prompt(voice_id)
            wavs, sr = self.base_model.generate_voice_clone(
                text=text,
                language=language,
                voice_clone_prompt=voice_clone_prompt,
                **gen_kwargs
            )
        else:
            # Generate with default voice using local reference audio
            ref_path = self._ensure_default_reference_audio()
            ref_text = "Hello, this is a sample of my voice. I hope you find it pleasant and easy to listen to."

            wavs, sr = self.base_model.generate_voice_clone(
                text=text,
                language=language,
                ref_audio=str(ref_path),
                ref_text=ref_text,
                **gen_kwargs
            )

        sf.write(str(output_path), wavs[0], sr)
        del wavs
        self._clear_memory_cache()
        self._record_output_metadata(
            output_path.name, text,
            language=language, voice_id=voice_id,
        )
        logger.info(f"Generated audio: {output_path}")

        return output_path

    def batch_generate(
        self,
        texts: List[str],
        language: str = "English",
        voice_id: Optional[str] = None,
        output_prefix: str = "audio",
        **generation_kwargs
    ) -> List[Path]:
        """Generate multiple audio files from a list of texts."""
        if self.base_model is None:
            raise RuntimeError("Base model not loaded. Load a base model first.")

        # Merge defaults with caller overrides
        gen_kwargs = {**DEFAULT_GENERATION_KWARGS, **generation_kwargs}
        logger.info(f"batch_generate() params: {len(texts)} texts, language={language}, voice_id={voice_id}, gen_kwargs={gen_kwargs}")

        output_paths = []
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

        # Get voice clone prompt if using a custom voice
        voice_clone_prompt = None
        if voice_id:
            voice_clone_prompt = self._get_voice_clone_prompt(voice_id)

        # Batch generate
        languages = [language] * len(texts)

        if voice_clone_prompt:
            wavs, sr = self.base_model.generate_voice_clone(
                text=texts,
                language=languages,
                voice_clone_prompt=voice_clone_prompt,
                **gen_kwargs
            )
        else:
            # Use local default reference audio
            ref_path = self._ensure_default_reference_audio()
            ref_text = "Hello, this is a sample of my voice. I hope you find it pleasant and easy to listen to."

            wavs, sr = self.base_model.generate_voice_clone(
                text=texts,
                language=languages,
                ref_audio=str(ref_path),
                ref_text=ref_text,
                **gen_kwargs
            )

        # Save each output
        for i, wav in enumerate(wavs):
            output_filename = f"{output_prefix}_{timestamp}_{i+1:03d}.wav"
            output_path = self.output_dir / output_filename
            sf.write(str(output_path), wav, sr)
            output_paths.append(output_path)
            self._record_output_metadata(
                output_filename, texts[i],
                language=language, voice_id=voice_id,
            )
            logger.info(f"Generated audio: {output_path}")

        del wavs
        self._clear_memory_cache()

        return output_paths

    def cleanup(self):
        """Cleanup resources."""
        self.unload_models()
        logger.info("TTS Service cleaned up")
