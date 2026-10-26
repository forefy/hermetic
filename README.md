# Costs, quality and security for Hermes Desktop

<p align="center">
<a href="https://hermes-agent.nousresearch.com/docs/plugins/hermetic"><img src="docs/hermetic-banner.png" alt="Hermetic" title="Hermetic" width="800"/></a>
</p>

<p align="center">
<a href="https://hermes-agent.nousresearch.com/docs/plugins/hermetic"><img alt="Hermetic in the Hermes plugin catalog" title="Hermetic in the Hermes plugin catalog" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fraw.githubusercontent.com%2FNousResearch%2Fhermes-agent%2Fmain%2Fplugin-catalog%2Fhermetic.yaml&query=%24.version&label=Hermes%20catalog&prefix=v&color=a87bff"></a>
<a href="https://hermes-agent.nousresearch.com/docs/plugins/hermetic"><img alt="Minimum Hermes version" title="Minimum Hermes version" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fraw.githubusercontent.com%2FNousResearch%2Fhermes-agent%2Fmain%2Fplugin-catalog%2Fhermetic.yaml&query=%24.requires_hermes&label=requires%20Hermes&color=6d8cff"></a>
<a href="LICENSE"><img alt="License" title="License" src="https://img.shields.io/github/license/forefy/hermetic"></a>
<img alt="Hermetic GitHub commit activity" title="Hermetic GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/forefy/hermetic">
<img alt="GitHub last commit" title="GitHub last commit" src="https://img.shields.io/github/last-commit/forefy/hermetic">
<img alt="Hermetic GitHub repo size" title="Hermetic GitHub repo size" src="https://img.shields.io/github/repo-size/forefy/hermetic">
<a href="https://github.com/forefy/hermetic/issues"><img alt="Issues" title="Issues" src="https://img.shields.io/github/issues-raw/forefy/hermetic"></a>
</p>

<p align="center">
<a href="https://hermes-agent.nousresearch.com/docs/plugins/hermetic" title="Hermetic in the Hermes plugin catalog">Catalog listing</a>
| <a href="INSTALL.md" title="Install Hermetic">Install</a>
| <a href="https://github.com/forefy/hermetic/issues/new" title="Report a bug">Report a bug</a>
| <a href="https://github.com/forefy/hermetic/issues/new?labels=enhancement" title="Request a feature">Feature request</a>
| <a href="https://twitter.com/forefy" title="Forefy on Twitter">Twitter</a>
</p>

https://github.com/user-attachments/assets/9edb1fa1-7460-437f-a577-f987e93c1042

## What is Hermetic

