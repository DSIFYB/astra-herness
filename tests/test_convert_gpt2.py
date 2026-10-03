import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "convert-gpt2.py"
SPEC = importlib.util.spec_from_file_location("convert_gpt2_wrapper", SCRIPT)
WRAPPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WRAPPER)


class FakeGPT2Model:
    def __init__(self):
        self.calls = []

    def modify_tensors(self, data, name, block_id):
        self.calls.append((data, name, block_id))
        return [(name, data)]


class GPT2ConverterWrapperTests(unittest.TestCase):
    def test_skips_only_the_two_nontrainable_attention_masks(self):
        WRAPPER.patch_gpt2_model(FakeGPT2Model)
        model = FakeGPT2Model()

        self.assertEqual(list(model.modify_tensors("bias", "h.0.attn.bias", 0)), [])
        self.assertEqual(list(model.modify_tensors("masked", "h.0.attn.masked_bias", 0)), [])
        self.assertEqual(model.calls, [])

    def test_delegates_trainable_attention_weights_and_biases_to_upstream_method(self):
        WRAPPER.patch_gpt2_model(FakeGPT2Model)
        model = FakeGPT2Model()

        self.assertEqual(list(model.modify_tensors("weight", "h.0.attn.c_attn.weight", 0)),
                         [("h.0.attn.c_attn.weight", "weight")])
        self.assertEqual(list(model.modify_tensors("bias", "h.0.attn.c_attn.bias", 0)),
                         [("h.0.attn.c_attn.bias", "bias")])
        self.assertEqual(list(model.modify_tensors("bias", "h.0.attn.c_proj.bias", 0)),
                         [("h.0.attn.c_proj.bias", "bias")])
        self.assertEqual(model.calls, [
            ("weight", "h.0.attn.c_attn.weight", 0),
            ("bias", "h.0.attn.c_attn.bias", 0),
            ("bias", "h.0.attn.c_proj.bias", 0),
        ])


if __name__ == "__main__":
    unittest.main()
