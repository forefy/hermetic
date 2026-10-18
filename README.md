# Hermetic

A status-bar popover for the [Hermes](https://github.com/NousResearch/hermes-agent) desktop app. It shows what your agent costs, where its calls go, and whether its skills and replies are getting better or worse.

It has two views in the same popover. The arrow at the top right switches between them.

## Costs

- Spend per day and per session, live $/hour while a turn runs, and the most expensive session.
- Cache hit rate: how much of each prompt came from the provider's cache, and what cache resets cost you.
- Pricing drift: what you were billed compared with list prices.
- **Providers** (OpenRouter): which providers actually served your calls, where they are based, and your routing rules, with an editor for them.
- **Improve**: one-click config fixes, for example routing to the cheapest provider, running background tasks on a cheaper model, or turning fallback on when calls fail on rate limits. Every fix shows the exact `config.yaml` change before it writes anything, and writes on top of the config as it is at that moment.

## AAI (applied-AI quality)

- **Actions**: the few things that need you, each on its own card.
  - Rate recent replies with 1 to 5 stars.
  - Keep a time you corrected Hermes ("no, …", "you forgot …") as a test.
  - Fix a skill whose tests fail: Hermes drafts a new version, it is tested on the same tests, and you decide whether to ship it.
  - Revert a skill change that tested worse.
  - Archive skills that were never used, to save tokens on every call.
- **Tests**: every saved test as a tile, coloured by its last result. Replay them all with your current routing. From 5 tests on, compare your two most-used providers and a second model on the same tests.
- **Timeline**: skill changes made by chats and by the background review, routing changes, rate-limit days and Hermetic's own actions. Changes that added links, code blocks or script files are flagged.
- **Changed skills**: every saved version of a skill, and a replay to compare two of them.
- **Settings**: test skill changes automatically when the background review makes them (off, ask me, or revert), and grade replays with a judge model. Each skill's grading rubric is written from the skill itself the first time it is graded.

Parts that only make sense with OpenRouter (provider routing, provider comparison, fallback) hide themselves when the profile does not use it. Spend, cache, sessions, ratings, corrections, the timeline and skill history work with any provider. Replays, fix drafts and the judge call models through OpenRouter, so they need an OpenRouter key set up in Hermes.

## Install

```bash
hermes plugins install forefy/hermetic --enable
```

Then restart the desktop app (menu: **Quit and Keep Windows**) so the backend routes load.

To run it from a checkout while you work on it:

```bash
git clone https://github.com/forefy/hermetic.git
cd hermetic
./scripts/dev-link.sh
```

## Costs of its own and your data

- Hermetic makes model calls only when you press replay, compare, draft or judge, or when you turn on automatic tests. Those use your own OpenRouter key through Hermes, follow your routing rules (zero data retention, no data collection), and appear in your spend like any other call. A replay costs about $0.01 per test. Automatic tests stop at $0.50 a day.
- Everything it records stays on your machine in `$HERMES_HOME/hermetic/` (ratings, tests, replay results, saved skill versions, routing history). No API key ever reaches the popover.

## Layout

| Path | What it is |
|---|---|
| `desktop/plugin.js` | The popover: plain ESM for the Hermes plugin SDK, no build step |
| `__init__.py` | Hooks and middleware: per-call cost and routing records, provider errors, empty-reply debugging |
| `dashboard/plugin_api.py` | Backend routes under `/api/plugins/hermetic/` |
| `plugin.yaml` | Package manifest |

Check the package with `hermes plugins validate .`
