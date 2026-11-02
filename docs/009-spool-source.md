# 009 Spool Source

The Spool Source lets a local program hand dsh-superagent a request without a chat account or a remote API. The program writes one JSON file into an incoming folder; the Source turns it into a Trigger, and the agent's replies appear as JSON files in a reply folder the program reads.

Use it when the thing that notices work is already a program: a price monitor, a cron job, a crawler, a local service. The program owns the deterministic judgement (a threshold, a regex, a failed check), and dsh-superagent owns the work that follows. Changing what is watched changes the program and its JSON, not dsh-superagent's code.

The kind is `spool`. It ships as the `dsh-superagent/spool-watch` plugin, inserted disabled by the bundle's `cordis.patch.yml`; enable it in the profile, then configure it in the panel under **Settings → Sources**.

## Configuration

| Field | Meaning |
| --- | --- |
| Incoming folder | An absolute path. The Source polls `*.json` files here. Read files move into `.done`; files that are not a valid request move into `.bad`. |
| Reply folder | An absolute path. A reply is written as `<reply folder>/<conversation>/<message id>.json`. Leave it empty while requests need no answers. |
| Senders | The identities a program may use. Each has an `id`, an **Acts for** value (`Relays a person` or `Itself`) and an optional default business. The identity is fixed here: a program cannot choose to be a person by writing a field. |
| Polling interval | Seconds between reads; 2–600, default 5. |

A program writes a complete file and renames it into the incoming folder, so the Source never reads half-written JSON. Both folders must be writable by the user dsh-superagent runs as.

The bundle inserts the plugin disabled. Enable it in the profile's patch layer:

```yaml
- id: dsh-superagent-spool
  disabled: false
```

Then set the folders and senders in the panel and save the Source. Saving the Source's values does not restart dsh-superagent; changing the profile's plugin rows takes effect when the profile is next started.

## A request

```json
{
  "id": "alert-2026-11-02-btc",
  "sender": "market-monitor",
  "conversation": "alerts",
  "text": "BTC 跌破 60,000 美元已经 15 分钟。查一下最近的行情和仓位，给出是否需要调整的建议。",
  "business": "trading",
  "type": "research",
  "repo": "/home/me/crypto-investment",
  "at": "2026-11-02T14:39:20+08:00",
  "addressed": true,
  "url": "https://example.com/alerts/alert-2026-11-02-btc"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | A request id, unique for its sender. It is part of the Trigger id, so reusing it is a duplicate, not a second request. |
| `sender` | yes | A sender id from the Source configuration. An id not on that list is received but filtered with the reason `sender_not_listed`. |
| `conversation` | no | A folder name under the reply folder; `default` when omitted. |
| `thread` | no | The request that began this exchange. A relaying person's later request naming it follows up on its Ticket; a program's also reaches Eval, because non-human Triggers are always assessed. Omitted means this request starts a Thread. |
| `text` | yes | What the agent should do, up to 20,000 characters. It is untrusted data, not authorization. |
| `business` | no | A business id; the sender's default business applies when omitted. |
| `type` | no | A work type, such as `research` or `review`, for the Executor. |
| `repo` | no | An absolute path of a local repository the request concerns. It is passed through to the worker environment; the Source does not check that it exists. |
| `at` | no | An ISO 8601 time with an offset; now when omitted. It is normalized, not range-checked. |
| `addressed` | no | `true` by default. `false` makes a relaying person's message an unaddressed admission case. |
| `url` | no | A page people can open for the original signal. |

## Replies

The agent answers where the Trigger's Channel points: a file named after the outbound message id.

```json
{
  "id": "3f4c…",
  "kind": "reply",
  "conversation": "alerts",
  "thread": "alert-2026-11-02-btc",
  "replyTo": "alert-2026-11-02-btc",
  "ticket": "…",
  "text": "…",
  "at": "2026-11-02T14:52:00.000Z"
}
```

`kind` is `acknowledgement`, `reply` or `notice`. The file is written once and never replaced, so a retried send stays idempotent; the program reads the file and removes it. A request received while the reply folder was empty has no destination, so its messages are dropped as `gone` and the Source shows them in the panel.

Changing the reply folder after a request has been received drops that Ticket's later replies: the saved Channel address is checked against the current folder. Finish open Tickets first, or keep the old folder configured.

## Notifying a person in Feishu

A Spool-triggered Ticket has no Feishu Channel: its replies go to the reply folder. To notify a person in Feishu, put the destination chat in the request — for example a line `notify: feishu chat oc_…` — and have the worker send it with the bot's CLI after the work:

```sh
lark-cli im +messages-send --chat-id oc_… --text "…"
```

This works without a code change when the deployment has a Feishu bot, because workers get a bot-only `lark-cli`. It is not the Outbox: the send has no idempotency key, retry or audit, so keep the message short and repeatable. For a built-in path, the Source would need a notification target of its own.

## Who may originate work

The Source's Policy part has two lists:

- **Senders who may originate work** — senders configured as **Relays a person**. Such a sender's `addressed` message is an explicit request; an unaddressed one goes through the admission table's `listedUnaddressed` cell, which may be set to inferred or ignored.
- **Programs whose messages may become candidates** — senders configured as **Itself**. A listed program's request is at most an inferred candidate for the rules to assess; it never makes an explicit request and never stops a Ticket.

A sender that is configured in the Source but appears in neither Policy list can still be received; its requests are ignored unless the admission table admits them. To let a relaying sender originate work, add it to **Senders who may originate work**; the admission table can also admit a configured sender that is not on that list, as with other Sources. A program acting for itself must be on the bots list. Removing a person sender stops new explicit requests from it while leaving open Tickets revalidated under the normal Policy rules.

## What a worker receives

Tickets started from the Spool carry their request facts in the environment:

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_SPOOL_SENDER` | The sender id |
| `DSH_SUPERAGENT_SPOOL_CONVERSATION` | The conversation id |
| `DSH_SUPERAGENT_SPOOL_BUSINESS` | The business id, from the request or the sender's default |
| `DSH_SUPERAGENT_SPOOL_TYPE` | The work type, when the request names one |
| `DSH_SUPERAGENT_SPOOL_REPO` | The local repository path, when the request names one |

Each is empty for a Ticket that did not start in the Spool.

## Operations

- **Read files.** After a request is received, the file moves into `.done`; a duplicate is moved too, without a second Trigger, and the health detail counts it. Text that is not a valid request moves into `.bad`. An unreadable file (permission, I/O, a directory named like a request) stays in place and fails the round, so the Source retries it and reports the failure instead of silently dropping the request. `.bad` is not pruned yet.
- **One poller per folder.** A receiving folder belongs to one dsh-superagent instance; two pollers would race on `.done` and `.bad`.
- **Health.** The Source reports `spool` health: waiting for setup, off, no incoming folder, the last round's counts, or three consecutive polling failures.
- **Threads.** A Thread key is `spool:<conversation>/<root>`. The panel labels the Thread with its conversation and records the sender and conversation as facts. `orchestrator_read thread/spool:<conversation>/<root>` and a search for that key work without extra code.
- **No Thread context.** Requests are single files, so assessments read the Trigger's own text; there is no conversation to page through. Put what an assessment needs into `text` (or an attachment path the worker can read).
- **Access.** Anyone who can write to the incoming folder can submit a request, and the file's `sender` selects one of the configured identities. The identity's person or program nature still comes from the configuration, but protect the folder: a writer can speak as any configured sender.

For the implementation contract, see [008 Cookbook](008-cookbook.md); for the domain terms, [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).
