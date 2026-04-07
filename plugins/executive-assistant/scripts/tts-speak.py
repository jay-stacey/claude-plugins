#!/usr/bin/env python3
"""
ElevenLabs TTS Hook for Claude Code
Reads the latest assistant response and speaks it aloud using Bella's voice.

Environment Variables:
    ELEVENLABS_API_KEY: Your ElevenLabs API key (required)
    ELEVENLABS_VOICE_ID: Voice ID to use (default: Bella - warm, conversational)

Usage:
    This script is called automatically by Claude Code's Stop hook.
    It reads hook input from stdin and extracts the transcript path.
"""
import json
import os
import sys
from pathlib import Path

# Configuration
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")  # Bella (warm, conversational)
MODEL_ID = "eleven_multilingual_v2"
MAX_TEXT_LENGTH = 3000  # Avoid extremely long audio
MIN_TEXT_LENGTH = 10    # Skip very short responses


def get_latest_response(transcript_path: str) -> str | None:
    """Extract the last assistant message from transcript.

    Args:
        transcript_path: Path to the JSONL transcript file

    Returns:
        The text content of the last assistant message, or None if not found
    """
    if not Path(transcript_path).exists():
        return None

    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except (IOError, OSError) as e:
        print(f"Error reading transcript: {e}", file=sys.stderr)
        return None

    # Find last assistant message (reverse search)
    for line in reversed(lines):
        try:
            entry = json.loads(line.strip())
            # Handle nested format: {"type": "assistant", "message": {"role": "assistant", "content": [...]}}
            if entry.get("type") == "assistant":
                msg = entry.get("message", {})
            elif entry.get("role") == "assistant":
                msg = entry
            else:
                continue

            # Extract text from content blocks
            content = msg.get("content", [])
            texts = []
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    texts.append(c.get("text", ""))
                elif isinstance(c, str):
                    texts.append(c)
            return " ".join(texts)
        except json.JSONDecodeError:
            continue
    return None


def should_speak(text: str) -> bool:
    """Determine if the response should be spoken aloud.

    Filters out:
    - Empty or very short responses
    - Code-heavy responses (>30% code blocks)

    Args:
        text: The response text to evaluate

    Returns:
        True if the response should be spoken, False otherwise
    """
    if not text or len(text.strip()) < MIN_TEXT_LENGTH:
        return False

    # Skip if mostly code blocks
    code_block_count = text.count("```")
    if code_block_count > 0:
        # Rough heuristic: if code blocks dominate, skip
        code_ratio = code_block_count / max(len(text) / 100, 1)
        if code_ratio > 0.3:
            return False

    return True


def clean_for_speech(text: str) -> str:
    """Remove markdown/code that sounds bad when spoken.

    Removes:
    - Code blocks (replaced with brief mention)
    - Inline code
    - Markdown links (keeps link text)
    - Markdown formatting characters
    - Truncates very long text

    Args:
        text: Raw markdown text

    Returns:
        Cleaned text suitable for speech synthesis
    """
    import re

    # Remove code blocks entirely (they'll sound terrible)
    text = re.sub(r'```[\s\S]*?```', '', text)

    # Remove inline code
    text = re.sub(r'`[^`]+`', '', text)

    # Remove markdown links, keep the display text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)

    # Remove markdown formatting characters
    text = re.sub(r'[*_#>|]', '', text)

    # Remove table formatting
    text = re.sub(r'\|[^\n]+\|', '', text)
    text = re.sub(r'-{3,}', '', text)

    # Clean up excessive whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' {2,}', ' ', text)

    # Truncate if too long
    if len(text) > MAX_TEXT_LENGTH:
        # Try to cut at a sentence boundary
        truncated = text[:MAX_TEXT_LENGTH]
        last_period = truncated.rfind('.')
        if last_period > MAX_TEXT_LENGTH * 0.7:
            truncated = truncated[:last_period + 1]
        text = truncated

    return text.strip()


def speak(text: str) -> None:
    """Generate and play TTS audio using ElevenLabs.

    Uses streaming for faster playback start time.

    Args:
        text: The text to convert to speech

    Raises:
        ImportError: If elevenlabs package is not installed
        Exception: If API call fails
    """
    if not ELEVENLABS_API_KEY:
        print("ELEVENLABS_API_KEY not set. Skipping TTS.", file=sys.stderr)
        return

    try:
        from elevenlabs.client import ElevenLabs
        from elevenlabs import stream as el_stream

        client = ElevenLabs(api_key=ELEVENLABS_API_KEY)

        # Use streaming for faster playback start
        audio_stream = client.text_to_speech.stream(
            text=text,
            voice_id=VOICE_ID,
            model_id=MODEL_ID,
            output_format="mp3_22050_32"  # Lower quality for faster streaming
        )

        el_stream(audio_stream)

    except ImportError:
        print("ElevenLabs SDK not installed. Run: pip install elevenlabs", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"TTS Error: {e}", file=sys.stderr)
        # Don't exit with error - TTS failure shouldn't break the workflow
        return


def main() -> None:
    """Main entry point for the TTS hook."""
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        # No valid input, exit silently
        sys.exit(0)

    # Check if we're in a stop hook loop
    if hook_input.get("stop_hook_active"):
        sys.exit(0)

    transcript_path = hook_input.get("transcript_path")
    if not transcript_path:
        sys.exit(0)

    # Get and process response
    response = get_latest_response(transcript_path)
    if not response or not should_speak(response):
        sys.exit(0)

    clean_text = clean_for_speech(response)
    if clean_text and len(clean_text) >= MIN_TEXT_LENGTH:
        speak(clean_text)


if __name__ == "__main__":
    main()
