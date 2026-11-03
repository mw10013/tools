# bosun

bosun runs a checkout's dev servers in the background, one per name, and tells
scripts where they are. A server picks its own port and publishes it, so nothing
assigns ports ahead of time and many checkouts run side by side.

## Usage

Run bosun from anywhere inside the checkout. It works on the root of the git
worktree around the working directory.

```sh
bosun start <name> [--note text] [--timeout seconds] -- <command...>
bosun status <name>
bosun stop <name>
bosun logs <name> [-n lines] [-f]
```

- `start` adopts the checkout's running server of that name, or launches the
  command detached, then waits until it answers (3 minutes by default). It
  prints the server's status JSON. A server that exits first fails the start
  with `ServerExitedError` and that run's log lines.
- `status` prints the status JSON. It exits 0 when the server answers and 3
  otherwise.
- `stop` sends SIGTERM to the command's process group, waits for the exit to
  be logged, and sends SIGKILL after 30 seconds.
- `logs` prints the last lines of the log, or follows it across rotation.
- `run` is internal: the foreground runner that `start` launches.

bosun takes no lock. Two starts of one name at the same moment can launch two
servers; one checkout has one agent, so that does not arise.

## The endpoint contract

bosun gives the command `BOSUN_ENDPOINT`, a file path. Once the command knows
where it listens, it writes `{"port": <n>, "url": "<optional public url>"}`
there. bosun counts the server as running once that port answers any HTTP
request. For a Shopify app, the web command can write it from the variables
Shopify CLI hands it:

```sh
printf '{"port":%s,"url":"%s"}' "$BACKEND_PORT" "$APP_URL" > "$BOSUN_ENDPOINT"
```

## Status JSON

```json
{
  "bosun": 1,
  "name": "dev",
  "state": "running",
  "run": "9df4baf3",
  "pid": 43986,
  "group": 44007,
  "startedAt": "2026-11-03T14:56:35.734Z",
  "port": 50713,
  "url": "https://example.trycloudflare.com",
  "log": ".logs/dev/current"
}
```

`state` is `running`, `starting`, `stopped` or `orphaned`. An orphaned server's
runner died while its command lives on; `stop` ends it and `start` replaces it.
The fields other than `bosun`, `name`, `state` and `log` are null when stopped.
A typed failure prints `{ "bosun": 1, "error": { "_tag", "message" } }` and
exits 1. Version 1 only grows.

## Files

| Path                          | Written by | Holds                                               |
| ----------------------------- | ---------- | --------------------------------------------------- |
| `.state/<name>.json`          | the runner | Its pid, the command's process group, the run id.   |
| `.state/<name>.endpoint.json` | the server | Its port and URL.                                   |
| `.logs/<name>/current`        | `s6-log`   | The server's output between start and exit markers. |

Each file has one writer. The runner removes its record and the endpoint when
the command exits. The log rotates at 5 MiB, 20 files, 100 MiB in all, and each
line starts with a timestamp.

## Processes

The runner, the command and `s6-log` each lead their own process group. A stop
signals the command's group alone, so the runner and the logger outlive it,
drain its last output and write `==== <name> exit run=<id> code=<n>`. When the
command exits, the runner also ends anything left in its group, since a
straggler would hold the logger's pipe open.
