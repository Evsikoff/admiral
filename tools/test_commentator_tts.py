import base64
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import wave

from commentator_data import MODEL_31, MODEL_38, PERSONAS, VOICES
from commentator_tts import build_payload, read_audio, synthesize


def audio_part(mime, content):
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(content).decode()}}


def reply(*parts):
    return {"candidates": [{"finishReason": "STOP", "content": {"parts": parts}}]}


class CommentatorTTSTest(unittest.TestCase):
    def setUp(self):
        self.item = dict(PERSONAS["ru"], nation="ru", voice=VOICES["ru"], model=MODEL_31,
                         voice_text="Курс верный.", mood="Speak with relief.")

    def test_directions_and_transcript(self):
        self.item.update(profile="A veteran navigator.", performance="Speak quietly.",
                         style="Old boatswain. Speak with relief.")
        prompt = build_payload(MODEL_31, self.item)["contents"][0]["parts"][0]["text"]
        self.assertIn("# AUDIO PROFILE\nA veteran navigator.", prompt)
        self.assertIn("### PERFORMANCE\nSpeak quietly.\nSpeak with relief.", prompt)
        self.assertIn("## SCENE\n" + self.item["scene"], prompt)
        self.assertIn("### CONTEXT\n" + self.item["context"], prompt)
        self.assertTrue(prompt.endswith("#### TRANSCRIPT\nКурс верный."))
        payload = build_payload(MODEL_38, self.item)
        self.assertEqual(payload["contents"][0]["parts"],
                         [{"text": self.item["voice_text"], "speech_metadata": {"style": self.item["style"]}}])
        config = payload["generationConfig"]["speechConfig"]
        self.assertEqual(config["languageCode"], "ru-RU")
        self.assertEqual(config["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"], VOICES["ru"])

    def test_join_wav_and_pcm_around_non_audio_parts(self):
        with io.BytesIO() as data:
            with wave.open(data, "wb") as wav:
                wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                wav.writeframes(b"\x01\x00" * 12000)
            wav_part = audio_part("audio/wav", data.getvalue())
        raw_part = audio_part("audio/L16;rate=24000", b"\x02\x00" * 12000)
        raw, mime, duration = read_audio(reply(wav_part, {"text": "metadata"}, raw_part))
        self.assertEqual((mime, duration), ("audio/wav", 1.0))
        with wave.open(io.BytesIO(raw)) as wav:
            self.assertEqual(wav.readframes(24000), b"\x01\x00" * 12000 + b"\x02\x00" * 12000)

    def test_incomplete_or_incompatible_response(self):
        good = audio_part("audio/L16;rate=24000", bytes(480))
        for response in (reply({"text": "No audio"}), reply(good, audio_part("audio/wav", b"broken")),
                         reply(good, audio_part("audio/L16;rate=16000", bytes(320))),
                         {"candidates": [{"finishReason": "SAFETY"}]}):
            with self.subTest(response=response), self.assertRaises(RuntimeError):
                read_audio(response)

    @patch("commentator_tts.shutil.which", return_value="ffmpeg")
    def test_api_region_error_does_not_expose_key(self, _which):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "gemini"
            key.write_text("test-key", encoding="utf-8-sig")
            error = {"error": {"status": "FAILED_PRECONDITION",
                               "message": "User location is not supported for the API use. test-key"}}
            http_error = HTTPError("", 400, "", {}, io.BytesIO(json.dumps(error).encode()))
            with patch("commentator_tts.urlopen", side_effect=http_error), self.assertRaises(RuntimeError) as ctx:
                synthesize(self.item, key)
            self.assertIn("регионе", str(ctx.exception))
            self.assertNotIn("test-key", str(ctx.exception))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and ffprobe required")
    def test_synthesis_encodes_a_game_ready_mp3(self):
        # A 500 Hz square wave keeps the loudness normalizer on a finite input.
        period = b"\xe8\x03" * 24 + b"\x18\xfc" * 24
        response = reply(audio_part("audio/L16;rate=24000", period * 500))
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "gemini"
            key.write_text("test-key")
            with patch("commentator_tts.urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as post:
                clip, duration = synthesize(self.item, key)
            request = post.call_args.args[0]
            self.assertEqual(request.headers["X-goog-api-key"], "test-key")
            self.assertNotIn("test-key", request.full_url)
            self.assertTrue(request.full_url.endswith(f"/{MODEL_31}:generateContent"))
            self.assertEqual(duration, 1)
            file = Path(directory) / "take.mp3"
            file.write_bytes(clip)
            probe = subprocess.check_output([
                "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                "stream=codec_name,channels,sample_rate,bit_rate", "-of", "json", str(file),
            ])
            self.assertEqual(json.loads(probe)["streams"], [
                {"codec_name": "mp3", "sample_rate": "24000", "channels": 1, "bit_rate": "80000"},
            ])


if __name__ == "__main__":
    unittest.main()
