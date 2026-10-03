# Candidate selection: candidate-benchmark-2026-10-04-v1

Suite: document-benchmark-v1 (25 cases, SHA-256 `449930d24dc3bd18786b68a494302672c4658243b90887ab763db4e2360bf70c`).

Winner: **qwen2.5-3b-instruct** (16/25, 64.0%).
Second retained candidate: **lfm2.5-1.2b-instruct** (730899040 GGUF bytes, 40.0% pass rate; second-ranked fallback; no smaller qualifying candidate).

| Rank | Candidate | Whole suite | Native tool planning | GGUF bytes | Peak total (delta) | Median latency | Original license flag |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | qwen2.5-3b-instruct | 16/25 (64.0%) | 3/4 | 1929903104 | 2161 MiB (2161 MiB delta) | 717 ms (25 valid) | other |
| 2 | lfm2.5-1.2b-instruct | 10/25 (40.0%) | 2/4 | 730899040 | 905 MiB (905 MiB delta) | 307 ms (25 valid) | other |
| 3 | lfm2.5-2.6b | 4/25 (16.0%) | 1/4 | 1674455136 | 1827 MiB (1827 MiB delta) | 4124 ms (25 valid) | other |
| 4 | qwen2.5-coder-3b-instruct | 3/25 (12.0%) | 0/4 | 1929903168 | 2161 MiB (2161 MiB delta) | 912 ms (25 valid) | other |
| 5 | qwen2.5-coder-1.5b-instruct | 1/25 (4.0%) | 0/4 | 986048672 | 1209 MiB (1209 MiB delta) | 517 ms (25 valid) | apache-2.0 |
| 6 | gpt2-xl | 0/25 (0.0%) | 0/4 | 1182596384 | 1545 MiB (1545 MiB delta) | 4686 ms (25 valid) | mit |

## Category passes

| Candidate | Category | Passed |
| --- | --- | ---: |
| qwen2.5-3b-instruct | targeted_edit | 6/6 |
| qwen2.5-3b-instruct | strict_json_extraction | 3/4 |
| qwen2.5-3b-instruct | table_extraction | 1/2 |
| qwen2.5-3b-instruct | clarification_no_edit | 3/5 |
| qwen2.5-3b-instruct | native_tool_planning | 3/4 |
| qwen2.5-3b-instruct | tool_result_followup | 0/4 |
| lfm2.5-1.2b-instruct | targeted_edit | 3/6 |
| lfm2.5-1.2b-instruct | strict_json_extraction | 2/4 |
| lfm2.5-1.2b-instruct | table_extraction | 0/2 |
| lfm2.5-1.2b-instruct | clarification_no_edit | 1/5 |
| lfm2.5-1.2b-instruct | native_tool_planning | 2/4 |
| lfm2.5-1.2b-instruct | tool_result_followup | 2/4 |
| lfm2.5-2.6b | targeted_edit | 0/6 |
| lfm2.5-2.6b | strict_json_extraction | 0/4 |
| lfm2.5-2.6b | table_extraction | 0/2 |
| lfm2.5-2.6b | clarification_no_edit | 0/5 |
| lfm2.5-2.6b | native_tool_planning | 1/4 |
| lfm2.5-2.6b | tool_result_followup | 3/4 |
| qwen2.5-coder-3b-instruct | targeted_edit | 0/6 |
| qwen2.5-coder-3b-instruct | strict_json_extraction | 0/4 |
| qwen2.5-coder-3b-instruct | table_extraction | 0/2 |
| qwen2.5-coder-3b-instruct | clarification_no_edit | 1/5 |
| qwen2.5-coder-3b-instruct | native_tool_planning | 0/4 |
| qwen2.5-coder-3b-instruct | tool_result_followup | 2/4 |
| qwen2.5-coder-1.5b-instruct | targeted_edit | 0/6 |
| qwen2.5-coder-1.5b-instruct | strict_json_extraction | 0/4 |
| qwen2.5-coder-1.5b-instruct | table_extraction | 0/2 |
| qwen2.5-coder-1.5b-instruct | clarification_no_edit | 0/5 |
| qwen2.5-coder-1.5b-instruct | native_tool_planning | 0/4 |
| qwen2.5-coder-1.5b-instruct | tool_result_followup | 1/4 |
| gpt2-xl | targeted_edit | 0/6 |
| gpt2-xl | strict_json_extraction | 0/4 |
| gpt2-xl | table_extraction | 0/2 |
| gpt2-xl | clarification_no_edit | 0/5 |
| gpt2-xl | native_tool_planning | 0/4 |
| gpt2-xl | tool_result_followup | 0/4 |

## Limitations
- VRAM is total device use and includes Windows and other processes; peak delta is not exclusive per-process memory.
- Latency median uses only finite, non-negative measurements; failed requests without latency are excluded.
- License identifiers are copied from the pinned source metadata; review the original license text before redistribution.
