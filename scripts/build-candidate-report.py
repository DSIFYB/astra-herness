import argparse
import hashlib
import json
import math
import re
import statistics
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable,
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
MODEL_IDS = {
    "gpt2-xl": "openai-community/gpt2-xl",
    "qwen2.5-3b-instruct": "Qwen/Qwen2.5-3B-Instruct",
    "qwen2.5-coder-1.5b-instruct": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    "qwen2.5-coder-3b-instruct": "Qwen/Qwen2.5-Coder-3B-Instruct",
    "lfm2.5-1.2b-instruct": "LiquidAI/LFM2.5-1.2B-Instruct",
    "lfm2.5-2.6b": "LiquidAI/LFM2.5-2.6B",
}
CATEGORY_LABELS = {
    "targeted_edit": "Точное редактирование",
    "strict_json_extraction": "Строгий JSON",
    "table_extraction": "Таблицы",
    "clarification_no_edit": "Уточнение без правки",
    "native_tool_planning": "Вызов инструмента",
    "tool_result_followup": "Ответ по результату инструмента",
}
LICENSE_ASSETS = {
    "gpt2-xl": "README.md",
    "qwen2.5-3b-instruct": "LICENSE",
    "qwen2.5-coder-1.5b-instruct": "LICENSE",
    "qwen2.5-coder-3b-instruct": "LICENSE",
    "lfm2.5-1.2b-instruct": "LICENSE",
    "lfm2.5-2.6b": "LICENSE",
}
LICENSE_SUMMARIES = {
    "gpt2-xl": "MIT license flag",
    "qwen2.5-3b-instruct": "Qwen Research License: non-commercial research/evaluation; commercial use requires a separate license.",
    "qwen2.5-coder-1.5b-instruct": "Apache License 2.0",
    "qwen2.5-coder-3b-instruct": "Qwen Research License: non-commercial research/evaluation; commercial use requires a separate license.",
    "lfm2.5-1.2b-instruct": "LFM Open License v1.0: $10M annual-revenue threshold applies; review the agreement for commercial rights.",
    "lfm2.5-2.6b": "LFM Open License v1.0: $10M annual-revenue threshold applies; review the agreement for commercial rights.",
}
PALETTE = [colors.HexColor(value) for value in ("#147D83", "#2864A0", "#C87524", "#7058A6", "#4A8B54", "#B34D58")]
INK = colors.HexColor("#172B3A")
MUTED = colors.HexColor("#586A78")
RULE = colors.HexColor("#D8E0E5")
PALE = colors.HexColor("#EEF3F5")
GREEN = colors.HexColor("#DCEFE6")
RED = colors.HexColor("#F6E1E1")
GUARD_MIB = 5500
CONVERTER_COMMIT = "1537a0a8b2f8711d840878b0a0677ab2213c882c"
EXPECTED_CALC_FIELDS = {
    "storedFloatParameters", "excludedBufferElements", "originalWeightBytes", "originalAssetsBytes",
    "ggufBytes", "fp16WeightEstimateBytes", "ideal4BitWeightEstimateBytes",
    "effectiveGGUFBitsPerParameter", "originalToGGUFCompression", "medianLatencyMs", "p95LatencyMs",
    "medianTokensPerSecond", "totalCaseLatencyMs", "peakMiB", "minFreeMiB", "guardMarginMiB",
    "peakPercentOfVRAM",
}


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"Required input is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc


