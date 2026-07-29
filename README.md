# Pixel Art Lab

A local web app for making pixel art in Aseprite using LLMs.

It works by using [`pixel-mcp`](https://github.com/willibrandon/pixel-mcp) to let the model interact with Aseprite
through a tool-calling loop — the model draws, renders a preview, looks at it, and iteratively fixes the issues.

OpenRouter is currently the only supported provider.

## Requirements

- Node 20+
- [`Aseprite`](https://github.com/aseprite/aseprite) 1.3.10+
- [`pixel-mcp`](https://github.com/willibrandon/pixel-mcp)
  - Go 1.23+ (required by pixel-mcp)

Aseprite and pixel-mcp must be built and configured.

Check the MCP server is healthy first:

```sh
./pixel-mcp/bin/pixel-mcp --health
```

## Setup

```sh
cp .env.example .env
```

Set OPENROUTER_API_KEY and PIXEL_MCP_BIN (if location differs) in .env file.

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
| `PIXEL_MCP_BIN` | `./pixel-mcp/bin/pixel-mcp` | Path to the MCP server binary |
| `PORT` | `8787` | Backend port |
| `RUNS_DIR` | `./runs` | Where run workspaces are written |
| `GALLERY_DIR` | `./gallery` | Where saved benchmark results are kept |

## How it works

Each run gets an isolated workspace at `runs/<runId>/` containing `sprites/`, `exports/`,
`reference/`, and `tmp/`. Every path the model emits is rewritten to stay inside it.

The model sees the `pixel-mcp` tools plus four custom ones implemented by this server:

- **`new_sprite`** — creates a canvas and saves it to `sprites/<name>.aseprite` in one step.
- **`render_preview`** — copies the sprite, upscales it, exports a PNG,
  and injects it into the conversation as an image.
- **`undo`** — every preview is a restore point, so a model that makes the piece worse can revert to
  the state it last looked at instead of painting over the mistake.
- **`draw_pixels`** — wraps pixel-mcp's tool of the same name, which silently clips pixels to the
  layer's cel bounds. The wrapper temporarily pins the cel to span the whole canvas so the
  coordinates mean what every other drawing tool means.

Preview images are pruned from history as the run goes on (the 3 most recent are kept in full) so a
long run doesn't exhaust the context window.

A run ends when the model says it is finished, or at whichever budget it reaches first:

- **Max turns** — The number of API calls the model makes. Defaults to 40.
- **Max iterations** — The number of times the model looks at its own work and fixes it. Defaults to no cap.
- **Max cost** — The maximum amount to spend, in dollars. Defaults to no cap.

Only the 40 most recent runs are kept. Does not affect gallery images, as those are saved elsewhere.

## The gallery

The **Gallery** tab shows all final results, grouped by prompt. Models with the same prompt are grouped
together. Selecting multiple results lets you compare their images and metadata. Results are automatically
saved to the gallery and live in the `gallery/` folder.

A saved entry is a full copy, so it survives `pruneOldRuns` deleting the workspace it came from.

## Project layout

```
server/src/
  mcp/        stdio, tool use, sandboxing
  openrouter/ OpenRouter API streaming
  agent/      main loop, system prompt, history management
  gallery.ts  saved results, download, compare
web/src/      React UI
runs/         per-run workspaces (gitignored)
gallery/      saved results (gitignored)
```

## Known issues

- I've only tested on Fedora Linux using the Github version of Aseprite
