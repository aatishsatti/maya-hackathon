# Scam shield: current held-out results (re-run 2026-11-02)

> **Current.** The held-out half of `docs/scam-testset.json` was run once more on 2026-11-02, code at commit `06530d2`, live setting (Spark, reasoning `minimal`), after the cheap word filter was widened. Raw results: `docs/scam-results-held-rerun-2026-11-02.json`. These replace the pipeline numbers further down, which are **stale** (measured with the old filter on 2026-10-28). Honest short version: **37 of 38 held-out scams warned, the 38th cautioned, 0 of 38 normal items wrongly warned**, both for the detector alone and behind the live filter. The set is written by the team and small (38 + 38), so the intervals are wide.

Meta Spark, text only, run once more on the held-out half of docs/scam-testset.json (never used for tuning). Intervals are 95% Wilson intervals; with this few items they are wide.

| detector | scams warned | scams at least cautioned | normal wrongly warned | normal wrongly cautioned |
|---|---|---|---|---|
| New detector alone (six signs, pause level) | 37/38 = 97% (95% CI 87%-100%) | 38/38 = 100% (95% CI 91%-100%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |
| New detector behind the cheap word filter (what runs live) | 37/38 = 97% (95% CI 87%-100%) | 38/38 = 100% (95% CI 91%-100%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |

### The pause moment

- Scams in progress paused: detector alone 5/5 = 100% (95% CI 57%-100%); behind the filter 5/5 = 100% (95% CI 57%-100%).
- Genuine payments in progress wrongly paused: 0/5 = 0% (95% CI 0%-43%).
- Other normal items wrongly paused: 0/33 = 0% (95% CI 0%-10%).

### Every held-out scam that was not warned (behind the filter)

- S114 [invoice_fraud/text/hard] caution: Hi, please find attached the invoice for the boiler service last month. Our bank details have changed, so kindly send the payment of $320 to the new account below.

### Every held-out normal item that was wrongly flagged (warned or cautioned, behind the filter)

- None.

### Caveats (please read before quoting any number)

- The test set was written by the same team that built the detector, so both halves are ours. Real scams in the wild may be harder, or phrased differently.
- There are only 38 scams and 38 normal items in this half. "0 wrongly warned" can hide a true rate of up to about 9%. The intervals above are the honest range.
- The same family of model reads both the examples and the checks, and the same detector run twice can differ by about two items (identical dev runs gave 36 and 38 of 38).
- Text only. Photos (the vision path) were not measured here.
- Warn accuracy is not meaningfully different from the original five-signal prompt (overlapping intervals). What the new detector adds is the pause moment, coverage of typed and spoken talk, and the remote-access and identity-details reads.
- The cheap word filter was widened on 2026-10-29. In this run the behind-the-filter numbers equal the detector-alone numbers, so every held-out scam the detector warned on also reached the check. The old 36-of-38 pass rate no longer applies.
- The held-out half has now been used three times (the original prompt, the first final run, and this re-run after the filter change). No change was made to the detector, the filter or the prompts because of any of them.


---

# Superseded results (2026-10-28, old filter) — STALE, kept for the record

> **Superseded.** Measured with the OLD word filter (36 of 38 held-out scams reached a check). The section above is the current result; do not quote the numbers below as current.

**Change, stated openly:** On 2026-10-28 the live setting of the scam check on typed and spoken talk was changed from reasoning "low" to "minimal". The decision was made on the DEV half only (76 items, 4 runs per setting: both settings warned 99-100% of scams with 0% false warnings and paused 95% of scams in progress; "minimal" was about 1.7 to 2 times faster and used 57% fewer output tokens). The held-out half was then run once more for the new setting. Both held-out results are shown below; neither was hidden or used for tuning.

Meta Spark, text only, each run once on the held-out half of docs/scam-testset.json (never used for tuning). Intervals are 95% Wilson intervals; with this few items they are wide.

| detector | scams warned | scams at least cautioned | normal wrongly warned | normal wrongly cautioned |
|---|---|---|---|---|
| Original five-signal prompt (baseline) | 37/38 = 97% (95% CI 87%-100%) | 38/38 = 100% (95% CI 91%-100%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |
| Reasoning "low" (the first held-out run, the setting live before the change): detector alone | 38/38 = 100% (95% CI 91%-100%) | 38/38 = 100% (95% CI 91%-100%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |
| Reasoning "low" (the first held-out run, the setting live before the change): behind the cheap word filter (what runs live) | 36/38 = 95% (95% CI 83%-99%) | 36/38 = 95% (95% CI 83%-99%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |
| Reasoning "minimal" (live now): detector alone | 37/38 = 97% (95% CI 87%-100%) | 38/38 = 100% (95% CI 91%-100%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |
| Reasoning "minimal" (live now): behind the cheap word filter (what runs live) | 35/38 = 92% (95% CI 79%-97%) | 36/38 = 95% (95% CI 83%-99%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |

## The pause moment

- Reasoning "low" (the first held-out run, the setting live before the change): scams in progress paused 5/5 = 100% (95% CI 57%-100%) (detector alone), 4/5 = 80% (95% CI 38%-96%) (behind the filter); genuine payments in progress wrongly paused 0/5 = 0% (95% CI 0%-43%); other normal items wrongly paused 0/33 = 0% (95% CI 0%-10%).
- Reasoning "minimal" (live now): scams in progress paused 5/5 = 100% (95% CI 57%-100%) (detector alone), 4/5 = 80% (95% CI 38%-96%) (behind the filter); genuine payments in progress wrongly paused 0/5 = 0% (95% CI 0%-43%); other normal items wrongly paused 0/33 = 0% (95% CI 0%-10%).

## Reasoning "low" (the first held-out run, the setting live before the change): every held-out scam that was not warned (behind the filter)

- S010 [government/spoken] none (the word filter did not pass it to Spark): I got a call saying my pension was being stopped because of a mistake in my records and that I had to give my bank number to fix it.
- S130 [in_progress/spoken] none (the word filter did not pass it to Spark): The man on the phone is helping me with my computer and he has asked me to type in the address he gave me. It is some kind of support page and I am just about to press enter.

## Reasoning "low" (the first held-out run, the setting live before the change): every held-out normal item wrongly flagged (warned or cautioned, behind the filter)

- None.

## Reasoning "minimal" (live now): every held-out scam that was not warned (behind the filter)

- S010 [government/spoken] none (the word filter did not pass it to Spark): I got a call saying my pension was being stopped because of a mistake in my records and that I had to give my bank number to fix it.
- S114 [invoice_fraud/text/hard] caution: Hi, please find attached the invoice for the boiler service last month. Our bank details have changed, so kindly send the payment of $320 to the new account below.
- S130 [in_progress/spoken] none (the word filter did not pass it to Spark): The man on the phone is helping me with my computer and he has asked me to type in the address he gave me. It is some kind of support page and I am just about to press enter.

## Reasoning "minimal" (live now): every held-out normal item wrongly flagged (warned or cautioned, behind the filter)

- None.

## Caveats (please read before quoting any number)

- The test set was written by the same team that built the detector, so both halves are ours. Real scams in the wild may be harder, or phrased differently.
- There are only 38 scams and 38 normal items in this half. "0 wrongly warned" can hide a true rate of up to about 9%. The intervals above are the honest range.
- The same family of model reads both the examples and the checks, and the same detector run twice can differ by about two items (identical dev runs gave 36 and 38 of 38).
- Text only. Photos (the vision path) were not measured here, and the photo check is unchanged.
- Warn accuracy is not meaningfully different between the original prompt and either setting (overlapping intervals). What the new detector adds is the pause moment, coverage of typed and spoken talk, and the remote-access and identity-details reads.
- The cheap word filter that guards the live check let through 36 of 38 held-out scams: about 1 scam description in 20 gets no check and no pause moment, although Maya still replies naturally. A looser filter would check more than half of ordinary chat lines, which costs too much, so it was left as is.
- The held-out half has now been run twice with the full detector: once at reasoning "low", once at "minimal". The second run was made only to report the new live setting; no tuning followed either run.