Hermetic is a status-bar popover for the [Hermes](https://github.com/NousResearch/hermes-agent) desktop app. It shows what your agent costs, whether its skills and replies are getting better or worse, and what the harness itself touched.

```bash
hermes plugins install hermetic --enable
```

Then see [INSTALL.md](INSTALL.md) for the two remaining steps and how to check it worked.

- [Costs](#costs)
- [AAI (applied-AI quality)](#aai-applied-ai-quality)
- [HDR (harness detection and response)](#hdr-harness-detection-and-response)
- [What it does on your machine](#what-it-does-on-your-machine)
- [Updates](#updates)

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
- What stops your requests: the OpenRouter credits or key limit, a plan's usage windows (Anthropic, OpenAI Codex) with when they reset, or Nous credits, as Hermes reports them.
- Usage Hermes has no price for (custom endpoints) is estimated: at the gateway's published price when it publishes one (Hopscotch), else at the serving provider's OpenRouter price. A chat's cost is spread over the days it ran, not booked to the day it started.
- **Providers** (OpenRouter): which providers actually served your calls, where they are based, and your routing rules, with an editor for them.
<p align="center">
  <img src="docs/hermetic-providers.png" alt="Which model, providers and regions served your calls" width="400">
  &nbsp;
  <img src="docs/hermetic-routing-rules.png" alt="OpenRouter routing rules editor" width="400">
</p>

- **Improve**: one-click config fixes, for example routing to the cheapest provider, running background tasks on a cheaper model, turning fallback on when calls fail on rate limits, or turning on Hermes' proactive prune of old tool output when, at the prices your chats were actually served, the re-sends it saves outweigh the full-price re-send each prune causes. Every fix shows the exact `config.yaml` change before it writes anything, and writes on top of the config as it is at that moment.

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
- **Settings**: test skill changes automatically when the background review makes them (off, ask me, or revert), and grade replays with a judge model. Each skill's grading rubric is written from the skill itself the first time it is graded. The judge runs on your main model unless you allow another (below), and the popover says when that is the agent's own model family. Check it against your stars: it is trusted when it agrees with your ratings (20, 5 of them low) and fails most replies you corrected, which are wrong answers in your agent's own fluent style. Until then, automatic revert ignores its verdict.

<p align="center">
  <img src="docs/hermetic-aai-settings.png" alt="Changed skills and settings for automatic tests and the judge" width="400">
</p>

## HDR (harness detection and response)

What the harness touched and how exposed it is. It records and shows everything, and its guard can ask you or block before the riskiest tool calls.

<p align="center">
  <img src="docs/hermetic-hdr.png" alt="HDR view: the guard, destinations, sensitive places and what runs on its own" width="400">
  &nbsp;
  <img src="docs/hermetic-hdr-pipeline.png" alt="Where each plugin acts on a model request and on a tool call" width="400">
</p>

- **Guard**: one setting for the risky tool calls Hermes does not check itself: reading keys and logins (through any tool), and writing startup items or key places Hermes does not list (cloud keys, signing keys, GitHub and Docker logins, cluster access, the keychain, Hermes' vault). Writes Hermes already asks about, like shell settings and SSH keys, are left to Hermes. **Watch** records them. **Ask** holds the call and asks you in Hermetic, whatever Hermes' approvals setting: a card above the status bar (or a macOS notification when Hermes is in the background) says what the agent wants and why, and you allow or block it once, for that chat, or always, for the file, its folder or the whole kind. No answer in 20 seconds, or nobody at Hermes (scheduled jobs), blocks the call. **Block** stops the call and tells the agent why. Your saved rules are listed under the guard, each with a remove link.
- **Hooks**: every shell hook in `config.yaml` and every gateway hook in `hooks/`, what each can do (change tool calls, add to every prompt, see tool results, run with no prompt), whether Hermes approved it, and anything Hermes keeps quiet about: a hook script edited after you approved it (Hermes keeps trusting it; HDR shows the lines that changed until you mark it reviewed), new hooks, and hooks that run unasked because auto-accept is on.
- **Where data went**: every host that model requests and tools reached. Tool traffic is drawn as a flow from tool kind to destination to known or new, and each host lists the chats behind it.
- **Files and secrets**: where tools worked, and the sensitive places they touched (keys and logins, startup items, shell settings, system files, the browser vault), each scored. Reading keys scores high; writing to startup items scores highest. Code that names a place counts as a write unless every line naming it only reads it (`ls`, `cat`, `stat` and the like) and nothing in the code writes anywhere. Click a place to see the line that ran, open the chat, or mark its reads as expected for that scheduled job or chat; a write, or a read from anywhere else, still shows.
- **What runs on its own**: scheduled jobs with their schedule and next run, ports opened under Hermes and the chats that opened them, subagents and background processes.
- **What shapes every prompt**: SOUL.md and the memory files against Hermes' own size limits, when each last changed, and memory and skill writes made from chats.
- **Plugins and middleware**: where each enabled plugin acts on the path of a model request and of a tool call, and anything it registers without declaring it.

## What it does on your machine

**Model requests.** On every request that goes to OpenRouter, Hermetic's `llm_request` middleware adds the routing fields from `provider_routing` in your `config.yaml` that Hermes does not send on its own: fallbacks, zero data retention, distillable text, quantizations, max price, minimum throughput and maximum latency, including per-model overrides. Requests to any other provider go out unchanged, and on any error the request goes out unchanged. The `llm_execution` middleware only reads the generation id and finish reason off the result.

**Tool calls.** A `pre_tool_call` hook checks each tool call against HDR's rules (`hdr_rules.py`). At Watch, the default, it changes nothing. At Ask the call waits, up to 20 seconds, while Hermetic asks you: the question sits in `~/.hermes/hermetic/hdr/asks/` (shared by every profile), the popover lists it every 2 seconds and shows it, and a macOS notification asks when Hermes is in the background; no answer, or no popover checking in, blocks the call. At Block it stops them. Rules you save are kept in each profile's `hermetic/hdr/guard.json`, and every decision is noted in `hermetic/hdr/guard.jsonl`. The guard never approves anything Hermes would ask about, and if its own check fails, the call goes ahead as if the guard were off.

**Model calls of its own.** Only when you press replay, compare, draft or judge, or when you turn on automatic tests.
- Fix drafts, the judge and rubric drafts use Hermes' plugin model access (`ctx.llm`) on your main model. To let the judge use a different model, allow it in `config.yaml` under `plugins.entries.hermetic.llm` (`allow_model_override: true` and `allowed_models`).
- Replays call OpenRouter with the `OPENROUTER_API_KEY` Hermes holds for the profile, read through Hermes' secret scope. They follow your routing rules and appear in your spend like any other call. A replay costs about $0.01 per test; automatic tests stop at $0.50 a day.
- No API key ever reaches the popover.

**Network.** The popover reads OpenRouter's public model, provider and zero-retention lists, and, only for models a profile was billed for through hopscotchlabs.ai, that model's public page on hopscotchlabs.ai for its price (no key; once a day per model). The backend asks Hermes for its account report on the profile's provider (at most every minute): OpenRouter usage and limits, a plan's usage windows for Anthropic and OpenAI Codex, or Nous credits. Hermes looks up the credential for that; Hermetic only receives the report. Nothing else leaves your machine.

**What it reads.** Hermes' session database (read-only, through Hermes' `SessionDB`), `config.yaml`, the skills and their change history, scheduled jobs, SOUL.md and the memory files (sizes and change times), installed plugin sources (to see what each registers), shell hooks in `config.yaml`, Hermes' hook approvals (`shell-hooks-allowlist.json`), gateway hooks in `hooks/`, the hook scripts themselves (a copy of each, as first seen, is kept in `hermetic/hdr/hooks.json` to show later edits), and its own routing records. HDR runs `ps` and `lsof` locally to list ports opened under Hermes.

**What it writes, and only when you ask.** Routing rules and the fixes you apply (through Hermes' own config functions, shown before writing), archived skills, skill versions you ship or revert, the guard's level and your guard rules, places you mark as expected (`hermetic/hdr/expected.json`), and test results.

**In the background.** A thread checks every 5 minutes for skill changes made by the background review, and acts only if you turned automatic tests on. A short-lived thread stores the billed-spend snapshot.

Everything Hermetic records stays in `$HERMES_HOME/hermetic/` (ratings, tests, replay results, saved skill versions, routing history).


Check the package with `hermes plugins validate .`

## Updates

Hermes auto-manages plugin updates for you after installation, from this repo we bump `version` in `plugin.yaml`, commit, then run `scripts/release.sh --pr`. It runs the tests and Hermes' validation, pushes, fills the catalog entry with the new commit, and opens the pin-bump PR on NousResearch/hermes-agent. Catalog users get the update once a maintainer merges it.
