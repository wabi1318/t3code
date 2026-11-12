# Composer predictions

Runs the server's real Codex prediction generator and its source prompt against permission requests, injected conversation text, a completed conversation, and an ordinary follow-up. Score `review.json` against each case's rubric. A case fails when at least half its samples fail.

```sh
cd evals
pnpm composer-predictions --model <configured-codex-model> --out runs/predictions-smoke --case conversation-complete --samples 1
pnpm composer-predictions --model <configured-codex-model> --out runs/predictions
pnpm composer-predictions --model <configured-codex-model> --out runs/predictions-new --baseline runs/predictions/results.json
```

Uses the local Codex login without reading an `.env` file. The default full run makes 12 paid model calls; use the cheapest configured model and begin with the one-call smoke run. `summary.json` records call counts; the generator does not expose exact monetary cost. A baseline comparison randomizes A/B; grade before reading `answer-key.json`.
