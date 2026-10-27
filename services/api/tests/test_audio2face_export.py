"""Optional Audio2Face transport; pure parsers run without protocol dependencies."""
import contextlib
import hashlib
import io
import json
import os
import struct
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from vita_api import audio2face_export as export


def wav(duration=0.2):
    return export.wav_bytes(export.Audio(8000, b"\0\0" * int(8000 * duration)))


class Fields(SimpleNamespace):
    def HasField(self, name):
        return getattr(self, name, None) is not None


class Message(Fields):
    def WhichOneof(self, _):
        return self.part

    def ByteSize(self):
        return 100


def header():
    return Message(part="animation_data_stream_header", animation_data_stream_header=Fields(
        audio_header=Fields(audio_format=0, channel_count=1, bits_per_sample=16, samples_per_second=8000),
        skel_animation_header=Fields(blend_shapes=("JawOpen", "EyeBlinkLeft", "EyeBlinkRight")), start_time_code_since_epoch=0))


def data(stamps=(0, 0.2), audio=True):
    return Message(part="animation_data", animation_data=Fields(audio=Fields(time_code=0, audio_buffer=b"\0\0" * 1600) if audio else None,
        skel_animation=Fields(blend_shape_weights=[Fields(time_code=stamp, values=(0.1, 0.2, 0.3)) for stamp in stamps])))


def status(code=0):
    return Message(part="status", status=Fields(code=code, message="PRIVATE_PROVIDER_TEXT"))


class ExportTests(unittest.TestCase):
    def test_wav_actual_bytes_format_bounds_and_no_silent_truncation(self):
        original = wav()
        self.assertEqual(export.read_wav(original).duration, 0.2)
        malformed = [b"not audio", original[:-1], original + b"x"]
        stereo = bytearray(original); struct.pack_into("<H", stereo, 22, 2); malformed.append(bytes(stereo))
        oversized = bytearray(original); struct.pack_into("<I", oversized, 40, 9999999); malformed.append(bytes(oversized))
        for raw in malformed:
            with self.subTest(size=len(raw)), self.assertRaises(export.ExportFailure):
                export.read_wav(raw)
        with self.assertRaises(export.ExportFailure):
            export.wav_bytes(export.Audio(8000, b"\0\0" * (8000 * 61)))

    def test_collector_requires_header_ordered_finite_frames_audio_and_final_success(self):
        collector = export.ResponseCollector()
        for message in (header(), data(), status()):
            collector.accept(message)
        output, animation = collector.finish()
        self.assertEqual(export.read_wav(output).duration, 0.2)
        self.assertTrue(animation.startswith(b"TimeCode,JawOpen,EyeBlinkLeft,EyeBlinkRight\n"))
        for stream in [(data(),), (header(), header()), (header(), data((0.2, 0.1))),
                       (header(), data((0, float("nan")))), (header(), data(), status(3)),
                       (header(), data()), (header(), status()), (header(), data(), status(2))]:
            with self.subTest(parts=[item.part for item in stream]), self.assertRaises(export.ExportFailure):
                collector = export.ResponseCollector()
                for message in stream:
                    collector.accept(message)
                collector.finish()

    def test_partial_noncontiguous_and_unsupported_blendshape_response_fails(self):
        missing = header(); missing.animation_data_stream_header.skel_animation_header.blend_shapes = ("JawOpen", "EyeBlinkLeft", "EyeBlinkLeft")
        gap = data(); gap.animation_data.audio.time_code = 1
        for message in (missing, gap, data((0, 0.5))):
            with self.subTest(part=message.part), self.assertRaises(export.ExportFailure):
                collector = export.ResponseCollector()
                if message.part != "animation_data_stream_header":
                    collector.accept(header())
                collector.accept(message)
        collector = export.ResponseCollector(); collector.accept(header()); collector.accept(data((0, 0.01))); collector.accept(status())
        collector.pcm.extend(b"\0\0" * 8000)
        with self.assertRaises(export.ExportFailure):
            collector.finish()

    def test_export_no_overwrite_checkout_denial_failure_marker_and_cli_redaction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "in.wav"; source.write_bytes(wav())
            target = root / "export"
            with patch.object(export, "infer", side_effect=RuntimeError("PRIVATE_SECRET_PROVIDER_TEXT")) as infer:
                with self.assertRaises(RuntimeError):
                    export.export_audio(source, target, local_port=43210)
                self.assertEqual(infer.call_count, 1)
                self.assertEqual(json.loads((target / "failure.json").read_bytes())["retry"], "never_automatic")
                with self.assertRaises(FileExistsError):
                    export.export_audio(source, target, local_port=43210)
                self.assertEqual(infer.call_count, 1)
                with self.assertRaises(export.ExportFailure):
                    export.export_audio(source, export.CHECKOUT / "forbidden-audio-export", local_port=43210)
            error = io.StringIO()
            with contextlib.redirect_stderr(error), patch.object(export, "export_audio", side_effect=RuntimeError("PRIVATE_SECRET_PROVIDER_TEXT")):
                self.assertEqual(export.main(["--input", "PRIVATE_PATH", "--output", "PRIVATE_OUTPUT", "--local-port", "43210"]), 2)
            self.assertNotIn("PRIVATE", error.getvalue())
            for options in ({}, {"local_port": True}, {"local_port": 23}, {"function_id": "bad", "api_key": "PRIVATE"}):
                with self.assertRaises(export.ExportFailure):
                    export.infer(export.read_wav(wav()), **options)


