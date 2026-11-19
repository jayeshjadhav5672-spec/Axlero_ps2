# AI Intake Pipeline — Evaluation Report

- **Generated:** 2026-11-19T08:30:11.841Z
- **Mode:** Offline fixture replay (deterministic)
- **Dataset:** AI Intake Pipeline Evaluation Dataset v1.0.0
- **Cases:** 41 of 41
- **Routing model:** fixture-baseline (deterministic model double)
- **Extraction model:** fixture-baseline (deterministic model double)

> **Mode note:** These numbers measure the deterministic pipeline (routing validation, normalization, provenance enforcement, null handling, review flags, and the evaluation harness) against reference model outputs. They are **not** live model-quality measurements. Run `--live` with provider credentials to measure the configured models.

## Summary

| Metric | Value |
|---|---:|
| Overall case pass rate | 100.0% |
| Routing accuracy | 100.0% |
| Field exact-match rate | 100.0% |
| Field precision | 100.0% |
| Field recall | 100.0% |
| Field F1 | 100.0% |
| Null accuracy (expected-null fields) | 100.0% |
| Hallucination rate (non-null where null expected) | 0.0% |
| Provenance validity rate | 100.0% |
| Review-flag accuracy | 100.0% |
| Enum alias normalization accuracy | 100.0% |
| Schema violations | 0 |
| Contract violations | 0 |

## Case counts

| Category | Cases | Passed | Failed |
|---|---:|---:|---:|
| Routing | 20 | 20 | 0 |
| Extraction | 21 | 21 | 0 |
| **Total** | **41** | **41** | **0** |

## Extraction details

| Counter | Value |
|---|---:|
| Asserted fields | 130 |
| Expected non-null fields | 69 |
| Predicted non-null fields | 69 |
| True positives | 69 |
| False positives | 0 |
| False negatives | 0 |
| Expected-null assertions | 61 |

## Failure examples

No failing cases in this run.

## Coverage tags

| Tag | Cases |
|---|---:|
| ambiguous | 7 |
| auto_route | 1 |
| clear | 13 |
| complete | 2 |
| date_normalization | 2 |
| date_rejection | 1 |
| enum_alias | 9 |
| enum_rejection | 2 |
| extraction | 21 |
| hallucination | 5 |
| low_confidence | 1 |
| malformed | 2 |
| null_handling | 5 |
| number_normalization | 1 |
| out_of_scope | 1 |
| prompt_injection | 2 |
| provenance_rejection | 1 |
| routing | 20 |

## Known limitations

- The dataset is intentionally small (about 40 cases) and is a regression suite, not a statistically representative benchmark.
- Expected labels are curated by the project authors; ambiguous cases reflect one defensible interpretation.
- Offline fixture mode validates pipeline wiring, normalization, null handling, and the harness. It does not measure live model quality.
- Live routing and extraction accuracy vary by provider, model version, temperature, and retry behaviour.
- Provenance validation checks that a quote is a verbatim substring of the source. It does not prove semantic entailment for every quote.
- Enum synonyms are finite. Unseen synonyms correctly produce null, which can lower recall on live traffic.
- Numeric dates like 03/04/2026 are rejected by design because day/month order is ambiguous.
- Cross-field consistency (for example dependents vs. filing status) is not validated.
- The prompt and dataset are English-only.
- Prompt-injection coverage is limited to a few representative cases, not adversarial fuzzing.
- No confidence calibration is performed; the review threshold is a fixed configuration value.
- Live evaluation requires provider credentials and incurs API cost and rate limits.
- Provider failures are surfaced as errors or all-null results elsewhere and are not scored as successful extractions.

## Reproduce

```bash
# Deterministic pipeline regression run (no API key required)
cd server && npm run eval

# Live provider run (requires OPENROUTER_API_KEY; free-tier models may be rate-limited)
cd server && node modules/intake/eval/runEval.js --live --delay-ms=250

# Focused run
cd server && node modules/intake/eval/runEval.js --filter=enum_alias
```
