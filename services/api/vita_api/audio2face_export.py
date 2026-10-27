"""Explicit operator-only Audio2Face gRPC export; never part of an API request.

Install requirements-audio2face.txt with --no-deps in a separate environment.
Run python -m vita_api.audio2face_export --help for the explicit destination choices.
Protocol definitions inspected at NVIDIA pin a2d0150043be7dc15db2fad8193a78b660e1100f.
"""
import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import struct
import sys
import wave
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

MAX_WAV = 6 * 1024 * 1024
MAX_CSV = 2 * 1024 * 1024
MAX_SECONDS = 60
RATES = {8000, 16000, 22050, 24000, 44100, 48000}
CHECKOUT = Path(__file__).resolve().parents[3]
PROTO_PIN = "a2d0150043be7dc15db2fad8193a78b660e1100f"
WHEEL_SHA256 = "0c36066322406cc4670d6140796650e7020ddb20dee380c6a85222390b3a90a4"


class ExportFailure(ValueError):
    """Messages are fixed safe codes, never remote text, paths or credentials."""


@dataclass(frozen=True)
class Audio:
    rate: int
    pcm: bytes

    @property
    def duration(self):
        return len(self.pcm) / (2 * self.rate)


def read_wav(raw):
    if not 44 <= len(raw) <= MAX_WAV or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ExportFailure("invalid_wav")
    if struct.unpack_from("<I", raw, 4)[0] + 8 != len(raw):
        raise ExportFailure("invalid_wav_length")
    offset, count, rate, pcm = 12, 0, None, None
    while offset + 8 <= len(raw):
        count += 1
        if count > 1000:
            raise ExportFailure("wav_chunk_limit")
        name, size = raw[offset:offset + 4], struct.unpack_from("<I", raw, offset + 4)[0]
        start = offset + 8
        if start + size > len(raw):
            raise ExportFailure("truncated_wav")
        if name == b"fmt ":
            if rate is not None or size < 16:
                raise ExportFailure("invalid_wav_format")
            kind, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", raw, start)
            if kind != 1 or channels != 1 or bits != 16 or align != 2 or rate not in RATES or byte_rate != rate * 2:
                raise ExportFailure("unsupported_wav_format")
        elif name == b"data":
            if pcm is not None or not size or size % 2:
                raise ExportFailure("invalid_pcm")
            pcm = raw[start:start + size]
        offset = start + size + size % 2
    if offset != len(raw) or rate is None or pcm is None or not 0 < len(pcm) / (rate * 2) <= MAX_SECONDS:
        raise ExportFailure("invalid_wav_duration")
    return Audio(rate, pcm)


