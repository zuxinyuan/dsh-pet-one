/**
 * DSH home resolution — mirrors the convention used by the official plugins:
 * `$DSH_HOME` wins, `~/.dsh` is the fallback. All pet-one state lives under
 * `<dshHome>/pet-one/`.
 * @module dsh-pet-one/host/home
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Expand a leading `~` in a configured path. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** Resolve the DSH home directory from an environment object. */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env?.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/** Directory holding this plugin's durable state. */
export function petOneDir(env = process.env) {
  return join(resolveDshHome(env), 'pet-one')
}
