import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const home = homedir()

// Anchored to this file rather than cwd, so runs land in the project root whether the server is
// started from the repo root, from server/, or from the built dist/.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

export const config = {
  port: Number(process.env.PORT ?? 8787),

  openRouterKey: process.env.OPENROUTER_API_KEY ?? '',
  openRouterBase: 'https://openrouter.ai/api/v1',

  /** The pixel-mcp binary. Spawned once per run and spoken to over stdio. */
  mcpBin: process.env.PIXEL_MCP_BIN ?? path.join(home, 'Apps/pixel-mcp/bin/pixel-mcp'),

  runsDir: path.resolve(process.env.RUNS_DIR ?? path.join(projectRoot, 'runs')),

  /**
   * Saved benchmark results. Deliberately not under `runsDir`: a run workspace is disposable and
   * `pruneOldRuns` will delete it, so anything worth keeping is *copied* out to here.
   */
  galleryDir: path.resolve(process.env.GALLERY_DIR ?? path.join(projectRoot, 'gallery')),

  /**
   * How many run workspaces `pruneOldRuns` keeps, newest first. Every start prunes, and the settings
   * pane can ask for it by hand; a saved gallery entry is a copy, so it is unaffected either way.
   */
  runsKept: 40,

  /** Blank "max turns" in the form lands here. One turn is one model round-trip. */
  defaultMaxTurns: 40,
  /** Nothing may exceed this, whatever the form says. */
  turnCeiling: 100,

  /**
   * Ceilings for the two optional budgets. Unlike `turnCeiling` these only clamp a value the form
   * actually asked for — blank means no cap of that kind, and the turn ceiling still bounds the run.
   * One iteration is one `render_preview`, so it is a coarser unit than a turn and its ceiling can
   * afford to be lower.
   */
  iterationCeiling: 50,
  costCeilingUsd: 100,

  /** Independent guard against a model that calls tools forever without advancing turns. */
  toolCallCeiling: 400,

  /**
   * Consecutive empty responses that end a run. A lone blank turn is usually transient, so the
   * streak resets on any turn that carries something and only an endpoint that has genuinely
   * stopped answering trips this — blanks scattered across a long run do not.
   */
  emptyResponseLimit: 6,
  /**
   * How long to wait before each empty-response retry, backing off because an immediate re-ask
   * tends to hit whatever transient state produced the blank. Indexed by the streak so far and
   * clamped to the last entry, so raising `emptyResponseLimit` cannot run off the end.
   */
  emptyResponseDelaysMs: [1_000, 5_000, 10_000],

  /** Previews are scaled so the long edge lands near this, which keeps image tokens predictable. */
  previewTargetPx: 512,
  previewMaxScale: 16,

  /** How many preview images stay in context at full fidelity before older ones become text. */
  keptPreviews: 3,
  /** Above this share of the model's context window, keep fewer previews. */
  contextPressureThreshold: 0.6,

  /**
   * Send cache breakpoints to providers that only cache where they are told to.
   *
   * A hundred-round-trip run resends an ever-growing prompt, so this is most of the input bill for
   * an Anthropic or Alibaba model. Set `PAL_PROMPT_CACHE=0` to measure the uncached baseline —
   * without it the two are not comparable, which matters here because cost is a benchmark axis.
   */
  promptCaching: process.env.PAL_PROMPT_CACHE !== '0',

  /** Per-call wall clock for MCP. The server's own Aseprite timeout is 30s. */
  toolTimeoutMs: 60_000,

  /** Reference uploads are re-encoded down to this long edge before being sent to the model. */
  referenceMaxPx: 1024,
  maxReferenceBytes: 12 * 1024 * 1024,
} as const

export function assertConfigured(): void {
  if (!config.openRouterKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Export it before starting the server — it is read server-side only.',
    )
  }
}
