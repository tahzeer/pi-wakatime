# pi WakaTime

**Community** [WakaTime](https://wakatime.com/) plugin for **Pi**, the coding agent CLI ([pi](https://github.com/earendil-works/pi-coding-agent)).

Track AI coding time, tokens, and prompt activity while using the `pi` TUI, `pi -p`, or any serialized Pi harness.

> **Not affiliated with Pi's authors or WakaTime.** Unofficial community plugin, awaiting review at wakatime.com.

## What it does

- Installs / updates [wakatime-cli](https://github.com/wakatime/wakatime-cli) under `~/.wakatime/` (official GitHub releases only)
- Runs `wakatime-cli --sync-ai-activity` on session start, after each prompt, tool, and turn event
- wakatime-cli parses Pi's saved session transcripts (`~/.pi/agent/sessions/**/*.jsonl`) itself, so heartbeats, tokens, prompt lengths, and model attribution come from the same code path the official agent plugins use
- Serializes CLI runs and retries failures on the next Pi event
- Logs to `~/.wakatime/pi.log`

## Prerequisites

1. wakatime-cli 2.28.0 or newer (installed automatically).
2. WakaTime API key in `~/.wakatime.cfg`:

```ini
[settings]
api_key = waka_your_api_key_here
```

Get a key at [wakatime.com/api-key](https://wakatime.com/api-key).

## Install

```sh
pi install npm:pi-wakatime          # once published
pi install git:github.com/wakatime/pi-wakatime   # straight from git
# or from a local checkout:
pi install ./pi-wakatime
```

Restart Pi, or start a new session. Verify with the startup banner: the
extension appears in the Extensions list (run `/extensions` inside Pi).

To load it manually for a single run:

```sh
pi -e /path/to/pi-wakatime
```

## How it works

Pi's extension API registers the following handlers:

| Pi event | Action |
| --- | --- |
| `session_start` | install/update wakatime-cli, refresh version cache |
| `input` | queue a sync |
| `tool_result` (edit/write tools) | queue a sync |
| `turn_end` | queue a sync |
| `agent_settled` | flush any queued syncs |

Syncs are debounced (3 s), serialized across events, and always delegated to
`wakatime-cli --sync-ai-activity --plugin "pi/<version> pi-wakatime/<version>" --project-folder <cwd>`.
wakatime-cli handles heartbeat attribution, offline queueing, and WakaTime's
AI dashboard fields.

## Development

```sh
npm run check
npm test
```

Runtime tests run the same debounce / retry / serialization logic against an
injected worker, without spawning wakatime-cli.
