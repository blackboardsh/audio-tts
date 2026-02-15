#!/usr/bin/env python3
"""
Audio TTS Backend Server
FastAPI server providing TTS generation, voice cloning, and voice design capabilities.
"""

import os
import sys
import json
import asyncio
import logging
from pathlib import Path
from typing import Optional, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, Form, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from tts_service import TTSService, ModelInfo, VoiceProfile

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global TTS service instance
tts_service: Optional[TTSService] = None

# App data directory
APP_DATA_DIR = Path.home() / ".audio-tts"
MODELS_DIR = APP_DATA_DIR / "models"
VOICES_DIR = APP_DATA_DIR / "voices"
OUTPUT_DIR = APP_DATA_DIR / "output"

# Ensure directories exist
for dir_path in [APP_DATA_DIR, MODELS_DIR, VOICES_DIR, OUTPUT_DIR]:
    dir_path.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    global tts_service
    logger.info("Starting Audio TTS Backend...")
    tts_service = TTSService(
        models_dir=MODELS_DIR,
        voices_dir=VOICES_DIR,
        output_dir=OUTPUT_DIR
    )
    yield
    logger.info("Shutting down Audio TTS Backend...")
    if tts_service:
        tts_service.cleanup()


app = FastAPI(
    title="Audio TTS Backend",
    description="TTS generation service using Qwen3-TTS",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Request/Response Models ---

class StatusResponse(BaseModel):
    status: str
    message: str
    data: Optional[dict] = None


class GenerateRequest(BaseModel):
    text: str
    language: str = "English"
    voice_id: Optional[str] = None
    speaker: Optional[str] = None
    instruction: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    repetition_penalty: Optional[float] = None


class BatchGenerateRequest(BaseModel):
    texts: List[str]
    language: str = "English"
    voice_id: Optional[str] = None
    speaker: Optional[str] = None
    instruction: Optional[str] = None
    output_prefix: str = "audio"
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    repetition_penalty: Optional[float] = None


class VoiceDesignRequest(BaseModel):
    instruction: str
    sample_text: str
    language: str = "English"
    voice_name: str


class ModelDownloadRequest(BaseModel):
    model_id: str


class ModelLoadRequest(BaseModel):
    model_type: str  # "base", "voice_design", or "custom_voice"
    model_size: str = "1.7B"  # "0.6B" or "1.7B"


# --- Health & Status Endpoints ---

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "audio-tts-backend"}


@app.get("/status")
async def get_status():
    """Get current service status."""
    if not tts_service:
        return StatusResponse(status="error", message="Service not initialized")

    return StatusResponse(
        status="ok",
        message="Service running",
        data={
            "models_loaded": tts_service.get_loaded_models(),
            "available_voices": tts_service.list_voices(),
            "models_dir": str(MODELS_DIR),
            "voices_dir": str(VOICES_DIR),
            "output_dir": str(OUTPUT_DIR),
        }
    )


# --- Model Management Endpoints ---

@app.get("/models")
async def list_models():
    """List available and downloaded models."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    return {
        "available": tts_service.get_available_models(),
        "downloaded": tts_service.get_downloaded_models(),
        "loaded": tts_service.get_loaded_models(),
        "loaded_detail": tts_service.get_loaded_models_detail()
    }


@app.post("/models/download")
async def download_model(request: ModelDownloadRequest, background_tasks: BackgroundTasks):
    """Start downloading a model from HuggingFace."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    # Start download in background
    task_id = tts_service.start_model_download(request.model_id)

    return {
        "status": "started",
        "task_id": task_id,
        "model_id": request.model_id
    }


@app.get("/models/download/{task_id}")
async def get_download_progress(task_id: str):
    """Get model download progress."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    progress = tts_service.get_download_progress(task_id)
    if progress is None:
        raise HTTPException(status_code=404, detail="Download task not found")

    return progress


@app.post("/models/load")
async def load_model(request: ModelLoadRequest):
    """Load a model into memory. This can take several minutes for large models."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    logger.info(f"Received load request: type={request.model_type}, size={request.model_size}")

    try:
        # Model loading can take a very long time (minutes for large models)
        result = await asyncio.to_thread(
            tts_service.load_model,
            request.model_type,
            request.model_size
        )
        logger.info(f"Model loaded successfully: {result}")
        return {"status": "loaded", "model": result}
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/models/unload")
async def unload_models():
    """Unload all models from memory."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    tts_service.unload_models()
    return {"status": "unloaded"}


@app.post("/models/unload/{model_type}")
async def unload_model(model_type: str):
    """Unload a single model slot (base, voice_design, or custom_voice)."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    valid_types = ["base", "voice_design", "custom_voice"]
    if model_type not in valid_types:
        raise HTTPException(status_code=400, detail=f"Invalid model type. Must be one of: {valid_types}")

    try:
        tts_service.unload_model(model_type)
        return {"status": "unloaded", "model_type": model_type}
    except Exception as e:
        logger.error(f"Failed to unload model {model_type}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/models/{model_id:path}")
async def delete_model(model_id: str):
    """Delete a downloaded model from disk."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    try:
        deleted = tts_service.delete_model(model_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Model not found on disk")
        return {"status": "deleted", "model_id": model_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete model {model_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/models/speakers")
async def get_speakers():
    """Get list of predefined speakers from the custom voice model."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    return {"speakers": tts_service.get_speakers()}


# --- Voice Management Endpoints ---

