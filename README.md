# Pixel Art Lab

A local web app for testing **any** OpenRouter model at agentic pixel art creation.

It drives [`pixel-mcp`](https://github.com/willibrandon/pixel-mcp) — an MCP server that scripts a real
Aseprite install — through a tool-calling loop, so the model draws, renders a preview, *looks at it*,
and fixes what's wrong. Same loop as the Claude Code workflow it replaces, but model-agnostic.

## Requirements

- Node 20+
- Aseprite, and the `pixel-mcp` binary built and configured
  (`~/.config/pixel-mcp/config.json` pointing at your Aseprite executable)
- `OPENROUTER_API_KEY` in the environment

Check the MCP server is healthy first:

```sh
/home/nitechno/Apps/pixel-mcp/bin/pixel-mcp --health
```

## Setup

```sh
npm install
npm run dev        # server on :8787, web on :5273
```

Open http://localhost:5273.

## Configuration

Environment variables (all optional except the key):

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | **Required.** Stays server-side; never sent to the browser. |
| `PIXEL_MCP_BIN` | `~/Apps/pixel-mcp/bin/pixel-mcp` | Path to the MCP server binary |
| `PORT` | `8787` | Backend port |
| `RUNS_DIR` | `./runs` | Where run workspaces are written |
| `GALLERY_DIR` | `./gallery` | Where saved benchmark results are kept |

## How it works

Each run gets an isolated workspace at `runs/<runId>/` containing `sprites/`, `exports/`,
`reference/`, and `tmp/`. Every path the model emits is rewritten to stay inside it.

The model sees the `pixel-mcp` tools plus two synthetic ones implemented by this server:

- **`new_sprite`** — creates a canvas and saves it to `sprites/<name>.aseprite` in one step,
  hiding `create_canvas`'s "always writes to a temp path" quirk.
- **`render_preview`** — copies the sprite, scales the copy up with nearest-neighbour, exports a PNG,
  and injects it into the conversation as an image. This is the verify loop.

Preview images are pruned from history as the run goes on (the 3 most recent are kept in full) so a
long run doesn't exhaust the context window.

A run ends when the model says it is finished, or at whichever budget it reaches first:

- **Max turns** — model round-trips, however many tool calls each contains. Defaults to 40.
- **Max iterations** — `render_preview` calls, i.e. how many times the model gets to look at its own
  work and fix it. Blank means no cap.
- **Max cost** — dollars spent, checked between turns. Blank means no cap.

## The benchmark gallery

**Save to gallery** on a finished run — or **Save this frame** under any preview — copies that image
out of the run and into `gallery/`, along with the sprite, the brief, and what the run cost.

The **Gallery** tab groups saves by their brief, because the brief *is* the benchmark: run the same
words on a second model and both attempts land in the same group. **Run again** loads a saved brief
back into the form with its canvas and budget intact but the model left alone, so the next answer is
comparable. **Compare** puts the images side by side over a table of cost, turns, iterations, tool
calls, wall clock and tokens, marking whichever entries tie for best on each.

A saved entry is a full copy, so it survives `pruneOldRuns` deleting the workspace it came from.

## Layout

```
server/src/
  mcp/       stdio client, tool curation, path sandbox, synthetic tools
  openrouter/ model catalogue + streaming chat/completions client
  agent/     the loop, system prompt, history management
  gallery.ts saved results: copy out, summarise the run, list/label/delete
web/src/     React UI
runs/        per-run workspaces (gitignored)
gallery/     saved benchmark results (gitignored)
```
