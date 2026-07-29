import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Which arguments carry filesystem paths, and how each may be used.
 *
 * Derived from the Go input structs in pixel-mcp/pkg/tools/*.go. Anything not listed here is passed
 * through untouched, so adding a tool with a new path parameter means adding it here too.
 */
export const PATH_PARAMS: Record<string, PathKind> = {
  sprite_path: 'sprite',
  output_path: 'write',
  image_path: 'read',
  reference_path: 'read',
  source_path: 'read',
}

export type PathKind = 'sprite' | 'read' | 'write'

const IMAGE_EXTS = new Set(['.png', '.gif', '.jpg', '.jpeg', '.bmp', '.webp'])

export class PathViolation extends Error {}

/** Thrown far enough up that it becomes a tool error the model can read, never a crashed run. */
function violation(message: string): never {
  throw new PathViolation(message)
}

/**
 * Resolve a model-supplied path into the run's workspace, or reject it.
 *
 * Models emit all sorts of things here: bare names, absolute paths from the system prompt's examples,
 * paths with `..`, and occasionally paths into the user's real home directory. Everything is forced
 * inside `runDir`. Rejections come back to the model as tool errors so it self-corrects.
 */
export async function resolvePath(param: string, raw: unknown, runDir: string): Promise<string> {
  const kind = PATH_PARAMS[param]
  if (!kind) return String(raw)

  if (typeof raw !== 'string' || raw.trim() === '') {
    violation(`${param} must be a non-empty string`)
  }

  let candidate = raw.trim()

  // An absolute path is only acceptable if it already points inside the workspace. Otherwise take
  // its basename and re-home it, which is nearly always what the model meant.
  if (path.isAbsolute(candidate)) {
    const abs = path.resolve(candidate)
    if (!isInside(abs, runDir)) {
      candidate = path.join(defaultSubdir(kind, abs), path.basename(abs))
    } else {
      candidate = path.relative(runDir, abs)
    }
  }

  const resolved = path.resolve(runDir, candidate)

  // path.resolve already collapses `..`, so a traversal shows up as an escape from runDir.
  if (!isInside(resolved, runDir)) {
    violation(
      `${param} must stay inside the run workspace. Use a relative path such as sprites/<name>.aseprite`,
    )
  }

  // Defeat symlink escapes: resolve the nearest existing ancestor and re-check.
  const realAncestor = await realpathOfNearestExisting(resolved)
  const realRunDir = await fs.realpath(runDir)
  if (!isInside(realAncestor, realRunDir) && realAncestor !== realRunDir) {
    violation(`${param} resolves outside the run workspace via a symlink`)
  }

  checkExtension(param, kind, resolved)

  if (kind === 'write' || kind === 'sprite') {
    await fs.mkdir(path.dirname(resolved), { recursive: true })
  }

  return resolved
}

function checkExtension(param: string, kind: PathKind, resolved: string): void {
  const ext = path.extname(resolved).toLowerCase()

  if (kind === 'sprite') {
    if (ext !== '.aseprite') {
      violation(`${param} must be a .aseprite file (got "${ext || 'no extension'}")`)
    }
    return
  }

  if (kind === 'write' && ext === '.aseprite') return // save_as writes .aseprite through output_path

  if ((kind === 'write' || kind === 'read') && !IMAGE_EXTS.has(ext)) {
    // export_spritesheet can emit a .json sidecar path; allow it rather than block a valid call.
    if (ext === '.json') return
    violation(
      `${param} must be an image file (${[...IMAGE_EXTS].join(', ')}) — got "${ext || 'no extension'}"`,
    )
  }
}

/** Where a re-homed absolute path lands, based on how the argument is used. */
function defaultSubdir(kind: PathKind, abs: string): string {
  if (kind === 'sprite') return 'sprites'
  if (kind === 'write') return 'exports'
  // A read of something that looks like a reference the user supplied should look there first.
  return abs.includes('reference') ? 'reference' : 'exports'
}

export function isInside(target: string, dir: string): boolean {
  const rel = path.relative(dir, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** realpath() fails on paths that don't exist yet, so walk up to the first ancestor that does. */
async function realpathOfNearestExisting(target: string): Promise<string> {
  let current = target
  const segments: string[] = []

  for (;;) {
    try {
      const real = await fs.realpath(current)
      return segments.length ? path.join(real, ...segments.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return target // hit the root without finding anything
      segments.push(path.basename(current))
      current = parent
    }
  }
}

/** Rewrite every path-typed argument in a tool call. */
export async function sandboxArgs(
  args: Record<string, unknown>,
  runDir: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...args }
  for (const key of Object.keys(args)) {
    if (key in PATH_PARAMS) {
      out[key] = await resolvePath(key, args[key], runDir)
    }
  }
  return out
}

/** Turn absolute workspace paths back into the relative form the model uses. */
export function toWorkspaceRelative(value: string, runDir: string): string {
  if (!path.isAbsolute(value)) return value
  const rel = path.relative(runDir, value)
  return rel.startsWith('..') ? value : rel
}
