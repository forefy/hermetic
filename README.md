# hermetic

A status-bar popover for the [Hermes](https://github.com/NousResearch/hermes-agent) desktop app. It shows what your agent costs, whether its skills and replies are getting better or worse, and what the harness itself touched.

It has three views in the same popover: Costs, AAI and HDR. The dots at the top right show which one you are on, and the arrow steps through them.

<p align="center">
  <img src="docs/hermetic-costs.png" alt="Costs view: spend, cache hit rate and pricing drift" width="400">
  &nbsp;
  <img src="docs/hermetic-aai.png" alt="AAI view: skill changes, rate limits and the actions that need you" width="400">
</p>

## Costs

- Spend per day and per session, live $/hour while a turn runs, and the most expensive session.
- Cache hit rate: how much of each prompt came from the provider's cache, and what cache resets cost you.
- Pricing drift: what you were billed compared with list prices.
- **Providers** (OpenRouter): which providers actually served your calls, where they are based, and your routing rules, with an editor for them.
<p align="center">
  <img src="docs/hermetic-providers.png" alt="Which model, providers and regions served your calls" width="400">
  &nbsp;
  <img src="docs/hermetic-routing-rules.png" alt="OpenRouter routing rules editor" width="400">
</p>

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

<p align="center">
  <img src="docs/hermetic-aai-settings.png" alt="Changed skills and settings for automatic tests and the judge" width="400">
</p>

Parts that only make sense with OpenRouter (provider routing, provider comparison, fallback) hide themselves when the profile does not use it. Spend, cache, sessions, ratings, corrections, the timeline and skill history work with any provider. Replays, fix drafts and the judge call models through OpenRouter, so they need an OpenRouter key set up in Hermes.

## HDR (harness detection and response)

What the harness touched and how exposed it is. For now it records and shows; it does not block anything.

<p align="center">
  <img src="docs/hermetic-hdr.png" alt="HDR view: posture, destinations, sensitive places and what runs on its own" width="400">
  &nbsp;
  <img src="docs/hermetic-hdr-pipeline.png" alt="Where each plugin acts on a model request and on a tool call" width="400">
</p>

- **Posture**: the settings that decide how exposed you are. Approvals, commands you allowed permanently, whether the terminal runs directly on your machine, whether the browser uses your real profile, who can message the agent, the API server and shell hooks. One strip shows them all, and the worst one is spelled out.
- **Where data went**: every host that model requests and tools reached. Tool traffic is drawn as a flow from tool kind to destination to known or new, and each host lists the chats behind it.
- **Files and secrets**: where tools worked, and the sensitive places they touched (keys and logins, startup items, shell settings, system files, the browser vault), each scored. Reading keys scores high; writing to startup items scores highest.
- **What runs on its own**: scheduled jobs with their schedule and next run, ports opened under Hermes and the chats that opened them, subagents and background processes.
- **What shapes every prompt**: SOUL.md and the memory files against Hermes' own size limits, when each last changed, and memory and skill writes made from chats.
- **Plugins and middleware**: where each enabled plugin acts on the path of a model request and of a tool call, and anything it registers without declaring it.

Next: asking or blocking before a risky tool call runs, through Hermes' own approval prompt, and a low-cost judge that checks web pages and new skills before the model reads them.

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
- HDR reads Hermes' own records and runs `ps` and `lsof` locally to list ports. Nothing it finds leaves your machine.
- Everything it records stays on your machine in `$HERMES_HOME/hermetic/` (ratings, tests, replay results, saved skill versions, routing history). No API key ever reaches the popover.

## Layout

| Path | What it is |
|---|---|
| `desktop/plugin.js` | The popover: plain ESM for the Hermes plugin SDK, no build step |
| `__init__.py` | Hooks and middleware: per-call cost and routing records, provider errors, empty-reply debugging |
| `dashboard/plugin_api.py` | Backend routes under `/api/plugins/hermetic/` |
| `plugin.yaml` | Package manifest |
| `tests/test_hdr.py` | HDR detection rules; run with the Python that runs Hermes: `python tests/test_hdr.py` |
| `tests/test_detect.mjs` | How a profile's provider is read from its config: `node tests/test_detect.mjs` |

Check the package with `hermes plugins validate .`