@app.get("/voices")
async def list_voices():
    """List all saved voice profiles."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    return {"voices": tts_service.list_voices()}


@app.get("/voices/{voice_id}")
async def get_voice(voice_id: str):
    """Get a specific voice profile."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    voice = tts_service.get_voice(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail="Voice not found")

    return voice


@app.delete("/voices/{voice_id}")
async def delete_voice(voice_id: str):
    """Delete a voice profile."""
    logger.info(f"Delete voice request for: {voice_id}")

    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    try:
        success = tts_service.delete_voice(voice_id)
        if not success:
            logger.warning(f"Voice not found: {voice_id}")
            raise HTTPException(status_code=404, detail="Voice not found")

        logger.info(f"Voice deleted successfully: {voice_id}")
        return {"status": "deleted", "voice_id": voice_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting voice {voice_id}: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


# --- Voice Cloning Endpoints ---

@app.post("/voices/clone")
async def clone_voice(
    voice_name: str = Form(...),
    reference_text: str = Form(...),
    audio_file: UploadFile = File(...)
):
    """Clone a voice from an audio sample."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    # Save uploaded audio temporarily
    temp_audio_path = OUTPUT_DIR / f"temp_clone_{audio_file.filename}"
    try:
        content = await audio_file.read()
        with open(temp_audio_path, "wb") as f:
            f.write(content)

        # Clone the voice
        voice_profile = await asyncio.to_thread(
            tts_service.clone_voice,
            voice_name,
            str(temp_audio_path),
            reference_text
        )

        return {
            "status": "created",
            "voice": voice_profile.model_dump() if hasattr(voice_profile, 'model_dump') else voice_profile
        }
    except Exception as e:
        logger.error(f"Failed to clone voice: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if temp_audio_path.exists():
            temp_audio_path.unlink()


# --- Voice Design Endpoints ---

@app.post("/voices/design")
async def design_voice(request: VoiceDesignRequest):
    """Design a new voice from text instructions."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    try:
        voice_profile = await asyncio.to_thread(
            tts_service.design_voice,
            request.voice_name,
            request.instruction,
            request.sample_text,
            request.language
        )

        return {
            "status": "created",
            "voice": voice_profile.model_dump() if hasattr(voice_profile, 'model_dump') else voice_profile
        }
    except Exception as e:
        logger.error(f"Failed to design voice: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# --- TTS Generation Endpoints ---

def _extract_generation_kwargs(request) -> dict:
    """Extract non-None generation kwargs from a request."""
    kwargs = {}
    for key in ("temperature", "top_p", "repetition_penalty"):
        val = getattr(request, key, None)
        if val is not None:
            kwargs[key] = val
    return kwargs


@app.post("/generate")
async def generate_audio(request: GenerateRequest):
    """Generate audio from text."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    gen_kwargs = _extract_generation_kwargs(request)

    try:
        if request.speaker and tts_service.custom_voice_model is not None:
            output_path = await asyncio.to_thread(
                tts_service.generate_custom,
                request.text,
                request.speaker,
                request.language,
                request.instruction,
                **gen_kwargs
            )
        else:
            output_path = await asyncio.to_thread(
                tts_service.generate,
                request.text,
                request.language,
                request.voice_id,
                **gen_kwargs
            )

        return {
            "status": "generated",
            "output_path": str(output_path),
            "filename": output_path.name
        }
    except Exception as e:
        logger.error(f"Failed to generate audio: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate/batch")
async def batch_generate_audio(request: BatchGenerateRequest):
    """Generate multiple audio files from a list of texts."""
    if not tts_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    gen_kwargs = _extract_generation_kwargs(request)

    try:
        if request.speaker and tts_service.custom_voice_model is not None:
            output_paths = await asyncio.to_thread(
                tts_service.batch_generate_custom,
                request.texts,
                request.speaker,
                request.language,
                request.instruction,
                request.output_prefix,
                **gen_kwargs
            )
        else:
            output_paths = await asyncio.to_thread(
                tts_service.batch_generate,
                request.texts,
                request.language,
                request.voice_id,
                request.output_prefix,
                **gen_kwargs
            )

        return {
            "status": "generated",
            "outputs": [
                {"path": str(p), "filename": p.name}
                for p in output_paths
            ]
        }
    except Exception as e:
        logger.error(f"Failed to batch generate audio: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/audio/{filename}")
async def get_audio_file(filename: str):
    """Download a generated audio file."""
    file_path = OUTPUT_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        file_path,
        media_type="audio/wav",
        filename=filename
    )


@app.get("/voices/audio/{filename}")
async def get_voice_audio_file(filename: str):
    """Download a voice sample audio file."""
    file_path = VOICES_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        file_path,
        media_type="audio/wav",
        filename=filename
    )


@app.get("/output")
async def list_output_files():
    """List all generated audio files."""
    files = []
    for f in OUTPUT_DIR.glob("*.wav"):
        files.append({
            "filename": f.name,
            "path": str(f),
            "size": f.stat().st_size,
            "modified": f.stat().st_mtime
        })
    return {"files": sorted(files, key=lambda x: x["modified"], reverse=True)}


@app.delete("/output/{filename}")
async def delete_output_file(filename: str):
    """Delete a generated audio file."""
    file_path = OUTPUT_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    file_path.unlink()
    return {"status": "deleted", "filename": filename}


# --- Main Entry Point ---

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8765))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