def wav_bytes(audio):
    target = io.BytesIO()
    with wave.open(target, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(audio.rate)
        output.writeframes(audio.pcm)
    result = target.getvalue()
    read_wav(result)
    return result


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


class ResponseCollector:
    """Bounded parsing of the official controller AnimationDataStream interface."""
    def __init__(self):
        self.rate, self.names, self.frames = None, (), []
        self.pcm = bytearray()
        self.last_part = None
        self.messages = self.total_bytes = 0

    def accept(self, message):
        self.messages += 1
        size = message.ByteSize()
        self.total_bytes += size
        if self.messages > 10000 or size > MAX_WAV + MAX_CSV or self.total_bytes > 2 * (MAX_WAV + MAX_CSV):
            raise ExportFailure("response_size_limit")
        part = message.WhichOneof("stream_part")
        if self.last_part is None and part != "animation_data_stream_header":
            raise ExportFailure("response_header_required")
        if part == "animation_data_stream_header":
            if self.last_part is not None:
                raise ExportFailure("duplicate_response_header")
            header = message.animation_data_stream_header
            if not header.HasField("audio_header") or not header.HasField("skel_animation_header"):
                raise ExportFailure("incomplete_response_header")
            audio = header.audio_header
            if (audio.audio_format != 0 or audio.channel_count != 1 or audio.bits_per_sample != 16
                    or audio.samples_per_second not in RATES):
                raise ExportFailure("unsupported_response_audio")
            names = tuple(header.skel_animation_header.blend_shapes)
            folded = {name.casefold() for name in names}
            if (not 3 <= len(names) <= 99 or len(folded) != len(names)
                    or any(not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,99}", name) for name in names)
                    or "timecode" in folded or "time_code" in folded
                    or not {"jawopen", "eyeblinkleft", "eyeblinkright"}.issubset(folded)):
                raise ExportFailure("unsupported_blendshape_header")
            if not finite(header.start_time_code_since_epoch) or header.start_time_code_since_epoch < 0:
                raise ExportFailure("invalid_response_epoch")
            self.rate, self.names = audio.samples_per_second, names
        elif part == "animation_data":
            data = message.animation_data
            if data.HasField("audio"):
                chunk = data.audio
                expected = len(self.pcm) / (2 * self.rate)
                if (not finite(chunk.time_code) or abs(chunk.time_code - expected) > 0.5 / self.rate
                        or not chunk.audio_buffer or len(chunk.audio_buffer) % 2):
                    raise ExportFailure("noncontiguous_response_audio")
                if len(self.pcm) + len(chunk.audio_buffer) > min(MAX_WAV - 44, MAX_SECONDS * self.rate * 2):
                    raise ExportFailure("response_audio_limit")
                self.pcm.extend(chunk.audio_buffer)
            if data.HasField("skel_animation"):
                for frame in data.skel_animation.blend_shape_weights:
                    stamp, values = frame.time_code, tuple(frame.values)
                    if (not finite(stamp) or not 0 <= stamp <= MAX_SECONDS + 0.1
                            or len(values) != len(self.names) or any(not finite(value) or not 0 <= value <= 1 for value in values)
                            or not self.frames and stamp > 0.1
                            or self.frames and (stamp <= self.frames[-1][0] or stamp - self.frames[-1][0] > 0.25)):
                        raise ExportFailure("invalid_animation_frame")
                    if len(self.frames) >= 3601:
                        raise ExportFailure("animation_frame_limit")
                    self.frames.append((stamp, values))
        elif part == "status":
            if message.status.code not in {0, 1, 2}:
                raise ExportFailure("inference_status_failed")
        elif part == "event":
            if message.event.event_type != 0:
                raise ExportFailure("unsupported_response_event")
        else:
            raise ExportFailure("unknown_response_part")
        self.last_part = part
        self.final_success = part == "status" and message.status.code == 0

    def finish(self):
        if self.last_part != "status" or not self.final_success or not self.pcm or len(self.frames) < 2:
            raise ExportFailure("incomplete_inference_response")
        audio = Audio(self.rate, bytes(self.pcm))
        if self.frames[-1][0] > audio.duration + 0.1 or audio.duration - self.frames[-1][0] > 0.25:
            raise ExportFailure("incomplete_animation_coverage")
        text = io.StringIO(newline="")
        writer = csv.writer(text, lineterminator="\n")
        writer.writerow(("TimeCode", *self.names))
        for stamp, values in self.frames:
            writer.writerow((format(stamp, ".12g"), *(format(value, ".9g") for value in values)))
        animation = text.getvalue().encode("utf-8")
        if len(animation) > MAX_CSV:
            raise ExportFailure("animation_csv_limit")
        return wav_bytes(audio), animation


def load_runtime():
    # Optional dependencies are imported only for an explicit operator invocation.
    import grpc
    from nvidia_ace.a2f import v1_pb2 as a2f
    from nvidia_ace.audio import v1_pb2 as audio
    from nvidia_ace.controller import v1_pb2 as controller
    from nvidia_ace.services.a2f_controller import v1_pb2_grpc as service

    return grpc, controller, audio, a2f, service


def requests(audio, controller, audio_proto, a2f):
    header = audio_proto.AudioHeader(audio_format=0, channel_count=1, samples_per_second=audio.rate, bits_per_sample=16)
    yield controller.AudioStream(audio_stream_header=controller.AudioStreamHeader(audio_header=header,
        blendshape_params=a2f.BlendShapeParameters(enable_clamping_bs_weight=True)))
    for offset in range(0, len(audio.pcm), 32768):
        yield controller.AudioStream(audio_with_emotion=a2f.AudioWithEmotion(audio_buffer=audio.pcm[offset:offset + 32768]))
    yield controller.AudioStream(end_of_audio=controller.AudioStream.EndOfAudio())


def infer(audio, *, local_port=None, function_id=None, api_key=None):
    if (local_port is None) == (function_id is None):
        raise ExportFailure("choose_one_destination")
    if local_port is not None and (isinstance(local_port, bool) or not isinstance(local_port, int) or not 1024 <= local_port <= 65535):
        raise ExportFailure("invalid_loopback_port")
    if function_id is not None:
        try:
            function_id = str(UUID(str(function_id)))
        except (ValueError, AttributeError):
            raise ExportFailure("invalid_function_id") from None
        if not isinstance(api_key, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{16,4096}", api_key):
            raise ExportFailure("audio2face_key_required")
    grpc, controller, audio_proto, a2f, service = load_runtime()
    options = (("grpc.enable_retries", 0), ("grpc.max_receive_message_length", MAX_WAV + MAX_CSV),
               ("grpc.max_send_message_length", 65536))
    channel = (grpc.insecure_channel(f"127.0.0.1:{local_port}", options=options) if local_port is not None
        else grpc.secure_channel("grpc.nvcf.nvidia.com:443", grpc.ssl_channel_credentials(), options=options))
    call = None
    try:
        metadata = () if local_port is not None else (("authorization", "Bearer " + api_key), ("function-id", function_id))
        call = service.A2FControllerServiceStub(channel).ProcessAudioStream(
            requests(audio, controller, audio_proto, a2f), timeout=90, wait_for_ready=False, metadata=metadata)
        collector = ResponseCollector()
        for message in call:
            collector.accept(message)
        output, animation = collector.finish()
        return output, animation, len(collector.frames), collector.names
    finally:
        if call is not None:
            call.cancel()
        channel.close()


def export_audio(input_path, output_dir, *, local_port=None, function_id=None):
    source = Path(input_path)
    # Bound the actual read independently of a changing file's initial stat.
    with source.open("rb") as stream:
        raw = stream.read(MAX_WAV + 1)
    audio = read_wav(raw)
    target = Path(output_dir).expanduser().resolve()
    if target == CHECKOUT or CHECKOUT in target.parents:
        raise ExportFailure("export_must_be_outside_checkout")
    target.mkdir(exist_ok=False)
    try:
        output, animation, count, names = infer(audio, local_port=local_port, function_id=function_id,
            api_key=os.environ.get("VITAAI_AUDIO2FACE_KEY") if function_id is not None else None)
        provenance = {"schema_version": "1", "created_at": datetime.now(UTC).isoformat(),
            "mode": "operator_audio2face_export", "destination": "local_loopback" if local_port is not None else "nvcf_tls",
            "function_id": str(function_id) if function_id is not None else None,
            "protocol_pin": PROTO_PIN, "protocol_wheel_sha256": WHEEL_SHA256,
            "input_sha256": hashlib.sha256(raw).hexdigest(), "output_wav_sha256": hashlib.sha256(output).hexdigest(),
            "animation_csv_sha256": hashlib.sha256(animation).hexdigest(), "frames": count, "blendshapes": names,
            "duration": read_wav(output).duration, "validation": "bounded_protocol_and_export_valid",
            "caveats": ["Provider identity and transcript alignment are not certified by this export.",
                "Local protocol tests are synthetic; they never establish live inference.",
                "Imported animation is presentation only; no business fact, approval or outcome is established."]}
        for name, data in (("out.wav", output), ("animation_frames.csv", animation),
                           ("provenance.json", json.dumps(provenance, indent=2).encode("utf-8"))):
            with (target / name).open("xb") as stream:
                stream.write(data)
        return provenance
    except BaseException:
        with (target / "failure.json").open("xb") as stream:
            stream.write(b'{"status":"incomplete_export","retry":"never_automatic"}\n')
        raise


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ExportFailure("invalid_cli_arguments")


def main(argv=None):
    parser = SafeParser(description="Explicit operator-only Audio2Face export. No retries; use a new output folder outside the checkout.")
    parser.add_argument("--input", required=True, help="Mono16-bit PCM WAV, at most60seconds/6MiB")
    parser.add_argument("--output", required=True, help="New directory outside the checkout; existing parent required")
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--local-port", type=int, help="Explicit local Audio2Face service port on127.0.0.1")
    destination.add_argument("--nvcf-function-id", type=UUID, help="Explicit NVCF function UUID; key from VITAAI_AUDIO2FACE_KEY")
    try:
        args = parser.parse_args(argv)
        export_audio(args.input, args.output, local_port=args.local_port, function_id=args.nvcf_function_id)
    except KeyboardInterrupt:
        print("Audio2Face export cancelled; no retry was made.", file=sys.stderr)
        return 130
    except Exception:  # noqa: BLE001 -- CLI trust boundary: third-party SDK errors may contain credentials.
        # Deliberately sanitize the CLI boundary: SDK exceptions may contain secrets or remote text.
        print("Audio2Face export unavailable or invalid. Inspect the retained output folder and configuration before a new explicit attempt.", file=sys.stderr)
        return 2
    print("Validated Audio2Face export saved. Import out.wav and animation_frames.csv into the local avatar player.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
