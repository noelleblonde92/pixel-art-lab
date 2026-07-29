import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PathViolation, resolvePath, sandboxArgs, isInside, toWorkspaceRelative } from './paths.js'

let runDir: string
let outsideDir: string

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pal-paths-'))
  runDir = path.join(base, 'run')
  outsideDir = path.join(base, 'outside')
  await fs.mkdir(path.join(runDir, 'sprites'), { recursive: true })
  await fs.mkdir(path.join(runDir, 'exports'), { recursive: true })
  await fs.mkdir(outsideDir, { recursive: true })
  await fs.writeFile(path.join(outsideDir, 'secret.png'), 'x')
})

afterAll(async () => {
  await fs.rm(path.dirname(runDir), { recursive: true, force: true })
})

describe('resolvePath', () => {
  it('resolves a relative sprite path inside the run', async () => {
    const out = await resolvePath('sprite_path', 'sprites/knight.aseprite', runDir)
    expect(out).toBe(path.join(runDir, 'sprites/knight.aseprite'))
  })

  it('rejects traversal out of the workspace', async () => {
    await expect(
      resolvePath('sprite_path', '../../etc/evil.aseprite', runDir),
    ).rejects.toBeInstanceOf(PathViolation)
  })

  it('rejects traversal hidden mid-path', async () => {
    await expect(
      resolvePath('sprite_path', 'sprites/../../../evil.aseprite', runDir),
    ).rejects.toBeInstanceOf(PathViolation)
  })

  it('re-homes an absolute path from outside into the workspace', async () => {
    const out = await resolvePath('sprite_path', '/home/someone/art/knight.aseprite', runDir)
    expect(out).toBe(path.join(runDir, 'sprites/knight.aseprite'))
  })

  it('keeps an absolute path that is already inside the workspace', async () => {
    const inside = path.join(runDir, 'sprites/ok.aseprite')
    expect(await resolvePath('sprite_path', inside, runDir)).toBe(inside)
  })

  it('rejects a sprite path that is not .aseprite', async () => {
    await expect(resolvePath('sprite_path', 'sprites/knight.png', runDir)).rejects.toBeInstanceOf(
      PathViolation,
    )
  })

  it('rejects a non-image write target', async () => {
    await expect(resolvePath('output_path', 'exports/payload.sh', runDir)).rejects.toBeInstanceOf(
      PathViolation,
    )
  })

  it('allows .aseprite through output_path, which is how save_as works', async () => {
    const out = await resolvePath('output_path', 'sprites/copy.aseprite', runDir)
    expect(out).toBe(path.join(runDir, 'sprites/copy.aseprite'))
  })

  it('rejects empty values', async () => {
    await expect(resolvePath('sprite_path', '', runDir)).rejects.toBeInstanceOf(PathViolation)
    await expect(resolvePath('sprite_path', 42, runDir)).rejects.toBeInstanceOf(PathViolation)
  })

  it('defeats a symlink pointing out of the workspace', async () => {
    const link = path.join(runDir, 'sprites', 'escape')
    await fs.symlink(outsideDir, link, 'dir').catch(() => {})
    await expect(
      resolvePath('sprite_path', 'sprites/escape/pwned.aseprite', runDir),
    ).rejects.toBeInstanceOf(PathViolation)
    await fs.rm(link, { force: true })
  })

  it('creates the parent directory for write targets', async () => {
    const out = await resolvePath('output_path', 'exports/nested/deep/frame.png', runDir)
    const stat = await fs.stat(path.dirname(out))
    expect(stat.isDirectory()).toBe(true)
  })

  it('leaves non-path arguments alone', async () => {
    expect(await resolvePath('layer_name', 'Layer 1', runDir)).toBe('Layer 1')
  })
})

describe('sandboxArgs', () => {
  it('rewrites only the path-typed arguments', async () => {
    const out = await sandboxArgs(
      { sprite_path: 'sprites/a.aseprite', layer_name: 'Layer 1', x: 3, color: '#ff0000' },
      runDir,
    )
    expect(out.sprite_path).toBe(path.join(runDir, 'sprites/a.aseprite'))
    expect(out).toMatchObject({ layer_name: 'Layer 1', x: 3, color: '#ff0000' })
  })
})

describe('isInside', () => {
  it('rejects the directory itself and anything above it', () => {
    expect(isInside(path.join(runDir, 'a.txt'), runDir)).toBe(true)
    expect(isInside(runDir, runDir)).toBe(false)
    expect(isInside(path.dirname(runDir), runDir)).toBe(false)
  })
})

describe('toWorkspaceRelative', () => {
  it('shortens workspace paths and leaves others alone', () => {
    expect(toWorkspaceRelative(path.join(runDir, 'sprites/a.aseprite'), runDir)).toBe(
      'sprites/a.aseprite',
    )
    expect(toWorkspaceRelative('sprites/a.aseprite', runDir)).toBe('sprites/a.aseprite')
    expect(toWorkspaceRelative('/etc/passwd', runDir)).toBe('/etc/passwd')
  })
})