def require_number(value, label, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{label} must be a finite non-negative number")
    if integer and not isinstance(value, int):
        raise ValueError(f"{label} must be an integer")
    return value


def require_close(actual, expected, label, abs_tol=1e-6):
    if isinstance(actual, bool) or not isinstance(actual, (int, float)) or not math.isfinite(actual) or not math.isclose(actual, expected, rel_tol=1e-9, abs_tol=abs_tol):
        raise ValueError(f"{label} does not match recomputed value")


def validate_inputs(run_id):
    if not re.fullmatch(r"[A-Za-z0-9T_.-]{1,100}", run_id) or ".." in run_id:
        raise ValueError("Invalid run id")
    directory = ROOT / "eval" / "results" / run_id
    manifest = load_json(ROOT / "config" / "model-candidates-lock.json")
    suite_bytes = (ROOT / "eval" / "cases" / "document-benchmark-v1.json").read_bytes()
    suite = json.loads(suite_bytes)
    fixture_sha = hashlib.sha256(suite_bytes).hexdigest()
    if manifest.get("version") != 1 or len(manifest.get("models", [])) != len(MODEL_IDS):
        raise ValueError("Candidate lock must contain the six approved models")
    if {item.get("slug"): item.get("originalId") for item in manifest["models"]} != MODEL_IDS:
        raise ValueError("Candidate lock does not match the approved model IDs")

    selection = load_json(directory / "selection.json")
    calculations = load_json(directory / "calculations.json")
    environment = load_json(directory / "environment.json")
    if selection.get("runId") != run_id or calculations.get("runId") != run_id or calculations.get("version") != 1:
        raise ValueError("Selection or calculations run ID/version does not match requested run")
    if environment.get("version") != 1 or environment.get("runId") != run_id:
        raise ValueError("Environment evidence version/run ID does not match requested run")
    stop = environment.get("baselineStop", {})
    idle = environment.get("idleRecheck", {})
    hardware = environment.get("hardware", {})
    if (stop.get("alias") != "qwen3.5-2b" or stop.get("port") != 8081 or stop.get("beforeUsedMiB") != 1483 or
            stop.get("afterUsedMiB") != 0 or stop.get("stoppedAt") is not None or not stop.get("source") or
            not isinstance(stop.get("action"), str) or not isinstance(idle.get("verifiedAt"), str) or idle.get("usedMiB") != 0):
        raise ValueError("Environment evidence is missing the verified baseline stop and later idle recheck")
    if (not hardware.get("gpu") or not hardware.get("cpu") or not hardware.get("driverVersion") or
            not hardware.get("osRelease") or not isinstance(hardware.get("totalVRAMMiB"), int) or
            not isinstance(hardware.get("totalRAMBytes"), int) or not hardware.get("source")):
        raise ValueError("Environment evidence is missing hardware details")
    if (selection.get("suite", {}).get("id") != suite.get("id") or
            selection.get("suite", {}).get("sha256") != fixture_sha or
            selection.get("suite", {}).get("count") != len(suite["cases"])):
        raise ValueError("Selection does not match the current benchmark fixture")

    expected_cases = {case["id"]: case["category"] for case in suite["cases"]}
    report_by_slug = {}
    artifact_by_slug = {}
    for slug, original_id in MODEL_IDS.items():
        report = load_json(directory / f"{slug}.json")
        model = report.get("model", {})
        if model.get("slug") != slug or model.get("originalId") != original_id:
            raise ValueError(f"Report identity mismatch: {slug}")
        lock = next(item for item in manifest["models"] if item["slug"] == slug)
        if model.get("revision") != lock.get("revision") or model.get("license") != lock.get("license") or model.get("quantization") != "Q4_K_M":
            raise ValueError(f"Revision or quantization mismatch: {slug}")
        if not re.fullmatch(r"[a-f0-9]{64}", model.get("sha256", "")) or not isinstance(model.get("bytes"), int) or model["bytes"] <= 0:
            raise ValueError(f"Artifact hash or size is invalid: {slug}")
        if report.get("summary", {}).get("complete") is not True or report.get("errors") != []:
            raise ValueError(f"Report is incomplete or has errors: {slug}")
        settings = report.get("settings", {})
        expected_settings = {"gpuLayers": 99, "slots": 1, "temperature": 0, "seed": 42,
                             "maxOutputTokens": 384, "vramLimitMiB": GUARD_MIB, "port": 8082}
        if any(settings.get(key) != value for key, value in expected_settings.items()) or not isinstance(settings.get("context"), int):
            raise ValueError(f"Benchmark settings do not match pinned comparison protocol: {slug}")
        if report.get("suite", {}).get("id") != suite.get("id") or report["suite"].get("sha256") != fixture_sha or report["suite"].get("count") != len(expected_cases):
            raise ValueError(f"Suite mismatch: {slug}")
        cases = report.get("cases", [])
        if len(cases) != len(expected_cases) or {item.get("id") for item in cases} != set(expected_cases):
            raise ValueError(f"Case set is incomplete or has duplicates: {slug}")
        for item in cases:
            if item.get("category") != expected_cases[item["id"]] or not isinstance(item.get("grade", {}).get("passed"), bool):
                raise ValueError(f"Invalid case result: {slug}/{item.get('id')}")
        actual_passes = sum(bool(item["grade"]["passed"]) for item in cases)
        if report.get("summary", {}).get("passed") != actual_passes or report["summary"].get("total") != len(expected_cases):
            raise ValueError(f"Report summary does not match cases: {slug}")
        vram = report.get("vram", {})
        for field in ("beforeMiB", "peakTotalMiB", "peakDeltaMiB", "totalMiB"):
            require_number(vram.get(field), f"{slug}.vram.{field}")
        if vram["totalMiB"] <= 0:
            raise ValueError(f"VRAM total is invalid: {slug}")
        if not isinstance(vram.get("samples"), list) or len(vram["samples"]) < 2:
            raise ValueError(f"VRAM sample series is missing: {slug}")
        for sample in vram["samples"]:
            require_number(sample.get("usedMiB"), f"{slug} VRAM sample")
            require_number(sample.get("freeMiB"), f"{slug} VRAM free sample")
            if not isinstance(sample.get("at"), str):
                raise ValueError(f"VRAM sample has no timestamp: {slug}")
        sampled_peak = max(sample["usedMiB"] for sample in vram["samples"])
        require_close(vram["peakTotalMiB"], sampled_peak, f"{slug} report peak VRAM")
        require_close(vram["peakDeltaMiB"], sampled_peak - vram["beforeMiB"], f"{slug} report VRAM delta")
        report_by_slug[slug] = report
        receipt = load_json(directory / "artifacts" / f"{slug}.json")
        if (receipt.get("slug") != slug or receipt.get("originalId") != original_id or
                receipt.get("revision") != lock.get("revision") or receipt.get("quantization") != "Q4_K_M" or
                receipt.get("sha256") != model.get("sha256") or receipt.get("size") != model.get("bytes") or
                receipt.get("converterCommit") != CONVERTER_COMMIT or not receipt.get("pythonVersion") or
                not isinstance(receipt.get("pythonPackageVersions"), dict)):
            raise ValueError(f"Archived artifact receipt does not match report: {slug}")
        license_asset = LICENSE_ASSETS[slug]
        license_path = directory / "sources" / slug / license_asset
        try:
            license_text = license_path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise ValueError(f"Archived license source is missing: {license_path}") from exc
        checks = {
            "gpt2-xl": r"license\s*:\s*mit",
            "qwen2.5-3b-instruct": r"Qwen RESEARCH LICENSE AGREEMENT",
            "qwen2.5-coder-1.5b-instruct": r"Apache License, Version 2\.0",
            "qwen2.5-coder-3b-instruct": r"Qwen RESEARCH LICENSE AGREEMENT",
            "lfm2.5-1.2b-instruct": r"LFM Open License v1\.0",
            "lfm2.5-2.6b": r"LFM Open License v1\.0",
        }
        if not re.search(checks[slug], license_text, re.IGNORECASE):
            raise ValueError(f"Archived license source does not match expected flag: {slug}")
        if slug.startswith("qwen2.5-") and "coder-1.5b" not in slug:
            if not re.search(r"FOR NON-COMMERCIAL PURPOSES ONLY", license_text, re.IGNORECASE) or not re.search(r"request a license", license_text, re.IGNORECASE):
                raise ValueError(f"Qwen Research License terms do not match expected summary: {slug}")
        if slug.startswith("lfm2.5-") and not re.search(r"annual revenue of 10 million.*\$10,000,000", license_text, re.IGNORECASE | re.DOTALL):
            raise ValueError(f"LFM annual-revenue threshold is not present in archived license: {slug}")
        receipt["licenseAsset"] = license_asset
        receipt["licenseSummary"] = LICENSE_SUMMARIES[slug]
        if slug == "gpt2-xl":
            expected_wrapper = "scripts/convert-gpt2.py"
            wrapper_sha256 = receipt.get("converterWrapperSha256", "")
            if not re.fullmatch(r"[a-f0-9]{64}", wrapper_sha256):
                raise ValueError("GPT-2 artifact is missing the pinned conversion wrapper provenance")
            wrapper_path = ROOT / expected_wrapper
            if hashlib.sha256(wrapper_path.read_bytes()).hexdigest() != wrapper_sha256:
                raise ValueError("GPT-2 conversion wrapper SHA-256 does not match artifact receipt")
            receipt["converterWrapperSummary"] = f"{expected_wrapper} SHA-256 {wrapper_sha256}; deterministic attention masks skipped, learned tensors unchanged"
        artifact_by_slug[slug] = receipt

    ranking = selection.get("ranking", [])
    if len(ranking) != len(MODEL_IDS) or {entry.get("model", {}).get("slug") for entry in ranking} != set(MODEL_IDS):
        raise ValueError("Selection must rank exactly all six candidates")
    manifest_order = {model["slug"]: index for index, model in enumerate(manifest["models"])}
    entries_by_slug = {}
    for entry in ranking:
        slug = entry["model"]["slug"]
        report = report_by_slug[slug]
        model = report["model"]
        expected_model = {key: model.get(key) for key in ("originalId", "slug", "revision", "license", "quantization", "sha256", "bytes")}
        if entry.get("model") != expected_model:
            raise ValueError(f"Selection model identity or artifact metadata does not match report: {slug}")
        if (isinstance(entry.get("rank"), bool) or not isinstance(entry.get("rank"), int) or
                isinstance(entry.get("order"), bool) or not isinstance(entry.get("order"), int) or
                entry["rank"] != len(entries_by_slug) + 1 or entry["order"] != manifest_order[slug]):
            raise ValueError(f"Selection rank or manifest order is invalid: {slug}")

        groups = {}
        latencies = []
        for case in report["cases"]:
            category = case["category"]
            group = groups.setdefault(category, {"passed": 0, "total": 0})
            group["total"] += 1
            group["passed"] += int(case["grade"]["passed"])
            latency = case.get("result", {}).get("latencyMs")
            if isinstance(latency, (int, float)) and not isinstance(latency, bool) and math.isfinite(latency) and latency >= 0:
                latencies.append(latency)
        if not latencies:
            raise ValueError(f"Report has no valid latency measurements: {slug}")
        total = len(report["cases"])
        passed = sum(group["passed"] for group in groups.values())
        native = groups.get("native_tool_planning", {"passed": 0, "total": 0})
        if report["summary"].get("categories") != groups:
            raise ValueError(f"Report category summary does not match case grades: {slug}")
        require_close(report["summary"].get("percentage"), passed / total * 100, f"{slug} report pass percentage")
        expected_entry = {
            "passed": passed,
            "total": total,
            "passRate": passed / total,
            "categories": groups,
            "nativeToolPassed": native["passed"],
            "nativeToolTotal": native["total"],
            "medianLatencyMs": statistics.median(latencies),
            "validLatencyCount": len(latencies),
            "peakTotalMiB": report["vram"]["peakTotalMiB"],
            "peakDeltaMiB": report["vram"]["peakDeltaMiB"],
            "baselineMiB": report["vram"]["beforeMiB"],
            "bytes": model["bytes"],
        }
        integer_entry_fields = {"passed", "total", "nativeToolPassed", "nativeToolTotal", "validLatencyCount", "bytes"}
        for field, value in expected_entry.items():
            if field not in entry:
                raise ValueError(f"Selection is missing {field}: {slug}")
            if field in integer_entry_fields:
                if isinstance(entry[field], bool) or not isinstance(entry[field], int) or entry[field] != value:
                    raise ValueError(f"Selection {field} does not match report cases: {slug}")
                continue
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                require_close(entry[field], value, f"{slug} selection {field}")
            elif entry[field] != value:
                raise ValueError(f"Selection {field} does not match report cases: {slug}")
        entries_by_slug[slug] = entry

    def ranking_key(slug):
        entry = entries_by_slug[slug]
        native_rate = entry["nativeToolPassed"] / entry["nativeToolTotal"] if entry["nativeToolTotal"] else 0
        return (-entry["passRate"], -native_rate, entry["peakDeltaMiB"], entry["medianLatencyMs"], entry["order"])

    expected_order = sorted(MODEL_IDS, key=ranking_key)
    if [entry["model"]["slug"] for entry in ranking] != expected_order:
        raise ValueError("Selection ranking order does not match the documented tie-break rules")
    winner_slug = expected_order[0]
    winner = entries_by_slug[winner_slug]
    eligible = [slug for slug in expected_order[1:]
                if entries_by_slug[slug]["bytes"] < winner["bytes"] and
                abs(entries_by_slug[slug]["passRate"] - winner["passRate"]) <= 0.10]
    runner_slug = min(eligible, key=lambda slug: entries_by_slug[slug]["bytes"]) if eligible else expected_order[1]
    runner_reason = ("smallest smaller model within 10 percentage points of winner" if eligible
                    else "second-ranked fallback; no smaller qualifying candidate")
    if (selection.get("winner") != winner or selection.get("runnerUp") != entries_by_slug[runner_slug] or
            selection.get("runnerUpReason") != runner_reason):
        raise ValueError("Selection winner or second candidate does not match ranking rules")

    calc_models = calculations.get("models", [])
    if len(calc_models) != len(MODEL_IDS) or {item.get("slug") for item in calc_models} != set(MODEL_IDS):
        raise ValueError("Calculations must contain exactly one row for every candidate")
    calc_by_slug = {}
    integer_fields = {"storedFloatParameters", "excludedBufferElements", "originalWeightBytes", "originalAssetsBytes",
                      "ggufBytes", "fp16WeightEstimateBytes", "ideal4BitWeightEstimateBytes"}
    manifest_by_slug = {model["slug"]: model for model in manifest["models"]}
    for item in calc_models:
        slug = item["slug"]
        missing = EXPECTED_CALC_FIELDS - item.keys()
        if missing:
            raise ValueError(f"Calculations missing fields for {slug}: {', '.join(sorted(missing))}")
        for field in EXPECTED_CALC_FIELDS:
            require_number(item[field], f"{slug}.{field}", field in integer_fields)
        report = report_by_slug[slug]
        report_model = report["model"]
        if item["ggufBytes"] != report_model.get("bytes"):
            raise ValueError(f"Calculated GGUF size does not match report: {slug}")
        if item.get("originalId") != MODEL_IDS[slug] or item.get("revision") != report_model.get("revision"):
            raise ValueError(f"Calculation provenance does not match report: {slug}")
        pinned = manifest_by_slug[slug]
        if any(isinstance(file.get("size"), bool) or not isinstance(file.get("size"), int) or file["size"] < 0 for file in pinned["files"]):
            raise ValueError(f"Pinned asset size is invalid: {slug}")
        weight_bytes = sum(file["size"] for file in pinned["files"] if file["path"].endswith(".safetensors"))
        asset_bytes = sum(file["size"] for file in pinned["files"])
        if item["originalWeightBytes"] != weight_bytes or item["originalAssetsBytes"] != asset_bytes:
            raise ValueError(f"Calculated original file sizes do not match pinned manifest: {slug}")
        parameters = item["storedFloatParameters"]
        gguf_bytes = report_model["bytes"]
        if parameters <= 0 or gguf_bytes <= 0:
            raise ValueError(f"Calculated parameter or GGUF size is invalid: {slug}")
        derived_values = {
            "fp16WeightEstimateBytes": 2 * parameters,
            "ideal4BitWeightEstimateBytes": math.ceil(parameters / 2),
            "effectiveGGUFBitsPerParameter": 8 * gguf_bytes / parameters,
            "originalToGGUFCompression": weight_bytes / gguf_bytes,
        }
        for field, expected in derived_values.items():
            require_close(item[field], expected, f"{slug}.{field}")

        latencies = [case.get("result", {}).get("latencyMs") for case in report["cases"]]
        latencies = [value for value in latencies if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0]
        rates = [case.get("result", {}).get("timings", {}).get("predicted_per_second") for case in report["cases"]]
        rates = [value for value in rates if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0]
        if not latencies or not rates:
            raise ValueError(f"Report has no valid latency or engine throughput measurements: {slug}")
        sorted_latencies = sorted(latencies)
        samples = report["vram"]["samples"]
        peak = max(sample["usedMiB"] for sample in samples)
        min_free = min(sample["freeMiB"] for sample in samples)
        measured_values = {
            "medianLatencyMs": statistics.median(latencies),
            "p95LatencyMs": sorted_latencies[math.ceil(0.95 * len(sorted_latencies)) - 1],
            "medianTokensPerSecond": statistics.median(rates),
            "totalCaseLatencyMs": sum(latencies),
            "peakMiB": peak,
            "minFreeMiB": min_free,
            "guardMarginMiB": GUARD_MIB - peak,
            "peakPercentOfVRAM": peak / report["vram"]["totalMiB"] * 100,
        }
        for field, expected in measured_values.items():
            require_close(item[field], expected, f"{slug}.{field}")
        calc_by_slug[slug] = item
    cleanup_path = directory / "cleanup.json"
    cleanup = load_json(cleanup_path) if cleanup_path.exists() else None
    if cleanup is not None:
        if not isinstance(cleanup.get("removed"), list) or not isinstance(cleanup.get("retained"), list) or not cleanup.get("completedAt"):
            raise ValueError("Cleanup record has an invalid shape")
        if any(item.get("slug") not in MODEL_IDS or isinstance(item.get("bytes"), bool) or not isinstance(item.get("bytes"), int) for item in cleanup["removed"]):
            raise ValueError("Cleanup record contains invalid removed-model entries")
        if any(slug not in MODEL_IDS for slug in cleanup["retained"]):
            raise ValueError("Cleanup record contains an unknown retained model")
    return suite, manifest, selection, report_by_slug, calc_by_slug, artifact_by_slug, cleanup, environment


class BarChart(Flowable):
    def __init__(self, labels, values, width=174 * mm, height=60 * mm, max_value=None, colors_by_bar=None, guard=None, suffix="%"):
        super().__init__()
        self.labels, self.values, self.width, self.height = labels, values, width, height
        self.max_value = max_value or max(values or [1])
        self.colors_by_bar = colors_by_bar or [PALETTE[i % len(PALETTE)] for i in range(len(values))]
        self.guard, self.suffix = guard, suffix

    def wrap(self, avail_width, avail_height):
        return min(self.width, avail_width), self.height

    def draw(self):
        c = self.canv
        left, right = 62 * mm, 15 * mm
        chart_width = self.width - left - right
        row_height = self.height / max(1, len(self.values))
        c.setFont("Arial", 6.2)
        if self.guard is not None and self.max_value:
            x = left + chart_width * self.guard / self.max_value
            c.setStrokeColor(colors.HexColor("#B74343"))
            c.setDash(3, 2)
            c.line(x, 0, x, self.height)
            c.setDash()
            c.setFillColor(colors.HexColor("#9E3535"))
            c.drawString(min(x + 2, self.width - 27 * mm), self.height - 8, f"Guard {self.guard:g}{self.suffix}")
        for i, (label, value) in enumerate(zip(self.labels, self.values)):
            y = self.height - (i + 1) * row_height + row_height * .22
            c.setFillColor(INK)
            c.drawRightString(left - 3 * mm, y + 2, label)
            c.setFillColor(PALE)
            c.roundRect(left, y, chart_width, row_height * .5, 2, fill=1, stroke=0)
            bar_width = chart_width * value / self.max_value if self.max_value else 0
            c.setFillColor(self.colors_by_bar[i])
            c.roundRect(left, y, max(0, bar_width), row_height * .5, 2, fill=1, stroke=0)
            c.setFillColor(INK)
            c.drawString(left + bar_width + 2 * mm, y + 2, f"{value:.1f}{self.suffix}")


class Heatmap(Flowable):
    def __init__(self, rows, categories, width=174 * mm, height=None):
        super().__init__()
        self.rows, self.categories, self.width = rows, categories, width
        self.height = height or (20 * mm + 7 * mm * (len(rows) + 1))

    def wrap(self, avail_width, avail_height):
        return min(self.width, avail_width), self.height

    def draw(self):
        c = self.canv
        label_w = 56 * mm
        cell_w = (self.width - label_w) / len(self.categories)
        header_h = 20 * mm
        c.setFont("Arial-Bold", 6.5)
        c.setFillColor(INK)
        for col, category in enumerate(self.categories):
            title = "Ответ после tools" if category == "tool_result_followup" else CATEGORY_LABELS.get(category, category.replace("_", " "))
            c.saveState()
            c.translate(label_w + col * cell_w + cell_w / 2, self.height - 19 * mm)
            c.rotate(55)
            c.drawString(0, 0, title)
            c.restoreState()
        row_h = (self.height - header_h) / len(self.rows)
        for r, row in enumerate(self.rows):
            y = self.height - header_h - (r + 1) * row_h
            c.setFillColor(INK)
            c.setFont("Arial", 7)
            c.drawRightString(label_w - 3 * mm, y + row_h / 2 - 2, row["label"])
            for col, category in enumerate(self.categories):
                passed, total = row["categories"].get(category, (0, 0))
                rate = passed / total if total else 0
                c.setFillColor(GREEN if rate == 1 else RED if rate < .5 else colors.HexColor("#F7ECCC"))
                x = label_w + col * cell_w
                c.rect(x, y, cell_w - 1, row_h - 1, fill=1, stroke=0)
                c.setFillColor(INK)
                c.setFont("Arial-Bold", 7)
                c.drawCentredString(x + cell_w / 2, y + row_h / 2 - 2, f"{passed}/{total}")


class LineChart(Flowable):
    def __init__(self, reports, labels, width=174 * mm, height=80 * mm):
        super().__init__()
        self.reports, self.labels, self.width, self.height = reports, labels, width, height

    def wrap(self, avail_width, avail_height):
        return min(self.width, avail_width), self.height

    def draw(self):
        c = self.canv
        left, right, bottom, top = 16 * mm, 8 * mm, 14 * mm, 9 * mm
        plot_w, plot_h = self.width - left - right, self.height - bottom - top
        series = []
        x_max = 0
        y_max = 0
        for report in self.reports:
            samples = report["vram"]["samples"]
            start = datetime.fromisoformat(samples[0]["at"].replace("Z", "+00:00"))
            points = []
            for i, sample in enumerate(samples):
                try:
                    at = datetime.fromisoformat(sample["at"].replace("Z", "+00:00"))
                    x = max(0, (at - start).total_seconds())
                except ValueError:
                    x = float(i)
                points.append((x, sample["usedMiB"]))
            x_max = max(x_max, points[-1][0])
            y_max = max(y_max, max(value for _, value in points))
            series.append(points)
        x_max = max(x_max, 1)
        y_max = max(y_max, GUARD_MIB) * 1.05
        c.setStrokeColor(RULE)
        c.setFillColor(MUTED)
        c.setFont("Arial", 7)
        for i in range(5):
            value = y_max * i / 4
            y = bottom + plot_h * i / 4
            c.line(left, y, left + plot_w, y)
            c.drawRightString(left - 2 * mm, y - 2, f"{value:.0f}")
        c.drawCentredString(left + plot_w / 2, 1 * mm, "Секунды с первого замера")
        for i in range(5):
            x = left + plot_w * i / 4
            c.drawCentredString(x, bottom - 4 * mm, f"{x_max * i / 4:.0f}")
        c.drawString(left, self.height - 10 * mm, "MiB")
        guard_y = bottom + plot_h * GUARD_MIB / y_max
        c.setStrokeColor(colors.HexColor("#B74343"))
        c.setDash(3, 2)
        c.line(left, guard_y, left + plot_w, guard_y)
        c.setDash()
        for index, points in enumerate(series):
            c.setStrokeColor(PALETTE[index % len(PALETTE)])
            c.setLineWidth(1.2)
            for (x1, y1), (x2, y2) in zip(points, points[1:]):
                c.line(left + plot_w * x1 / x_max, bottom + plot_h * y1 / y_max,
                       left + plot_w * x2 / x_max, bottom + plot_h * y2 / y_max)
        c.setFont("Arial", 5.5)
        legend_y = self.height - 3 * mm
        for i, label in enumerate(self.labels):
            x = left + (i % 3) * 53 * mm
            y = legend_y - (i // 3) * 4 * mm
            c.setFillColor(PALETTE[i % len(PALETTE)])
            c.rect(x, y - 1, 3 * mm, 2 * mm, fill=1, stroke=0)
            c.setFillColor(INK)
            c.drawString(x + 4 * mm, y - 1, label)


def fmt_bytes(value):
    return f"{value / (1024 ** 3):.2f} GiB"


def fmt_num(value):
    return f"{value:,}".replace(",", " ")


def model_display(slug):
    return {
        "gpt2-xl": "GPT-2 XL",
        "qwen2.5-3b-instruct": "Qwen2.5 3B Instruct",
        "qwen2.5-coder-1.5b-instruct": "Qwen2.5 Coder 1.5B",
        "qwen2.5-coder-3b-instruct": "Qwen2.5 Coder 3B",
        "lfm2.5-1.2b-instruct": "LFM2.5 1.2B Instruct",
        "lfm2.5-2.6b": "LFM2.5 2.6B",
    }[slug]


def error_breakdown(report):
    counts = {key: 0 for key in ("cutoff", "malformed_json", "strict_only", "wrong_data", "tool_protocol", "repeat_followup")}
    correctness_checks = {
        "exact_expected_value", "edit_plan_schema_and_target", "unique_source_match", "only_requested_text_changes",
        "tool_arguments", "required_facts", "required_order", "required_pairings", "no_contradictions",
        "clarification_shape", "no_completion_claim",
    }
    for case in report["cases"]:
        checks = {item["name"]: item.get("passed") for item in case.get("grade", {}).get("checks", [])}
        if checks.get("completed") is False:
            counts["cutoff"] += 1
        if checks.get("valid_json") is False:
            counts["malformed_json"] += 1
        wrong = any(checks.get(name) is False for name in correctness_checks)
        if wrong:
            counts["wrong_data"] += 1
        elif (checks.get("strict_json_format") is False and checks.get("valid_json") is True and
              not any(name != "strict_json_format" and passed is False for name, passed in checks.items())):
            counts["strict_only"] += 1
        if checks.get("native_tool_protocol") is False or checks.get("no_unrequested_tool_calls") is False:
            counts["tool_protocol"] += 1
        if case.get("category") == "tool_result_followup" and case.get("result", {}).get("tool_calls"):
            counts["repeat_followup"] += 1
    return counts


def styles():
    pdfmetrics.registerFont(TTFont("Arial", r"C:\Windows\Fonts\arial.ttf"))
    pdfmetrics.registerFont(TTFont("Arial-Bold", r"C:\Windows\Fonts\arialbd.ttf"))
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("Title2", parent=base["Title"], fontName="Arial-Bold", fontSize=25, leading=31, textColor=INK, alignment=TA_LEFT, spaceAfter=7 * mm),
        "h1": ParagraphStyle("H1x", parent=base["Heading1"], fontName="Arial-Bold", fontSize=17, leading=21, textColor=INK, spaceAfter=4 * mm),
        "h2": ParagraphStyle("H2x", parent=base["Heading2"], fontName="Arial-Bold", fontSize=11, leading=14, textColor=colors.HexColor("#147D83"), spaceBefore=3 * mm, spaceAfter=2 * mm),
        "body": ParagraphStyle("Bodyx", parent=base["BodyText"], fontName="Arial", fontSize=8.8, leading=13, textColor=INK, spaceAfter=2.2 * mm),
        "small": ParagraphStyle("Smallx", parent=base["BodyText"], fontName="Arial", fontSize=7.2, leading=10, textColor=MUTED, spaceAfter=1.5 * mm),
        "provenance": ParagraphStyle("Provenance", parent=base["BodyText"], fontName="Arial", fontSize=5.6, leading=7.2, textColor=MUTED),
        "appendix": ParagraphStyle("AppendixTable", parent=base["BodyText"], fontName="Arial", fontSize=7, leading=8.8, textColor=INK),
        "callout": ParagraphStyle("Callout", parent=base["BodyText"], fontName="Arial-Bold", fontSize=10, leading=15, textColor=INK, backColor=PALE, borderColor=RULE, borderWidth=.5, borderPadding=7, spaceBefore=2 * mm, spaceAfter=4 * mm),
    }


def para(text, style):
    return Paragraph(text, style)


def make_table(data, widths, font_size=7.4, header=True):
    if sum(widths) > 174 * mm:
        raise ValueError("Table width exceeds the A4 content area")
    body_style = ParagraphStyle(f"TableBody{font_size}", fontName="Arial", fontSize=font_size,
                                leading=font_size + 2, textColor=INK)
    header_style = ParagraphStyle(f"TableHead{font_size}", fontName="Arial-Bold", fontSize=font_size,
                                  leading=font_size + 2, textColor=colors.white)
    wrapped = []
    for row_index, row in enumerate(data):
        style = header_style if header and row_index == 0 else body_style
        wrapped.append([Paragraph(escape(cell), style) if isinstance(cell, str) else cell for cell in row])
    table = Table(wrapped, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [
        ("FONTNAME", (0, 0), (-1, -1), "Arial"),
        ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("LEADING", (0, 0), (-1, -1), font_size + 2.2),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -1), .35, RULE),
    ]
    if header:
        commands.extend([("BACKGROUND", (0, 0), (-1, 0), INK), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                         ("FONTNAME", (0, 0), (-1, 0), "Arial-Bold")])
    table.setStyle(TableStyle(commands))
    return table