@unittest.skipUnless(os.environ.get("VITAAI_AUDIO2FACE_PROTOCOL_TEST") == "1", "Optional real gRPC loopback suite requires explicit protocol runtime")
class ProtocolTests(unittest.TestCase):
    def test_actual_grpc_stream_export_hashes_request_order_failure_and_no_retry(self):
        grpc, controller, _, _, service = export.load_runtime()
        calls, requests, response = [], [], ["valid"]

        class LocalService(service.A2FControllerServiceServicer):
            def ProcessAudioStream(self, stream, context):
                calls.append(1); values = list(stream); requests.extend(values)
                if response[0] == "failure":
                    context.abort(grpc.StatusCode.INTERNAL, "PRIVATE_SECRET_PROVIDER_TEXT")
                head = controller.AnimationDataStream()
                head.animation_data_stream_header.audio_header.audio_format = 0
                head.animation_data_stream_header.audio_header.channel_count = 1
                head.animation_data_stream_header.audio_header.samples_per_second = 8000
                head.animation_data_stream_header.audio_header.bits_per_sample = 16
                head.animation_data_stream_header.skel_animation_header.blend_shapes.extend(("JawOpen", "EyeBlinkLeft", "EyeBlinkRight"))
                yield head
                frame = controller.AnimationDataStream()
                frame.animation_data.audio.audio_buffer = b"\0\0" * 1600
                for stamp in (0, 0.2):
                    weight = frame.animation_data.skel_animation.blend_shape_weights.add()
                    weight.time_code = stamp; weight.values.extend((0.1, 0.2, 0.3))
                yield frame
                final = controller.AnimationDataStream(); final.status.code = 0
                yield final

        pool = ThreadPoolExecutor(2); server = grpc.server(pool)
        service.add_A2FControllerServiceServicer_to_server(LocalService(), server)
        port = server.add_insecure_port("127.0.0.1:0"); server.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory); source = root / "input.wav"; raw = wav(); source.write_bytes(raw)
                target = root / "valid"; provenance = export.export_audio(source, target, local_port=port)
                self.assertEqual([message.WhichOneof("stream_part") for message in requests], ["audio_stream_header", "audio_with_emotion", "end_of_audio"])
                self.assertEqual(len(calls), 1)
                self.assertEqual(provenance["input_sha256"], hashlib.sha256(raw).hexdigest())
                self.assertEqual(provenance["output_wav_sha256"], hashlib.sha256((target / "out.wav").read_bytes()).hexdigest())
                self.assertEqual(provenance["animation_csv_sha256"], hashlib.sha256((target / "animation_frames.csv").read_bytes()).hexdigest())
                self.assertEqual(provenance["frames"], 2)
                self.assertEqual(provenance["destination"], "local_loopback")
                response[0] = "failure"; error = io.StringIO()
                with contextlib.redirect_stderr(error):
                    code = export.main(["--input", str(source), "--output", str(root / "failed"), "--local-port", str(port)])
                self.assertEqual(code, 2); self.assertEqual(len(calls), 2)
                self.assertNotIn("PRIVATE", error.getvalue())
                self.assertFalse((root / "failed" / "provenance.json").exists())
        finally:
            server.stop(0).wait(5); pool.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
