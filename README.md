# Audio TTS

Desktop text-to-speech app using Qwen3-TTS for 100% local voice design, cloning, and generation. Built with [Electrobun](https://github.com/blackboardsh/electrobun).

## Demo

[![Audio TTS Demo](https://img.youtube.com/vi/Z4dNK1d6l6E/maxresdefault.jpg)](https://www.youtube.com/watch?v=Z4dNK1d6l6E)

## Download

**macOS (Apple Silicon):**

[Download Audio TTS (.dmg)](https://github.com/blackboardsh/audio-tts/releases/latest/download/stable-macos-arm64-AudioTTS.dmg)

## Features

- **Text-to-Speech** - Generate audio from text with multiple language support
- **Voice Cloning** - Clone any voice from a short audio sample
- **Voice Design** - Create new voices from text descriptions (e.g. "deep male voice, British accent")
- **Built-in Instruct Voices** - Predefined speakers with instruction control ("speak warmly", "sound excited")
- **Batch Generation** - Generate multiple audio files from a script
- **Tiny App** - Core app is only ~16MB thanks to [Electrobun](https://github.com/blackboardsh/electrobun)
- **Auto-updating** - Built-in update mechanism for new releases

## Models

All models are downloaded automatically on first use — just select a model size from the dropdown and the app handles the rest. No manual setup required.

| Slot | Purpose | When to load |
|------|---------|-------------|
| **Base Text to Speech** | Audio generation and voice cloning | Always - required for all generation |
| **Create Voice Design/Clone** | Create voices from text descriptions | Only when designing a new voice, can unload after |
| **Built-in Instruct Voices** | Predefined speakers + instruction control | Only when using built-in speakers |


