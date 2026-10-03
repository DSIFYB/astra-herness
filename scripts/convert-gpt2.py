#!/usr/bin/env python3
"""Run the pinned llama.cpp converter with the GPT-2 attention masks omitted."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path


CONVERTER_ROOT = Path(__file__).resolve().parents[1] / ".runtime" / "llama-source"


def patch_gpt2_model(model_class):
    original_modify_tensors = model_class.modify_tensors

    def modify_tensors(self, data_torch, name, bid):
        if name.endswith((".attn.bias", ".attn.masked_bias")):
            return
        yield from original_modify_tensors(self, data_torch, name, bid)

    model_class.modify_tensors = modify_tensors


def main():
    sys.path.insert(0, str(CONVERTER_ROOT))
    sys.path.insert(0, str(CONVERTER_ROOT / "gguf-py"))
    gpt2_module = importlib.import_module("conversion.gpt2")
    converter = importlib.import_module("convert_hf_to_gguf")
    patch_gpt2_model(gpt2_module.GPT2Model)
    converter.main()


if __name__ == "__main__":
    main()
