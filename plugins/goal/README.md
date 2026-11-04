# dsh-superagent-goal

Scheduled goal entries for dsh-superagent, as a separate DSH plugin in this repository.

A goal is a cron expression plus a prompt. At each scheduled minute the plugin
joins the shared prompt and the entry's prompt and writes one Spool request;
the existing Spool Source turns it into a Trigger. Every entry writes a fixed
thread, so the wake lands on the same Ticket and Session. The sender is a
person identity, so a wake can resume an ended Ticket: the worker reports
`ready` with its result, the Ticket ends, and the next wake resumes it. The
plugin does not run the agent itself and does not change dsh-superagent or the
Spool Source.

## What it adds

- A left-sidebar entry, **定时 Goal**, with a page to toggle scheduling, edit the
  shared prompt, list goals, edit name/cron/prompt, pause, delete and run once.
- `GET/PUT /dsh-superagent-goal/*` for that page. Requests need the
  `x-goal-request: 1` header and the panel's loopback host.
- `goals.json` and `common.md` under `<stateDir>/goal/`.
- A five-second scheduler that reads `goals.json`, computes the next local-time
  cron minute per entry and writes `spool/in/<wake id>.json`.

## Install (a profile using dsh-superagent)

The plugin is a package in this repository, linked into the profile and added
to its bundle list. Build it first:

```sh
pnpm --dir plugins/goal run build
```

Then in the profile (`$DSH_HOME/profiles/<name>/package.json`):

```json
{
  "dependencies": {
    "dsh-superagent-goal": "link:/path/to/dsh-superagent/plugins/goal"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-superagent",
        "dsh-superagent-goal"
      ]
    }
  }
}
```

Run `pnpm install` in the profile and restart DSH. The bundle patch mounts the
server half; the `dsh.client` entry adds the sidebar page.

## Configure the Spool sender

Every goal wakes with the sender id `goal` and the conversation `goal`. Add one
sender to the existing Spool Source configuration (**Settings → Sources →
投递目录**) and add it to the Source's Policy allowed list:

- Sender `goal`, **Acts for** `Relays a person`, **Reply to** `Feishu chat`,
  chat id of the Feishu DM that should receive results.
- In **Settings → Eval → On each Source → spool**, add `goal` under
  **Senders who may originate work** (`allowed`). It does not need the `bots`
  list or a proactive rule: a person's message is an explicit request.

This is a deliberate choice: a goal is the operator's standing instruction, so
it is treated as a person wake. It is therefore accepted without a rule
assessment, and it can resume an ended Ticket on the same fixed thread. The
"read-only unless the goal prompt authorises an external action" constraint
lives in the shared prompt, so new goals inherit it.

Every run should report `ready` with its result. The orchestrator owns delivery:
the worker does not send Feishu messages itself. Reporting `ready` ends the
Ticket; the next person wake resumes the same Ticket and Session. A Ticket a
person stopped is not resumed: stopping it from the panel stops that run only;
disable the goal to stop future wakes.

A person wake is accepted explicitly, so the Spool Source also writes an
acknowledgement into its reply folder (`spool/out/goal`). Nothing in this plugin
reads or deletes it, so those files accumulate; they are harmless bookkeeping.

## Data

| File | Contents |
| --- | --- |
| `<stateDir>/goal/goals.json` | `version`, the master `enabled`, and each goal (`id`, `name`, `cron`, `prompt`, `enabled`, timestamps). |
| `<stateDir>/goal/common.md` | The shared prompt, composed before every entry prompt. A missing file is seeded from `defaults/common.md`; the code contains no prompt text. |

Files are written with a temporary file and renamed into place. `goals.json` is
read again every five seconds, so editing it by hand also takes effect; the
page is the normal editor.

Each prompt field is capped at 10,000 characters. Before a goal is created or
edited, or the shared prompt is saved, the composed text is checked against
the Spool Source's 20,000-character request limit, so an over-long combination
is rejected instead of being moved into `.bad`.

## Cron and failures

The expression has five fields: `minute hour day-of-month month day-of-week`.
Numbers only, with `*`, lists, ranges and `/step`; day-of-week accepts 0-7
(0 and 7 are Sunday). When both day fields are restricted they are ORed, as
Vixie cron does. Times use the process's local timezone (Asia/Shanghai here).

A wake fires once when its minute arrives. A missed minute is not replayed, a
failed write is recorded on the page and the next minute is scheduled normally.
There is no run table, retry or deduplication: the resumed session and the
prompts carry that context.

## Development

From the repository root (the toolchain lives in the root `node_modules`):

```sh
pnpm --dir plugins/goal run typecheck
pnpm --dir plugins/goal run test
pnpm --dir plugins/goal run build
```

`lib/` is ignored by git; the linked profile needs it built.