def page_decoration(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(.5)
    canvas.line(18 * mm, height - 15 * mm, width - 18 * mm, height - 15 * mm)
    canvas.setFont("Arial", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, height - 12 * mm, "ASTRA | ОТЧЁТ ПО ЛОКАЛЬНЫМ МОДЕЛЯМ")
    canvas.drawRightString(width - 18 * mm, 10 * mm, f"{doc.page}")
    canvas.restoreState()


def make_report(run_id, suite, manifest, selection, reports, calculations, artifacts, cleanup, environment):
    s = styles()
    order = [entry["model"]["slug"] for entry in selection["ranking"]]
    labels = [model_display(slug) for slug in order]
    categories = list(dict.fromkeys(case["category"] for case in suite["cases"]))
    category_rows = []
    for slug in order:
        counts = {}
        for category in categories:
            items = [item for item in reports[slug]["cases"] if item["category"] == category]
            counts[category] = (sum(bool(item["grade"]["passed"]) for item in items), len(items))
        category_rows.append({"label": model_display(slug), "categories": counts})
    category_counts = {slug: {category: count for category, count in row["categories"].items()} for slug, row in zip(order, category_rows)}
    overall = [sum(case["grade"]["passed"] for case in reports[slug]["cases"]) / len(suite["cases"]) * 100 for slug in order]
    winner_slug = selection["winner"]["model"]["slug"]
    second_slug = selection["runnerUp"]["model"]["slug"]

    story = []
    winner = next(entry for entry in selection["ranking"] if entry["model"]["slug"] == winner_slug)
    second = next(entry for entry in selection["ranking"] if entry["model"]["slug"] == second_slug)
    second_reason = ("Наименьший компактный вариант в пределах 10 п.п. от лидера."
                     if selection["runnerUpReason"].startswith("smallest") else
                     "Второе место рейтинга; компактный вариант в пределах 10 п.п. не найден.")
    story += [para("Сравнение локальных моделей", s["title"]),
              para(f"Бенчмарк документов | run {run_id} | {len(suite['cases'])} синтетических сценариев", s["body"]),
              para(f"Победитель: {model_display(winner_slug)} - {winner['passed']}/{winner['total']} ({winner['passRate'] * 100:.1f}%). Второй сохранённый вариант: {model_display(second_slug)} - {second['passed']}/{second['total']} ({second['passRate'] * 100:.1f}%). {second_reason}", s["callout"]),
              para("Проверка интеграции Harness выявила неверный фактический ответ и нестабильный цикл инструмента. Лидер сравнения выбран для локального исследования, не для готового документного продукта. Подробности в последнем разделе.", s["small"]),
              para("Краткий вывод", s["h2"]),
              para("Ранжирование основано на полном наборе синтетических случаев. Сначала учитывается доля пройденных случаев, затем доля нативного планирования инструментов, меньший прирост общей VRAM и меньшая медианная задержка. Второй вариант выбирается как самый компактный меньший файл в пределах 10 процентных пунктов от победителя; если такого нет, используется второе место общего рейтинга.", s["body"]),
              para("Ограничения интерпретации", s["h2"]),
              para("Промпты и документы синтетические; здесь не использовались пользовательские документы, не запускались DOCX-инструменты и не выполнялось дообучение. VRAM отражает использование всей видеокарты Windows и других процессов, а не изолированную память одного сервера. Лимит 384 выходных токена может обрезать reasoning-ответы. Результат показывает пригодность к этому корпусу и конфигурации, а не универсальное превосходство модели.", s["body"]),
              make_table([["Показатель", "Результат"], ["Победитель", model_display(winner_slug)], ["Второй вариант", model_display(second_slug)], ["Полный проход", f"{len(suite['cases'])} случаев на модель; неполные отчёты не ранжируются"], ["Ограничение VRAM", "5 500 MiB общей памяти GPU"], ["Формат", "GGUF Q4_K_M; SHA-256 указан в приложении"]], [47 * mm, 125 * mm]),
              Spacer(1, 5 * mm), para("Основные результаты", s["small"]),
              make_table([["Модель", "Пройдено", "Медиана", "Пик всего", "GGUF"], *[
                  [model_display(slug), f"{sum(c['grade']['passed'] for c in reports[slug]['cases'])}/{len(suite['cases'])}",
                   f"{calculations[slug]['medianLatencyMs']:.0f} ms", f"{calculations[slug]['peakMiB']:.0f} MiB", fmt_bytes(calculations[slug]['ggufBytes'])]
                  for slug in order]], [44 * mm, 24 * mm, 24 * mm, 27 * mm, 32 * mm])]

    story += [PageBreak(), para("Качество по задачам", s["h1"]),
              para("Доля пройденных случаев и распределение ошибок по категориям. Числитель - cases с grade.passed=true; частичные диагностические баллы не считаются.", s["body"]),
              BarChart(labels, overall, max_value=100, suffix="%"), Spacer(1, 5 * mm),
              para("Тепловая карта: пройдено / всего", s["h2"]), Heatmap(category_rows, categories)]

    story += [PageBreak(), para("Инструменты, JSON и ошибки данных", s["h1"]),
              para("Отдельно показаны нативные вызовы указанных инструментов, извлечение строгого JSON и структурирование табличных данных. Ни один из сценариев не изменяет реальный файл. Разделение ниже основано на grade checks; типы сбоев могут пересекаться.", s["body"]),
              para("Категорийные проходы", s["h2"]),
              make_table([["Модель", "Нативный вызов", "Строгий JSON", "Табличные данные", "Сбои результата*"], *[
                  [model_display(slug),
                   f"{category_counts[slug]['native_tool_planning'][0]}/{category_counts[slug]['native_tool_planning'][1]}",
                   f"{category_counts[slug]['strict_json_extraction'][0]}/{category_counts[slug]['strict_json_extraction'][1]}",
                   f"{category_counts[slug]['table_extraction'][0]}/{category_counts[slug]['table_extraction'][1]}",
                   str(sum(bool(case.get("result", {}).get("error")) for case in reports[slug]["cases"]))]
                  for slug in order]], [43 * mm, 32 * mm, 25 * mm, 31 * mm, 26 * mm]),
              Spacer(1, 4 * mm), para("Ошибки по случаям", s["h2"])]
    for slug in order:
        failed = [case for case in reports[slug]["cases"] if not case["grade"]["passed"]]
        categories_failed = {}
        for case in failed:
            categories_failed[case["category"]] = categories_failed.get(case["category"], 0) + 1
        text = ", ".join(f"{CATEGORY_LABELS.get(name, name.replace('_', ' '))}: {count}" for name, count in categories_failed.items()) or "нет проваленных случаев"
        story.append(para(f"<b>{model_display(slug)}</b>: {text}.", s["small"]))
    breakdown = {slug: error_breakdown(reports[slug]) for slug in order}
    story += [Spacer(1, 2 * mm), para("Разделение типов сбоев", s["h2"]),
              make_table([["Модель", "Обрезка / сбой", "Невалидный JSON", "Только формат", "Данные / аргументы", "Протокол инструмента", "Повтор в follow-up"], *[
                  [model_display(slug), str(breakdown[slug]["cutoff"]), str(breakdown[slug]["malformed_json"]),
                   str(breakdown[slug]["strict_only"]), str(breakdown[slug]["wrong_data"]),
                   str(breakdown[slug]["tool_protocol"]), str(breakdown[slug]["repeat_followup"])]
              for slug in order]], [31 * mm, 21 * mm, 18 * mm, 19 * mm, 24 * mm, 27 * mm, 30 * mm], font_size=7.0)]
    repeats = [(slug, breakdown[slug]["repeat_followup"]) for slug in order if breakdown[slug]["repeat_followup"]]
    if repeats:
        detail = "; ".join(f"{model_display(slug)}: {count}/4" for slug, count in repeats)
        story.append(para(f"Новый вызов инструмента в follow-up после получения результата: {detail}. Это повторный протокольный вызов, а не отсутствие поддержки tools; первичное планирование показано отдельно.", s["small"]))
    story.append(para("Фиксированный лимит составляет 384 выходных токена. finish_reason=length выделен как cutoff, а не автоматически как ошибка рассуждения; он может влиять на модели с длинными внутренними ответами. Выводы относятся к данному корпусу и настройкам.", s["small"]))
    story.append(para("* Считаются только явные result.error, без вывода скрытых рассуждений. Ошибки качества - это непройденные критерии fixture.", s["small"]))

    vram_labels = [model_display(slug) for slug in order]
    vram_peaks = [calculations[slug]["peakMiB"] for slug in order]
    sample_reports = [reports[slug] for slug in order]
    story += [PageBreak(), para("Память видеокарты", s["h1"]),
              para("Порог guard - 5 500 MiB общей занятой памяти. Сервер кандидата останавливается при превышении порога; предзапусковая проверка также учитывает размер модели и запас.", s["body"]),
              BarChart(vram_labels, vram_peaks, max_value=max(GUARD_MIB * 1.08, max(vram_peaks, default=0)), guard=GUARD_MIB, suffix=" MiB"),
              Spacer(1, 3 * mm), para("Временные ряды фактических замеров GPU", s["h2"]),
              LineChart(sample_reports, vram_labels),
              make_table([["Модель", "Пик всего", "До запуска", "Прирост", "Свободно min", "Запас до порога"], *[
                  [model_display(slug), f"{calculations[slug]['peakMiB']:.0f} MiB",
                   f"{reports[slug]['vram']['beforeMiB']:.0f} MiB", f"{reports[slug]['vram']['peakDeltaMiB']:.0f} MiB",
                   f"{calculations[slug]['minFreeMiB']:.0f} MiB", f"{calculations[slug]['guardMarginMiB']:.0f} MiB"]
                  for slug in order]], [37 * mm, 25 * mm, 22 * mm, 20 * mm, 23 * mm, 30 * mm], font_size=7.0),
              Spacer(1, 2 * mm), para("Baseline - значение nvidia-smi до старта конкретной модели; оно может включать Windows, дисплей и другие процессы. Peak delta - разница общей занятой памяти относительно этого baseline, не per-process оценка.", s["small"])]
    stop = environment["baselineStop"]
    idle = environment["idleRecheck"]
    story.append(para(f"Отдельная проверка baseline: сервер {stop['model']} ({stop['alias']}, port {stop['port']}) остановлен по запросу пользователя; общая занятая память изменилась с {stop['beforeUsedMiB']} до {stop['afterUsedMiB']} MiB. Точное время остановки не записано. Поздняя idle-перепроверка {idle['verifiedAt']} показала {idle['usedMiB']} MiB used / {idle.get('freeMiB', 'n/a')} MiB free. Эти значения не входят в рейтинг кандидатов.", s["small"]))

    story += [PageBreak(), para("Скорость ответа", s["h1"]),
              para("Медиана и p95 рассчитаны из case latency; tokens/s и суммарная latency взяты из проверенного calculations.json. Latency включает полный HTTP round-trip и зависит от системной нагрузки.", s["body"]),
              BarChart(labels, [calculations[slug]["medianLatencyMs"] for slug in order], max_value=max([1] + [calculations[slug]["p95LatencyMs"] for slug in order]), suffix=" ms"),
              Spacer(1, 6 * mm),
              make_table([["Модель", "Медиана", "95-й перцентиль", "Токенов/с, медиана", "Сумма задержек"], *[
                  [model_display(slug), f"{calculations[slug]['medianLatencyMs']:.0f} ms", f"{calculations[slug]['p95LatencyMs']:.0f} ms",
                   f"{calculations[slug]['medianTokensPerSecond']:.2f}", f"{calculations[slug]['totalCaseLatencyMs'] / 1000:.1f} s"]
                  for slug in order]], [48 * mm, 25 * mm, 25 * mm, 31 * mm, 33 * mm]),
              Spacer(1, 7 * mm), para("Контекст измерения", s["h2"]),
              para("Настройки бенчмарка: температура 0, seed 42, один слот, 99 слоёв GPU и максимум 384 выходных токена. Прямой API-бенчмарк использует context из каждого отчёта. Профиль Astra использует контекст 8 192 для сохранения бюджета ответа pi-ai.", s["body"]),
              para("При сравнении важны и задержка, и содержательная точность: более быстрый ответ не компенсирует пропуск обязательных данных или неверный формат.", s["body"])]

    story += [PageBreak(), para("Размер и оценка параметров", s["h1"]),
              para("Параметры и байтовые оценки приведены из calculations.json. P - число сохранённых float tensor elements после исключения известных buffer elements; это не гарантированное число уникальных, trainable или shared model parameters. Теоретические оценки не равны фактической VRAM: они не включают KV cache, optimizer/training state или runtime buffers; GGUF также включает метаданные и структуры квантования.", s["body"]),
              make_table([["Модель", "Параметры", "Исходные веса", "Файлы", "Оценка FP16", "Идеал 4-bit", "GGUF", "Эфф. bpw"], *[
                  [model_display(slug), f"{calculations[slug]['storedFloatParameters'] / 1e9:.2f}B",
                   fmt_bytes(calculations[slug]['originalWeightBytes']), fmt_bytes(calculations[slug]['originalAssetsBytes']),
                   fmt_bytes(calculations[slug]['fp16WeightEstimateBytes']), fmt_bytes(calculations[slug]['ideal4BitWeightEstimateBytes']),
                   fmt_bytes(calculations[slug]['ggufBytes']), f"{calculations[slug]['effectiveGGUFBitsPerParameter']:.2f}"]
                  for slug in order]], [35 * mm, 18 * mm, 22 * mm, 16 * mm, 21 * mm, 18 * mm, 18 * mm, 18 * mm], font_size=7.0),
              Spacer(1, 6 * mm),
              make_table([["Модель", "Исключено элементов", "Сжатие весов", "Пик / VRAM"], *[
                  [model_display(slug), fmt_num(calculations[slug]['excludedBufferElements']),
                   f"{calculations[slug]['originalToGGUFCompression']:.2f}x",
                   f"{calculations[slug]['peakPercentOfVRAM']:.1f}%"]
                  for slug in order]], [52 * mm, 48 * mm, 34 * mm, 32 * mm]),
              Spacer(1, 5 * mm), para("Интерпретация", s["h2"]),
              para("Формулы: FP16 = 2P байт; идеал 4-bit = округление P/2 байт вверх; effective bpw = 8S_GGUF/P; сжатие = S_исходных_весов/S_GGUF. Реальный GGUF хранит блоковые масштабы, метаданные и веса смешанной точности. Эти расчёты не измеряют VRAM или память обучения.", s["body"]),
              para("Compression ratio относится к original weight bytes относительно GGUF, как задано в расчётном файле; licenses/tokenizer/config входят в общий размер файлов вместе с весами.", s["small"])]
    preparation = environment.get("modelPreparation", {}).get("gpt2-xl")
    if preparation:
        story.append(para(
            f"GPT2-XL: запрошен рецепт Q4_K_M, но quantizer сообщил fallback для "
            f"{preparation['fallbackQuantizedTensors']} из {preparation['totalTensors']} тензоров "
            f"из-за размеров блоков. Поэтому это смешанная точность, а не ровно 4 бита "
            f"на каждый вес; {preparation['loggedEffectiveWeightBits']:.2f} bpw в логе "
            "относится только к tensor payload, а effective GGUF bpw выше учитывает весь файл.", s["small"]))

    story += [PageBreak(), para("Методика и происхождение данных", s["h1"]),
              para(f"Suite: {suite['id']} | {len(suite['cases'])} cases | SHA-256 {selection['suite']['sha256']}", s["body"]),
              para("Тесты используют фиксированный синтетический fixture: редактирование точного фрагмента, строгий JSON, извлечение таблиц, уточнение неоднозначного запроса, нативное планирование инструмента и follow-up по результату инструмента. Грейдинг детерминированный; LLM-as-judge не применяется.", s["body"]),
              para("Базовая Qwen3.5 модель исключена из этого набора по прямому запросу пользователя. Исторические диагностические отчёты, где она была активной baseline, не входят в текущий run; основной рейтинг включает только шесть pinned кандидатов.", s["body"]),
              para("Правила отбора", s["h2"]),
              para("Сначала проверяются полнота и совпадение ревизии, artifact SHA-256, quantization и suite SHA/count. Рейтинг: доля полностью пройденных cases по убыванию, затем native_tool_planning pass rate, меньший peak VRAM delta и меньшая медианная задержка. Второй вариант - наименьший GGUF среди меньших моделей в абсолютном диапазоне 10 п.п. от победителя; иначе второе место общего ранжирования.", s["body"]),
              para("Конфигурация", s["h2"]),
              para("GPT2-XL - базовая модель продолжения текста, а не instruction/chat-модель. Для неё использовался /v1/completions с контекстом 1 024; нативный chat tool-calling этой модели не свойственен. Баллы показывают пригодность для выбранной задачи, а не универсальное качество модели.", s["body"]),
              para("Каждый кандидат запускается локально через llama.cpp, один слот, 99 GPU layers, температура 0, seed 42, API loopback. VRAM снимается через nvidia-smi примерно каждую секунду; guard 5 500 MiB относится к общей памяти GPU. Harness использует context 8 192; candidate scores основаны на direct API report settings. В этой оценке документы оставались синтетическими, DOCX инструменты не вызывались.", s["body"]),
              para("Источники модели и фиксация", s["h2"])]
    source_rows = [["Модель", "Зафиксированный репозиторий / ревизия", "Лицензия источника", "Среда конвертации", "SHA-256 GGUF"]]
    for slug in order:
        report = reports[slug]
        model = report["model"]
        revision = model["revision"]
        url = f"https://huggingface.co/{model['originalId']}/tree/{revision}"
        repo_link = f'<link href="{url}" color="#147D83">{model["originalId"]}</link><br/><font size="6">{revision}</font>'
        receipt = artifacts[slug]
        package_versions = receipt.get("pythonPackageVersions", {})
        package_names = ["transformers", "huggingface-hub", "tokenizers", "torch"]
        package_text = " / ".join(f"{name} {package_versions[name]}" for name in package_names if name in package_versions)
        provenance = f"Python {receipt.get('pythonVersion', 'unknown')}<br/>{package_text}<br/>llama.cpp {str(receipt.get('converterCommit', 'unknown'))[:10]}"
        if receipt.get("converterWrapperSummary"):
            provenance += f"<br/>{receipt['converterWrapperSummary']}"
        source_rows.append([Paragraph(model_display(slug), s["appendix"]), Paragraph(repo_link, s["appendix"]),
                            Paragraph(receipt["licenseSummary"], s["appendix"]),
                            Paragraph(provenance, s["appendix"]), Paragraph(model["sha256"], s["provenance"])])
    story.append(make_table(source_rows, [27 * mm, 46 * mm, 38 * mm, 36 * mm, 25 * mm], font_size=7.0))
    story += [Spacer(1, 4 * mm), para("Краткие флаги сверены с сохранёнными LICENSE/README файлами. Это не юридическое заключение; исходный текст конкретной ревизии определяет применимые условия. Hash относится к локальному GGUF-артефакту.", s["small"]),
              para("Исходники runtime: <link href=\"https://github.com/ggml-org/llama.cpp/tree/b11379\" color=\"#147D83\">llama.cpp b11379</link>. Никакой remote custom code не исполнялся.", s["small"]),
              Spacer(1, 3 * mm), para("Параметры benchmark", s["h2"]),
              make_table([["Параметр", "Значение"], ["Видеокарта", environment["hardware"]["gpu"]],
                          ["Драйвер NVIDIA", environment["hardware"]["driverVersion"]],
                          ["Видеопамять", f"{environment['hardware']['totalVRAMMiB']} MiB"],
                          ["Процессор", environment["hardware"]["cpu"]],
                          ["ОЗУ", fmt_bytes(environment["hardware"]["totalRAMBytes"])],
                          ["Windows", environment["hardware"]["osRelease"]],
                          ["ID запуска", run_id], ["Порт", "127.0.0.1:8082"],
                          ["Context", "Chat-кандидаты: 4 096; GPT2-XL: 1 024; Astra: 8 192"], ["GPU layers / slots", "99 / 1"],
                          ["GPU identifier", "nvidia-smi --id=0"],
                          ["Температура / seed", "0 / 42"], ["Ограничение VRAM", "5 500 MiB общей памяти GPU"]], [52 * mm, 120 * mm])]
    if cleanup is None:
        story += [para("Cleanup status", s["h2"]), para("Удаление исходников-кандидатов не подтверждено cleanup.json; отчёт не заявляет, что losers были удалены.", s["small"])]
    else:
        removed = ", ".join(f"{item['slug']} ({fmt_bytes(item['bytes'])})" for item in cleanup["removed"]) or "none"
        retained = ", ".join(cleanup["retained"]) or "none"
        story += [para("Cleanup status", s["h2"]), para(f"Recorded {cleanup['completedAt']}: removed {removed}; retained {retained}.", s["small"])]

    integration = load_json(ROOT / "eval" / "results" / run_id / "integration.json")
    if integration.get("runId") != run_id or integration.get("model") != winner_slug:
        raise ValueError("Integration evidence does not match selected model/run")
    ui = integration["uiCheck"]
    gpu = integration["idleGPURecheck"]
    story += [PageBreak(), para("Проверка в самом Harness", s["h1"]),
              para("Это отдельный smoke после выбора модели, а не часть рейтинга 25 случаев. Контекст увеличен до 8 192 для SDK. Настройки и системный prompt Harness отличаются от прямого сравнительного API.", s["body"]),
              make_table([["Проверка", "Фактический результат"],
                          ["Модель / контекст", f"{model_display(winner_slug)} / {integration['contextWindow']}"],
                          ["Первый API smoke", "Короткий ответ пройден; native tool call не получен; продолжение не запускалось"],
                          ["Второй API smoke", "Ответ и tool call пройдены; продолжение после результата не содержало ответа"],
                          ["Запрос через UI", ui["prompt"]],
                          ["Ожидалось / получено", f"{ui['expected']} / {ui['actual']} - проверка не пройдена"],
                          ["VRAM в простое после проверки", f"{gpu['usedMiB']} MiB занято; {gpu['freeMiB']} MiB свободно"],
                          ["Состояние продукта", "Подключён для исследования. DOCX-инструменты и дообучение отсутствуют"]], [57 * mm, 115 * mm]),
              Spacer(1, 4 * mm),
              para("Оба неуспешных smoke сохранены, включая результаты до и после добавления диагностических полей. Этот раздел не скрывает ошибки победителя и не меняет зафиксированный рейтинг. Снимок VRAM - одна точка при контексте 8 192, не пик сравнительного теста.", s["body"])]
    screenshot = (ROOT / ui["screenshot"]).resolve()
    if not screenshot.is_relative_to(ROOT) or not screenshot.is_file():
        raise ValueError("Integration screenshot is missing or outside the project")
    image_width, image_height = ImageReader(str(screenshot)).getSize()
    story += [Image(str(screenshot), width=172 * mm, height=172 * mm * image_height / image_width),
              para("Наблюдаемый ответ UI: Алматы. Выбранная модель видна в нижней панели. Исправлять тест подбором единственного удачного повторного ответа не стали.", s["small"])]
    return story


def main():
    parser = argparse.ArgumentParser(description="Build the validated Astra candidate benchmark PDF")
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    suite, manifest, selection, reports, calculations, artifacts, cleanup, environment = validate_inputs(args.run_id)
    output = ROOT / "output" / "pdf" / "astra-model-benchmark.pdf"
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(output), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
                            topMargin=21 * mm, bottomMargin=17 * mm, title="Astra local model benchmark",
                            author="Astra local benchmark")
    doc.build(make_report(args.run_id, suite, manifest, selection, reports, calculations, artifacts, cleanup, environment),
              onFirstPage=page_decoration, onLaterPages=page_decoration)
    print(f"Wrote {output}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error))
