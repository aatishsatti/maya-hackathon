# Scam shield: final held-out results

Meta Spark, text only, run once on the held-out half of docs/scam-testset.json (never used for tuning). Intervals are 95% Wilson intervals; with this few items they are wide.

| detector | scams warned | scams at least cautioned | normal wrongly warned | normal wrongly cautioned |
|---|---|---|---|---|
| Original five-signal prompt (baseline) | 37/38 = 97% (95% CI 87%-100%) | 38/38 = 100% (95% CI 91%-100%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |
| New detector alone (six signs, pause level) | 38/38 = 100% (95% CI 91%-100%) | 38/38 = 100% (95% CI 91%-100%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |
| New detector behind the cheap word filter (what runs live) | 36/38 = 95% (95% CI 83%-99%) | 36/38 = 95% (95% CI 83%-99%) | 0/38 = 0% (95% CI 0%-9%) | 0/38 = 0% (95% CI 0%-9%) |

## The pause moment

- Scams in progress paused: detector alone 5/5 = 100% (95% CI 57%-100%); behind the filter 4/5 = 80% (95% CI 38%-96%).
- Genuine payments in progress wrongly paused: 0/5 = 0% (95% CI 0%-43%).
- Other normal items wrongly paused: 0/33 = 0% (95% CI 0%-10%).

## Every held-out scam that was not warned (behind the filter)

- S010 [government/spoken] none (the word filter did not pass it to Spark): I got a call saying my pension was being stopped because of a mistake in my records and that I had to give my bank number to fix it.
- S130 [in_progress/spoken] none (the word filter did not pass it to Spark): The man on the phone is helping me with my computer and he has asked me to type in the address he gave me. It is some kind of support page and I am just about to press enter.

## Every held-out normal item that was wrongly flagged (warned or cautioned, behind the filter)

- None.

## Caveats (please read before quoting any number)

- The test set was written by the same team that built the detector, so both halves are ours. Real scams in the wild may be harder, or phrased differently.
- There are only 38 scams and 38 normal items in this half. "0 wrongly warned" can hide a true rate of up to about 9%. The intervals above are the honest range.
- The same family of model reads both the examples and the checks, and the same detector run twice can differ by about two items (identical dev runs gave 36 and 38 of 38).
- Text only. Photos (the vision path) were not measured here.
- Warn accuracy is not meaningfully different from the original five-signal prompt (overlapping intervals). What the new detector adds is the pause moment, coverage of typed and spoken talk, and the remote-access and identity-details reads.
- The cheap word filter that guards the live check let through 36 of 38 held-out scams: about 1 scam description in 20 gets no check and no pause moment, although Maya still replies naturally. A looser filter would check more than half of ordinary chat lines, which costs too much, so it was left as is. The two misses are listed above.
- The held-out half was looked at in totals twice before this run (the original prompt, and the word filter's pass rate). Neither led to any change; the detector, the filter and the prompts were frozen before this run.
