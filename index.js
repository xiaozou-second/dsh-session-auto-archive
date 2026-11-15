/**
 * @module @xiaozou-wine/session-auto-archive
 *
 * Hides idle sessions by archiving them: one periodic sweep lists the stored
 * sessions, works out when each session's log was last written, and moves the
 * ones that have been quiet for longer than the configured number of days into
 * the registry-global archive set. Archiving is reversible from the Web
 * session list and never deletes session data.
 *
 * The threshold and the check cadence are ordinary volatile plugin settings, so
 * the Web Settings page edits them live through the profile patch. A small JSON
 * route reports the sweep state and lets the same page run a sweep on demand.
 *
 * No runtime dependency outside `node:` builtins and the host's own
 * `@deepseek-ai/schemastery` (resolved from the running harness, only to declare
 * the settings schema).
 */

import { stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const name = 'session-auto-archive'

/** Required services: the stored session list and the archive set. */
export const inject = ['sessionPersistence', 'workspaceRegistry']

/** Bump on behaviour changes that alter the status payload. */
const VERSION = '0.1.0'

/** One day in milliseconds. */
const DAY_MS = 86_400_000

/** Sessions archived by one sweep before the next sweep continues the work. */
const MAX_ARCHIVE_PER_SWEEP = 200

/** Sessions listed by the status preview. */
const MAX_PREVIEW = 50

/** Sweep failures reported in one result. */
const MAX_ERRORS = 5

/** Delay before the first automatic sweep, so startup work settles first. */
const FIRST_SWEEP_DELAY_MS = 20_000

/** Route prefix shared with the browser page. */
const ROUTE_PREFIX = '/plugin-api/session-auto-archive'

/** Header the browser page sends with a manual sweep request. */
const RUN_HEADER = 'x-session-auto-archive'

const DEFAULTS = {
  enabled: true,
  days: 30,
  intervalMinutes: 60,
  dryRun: false,
  skipPinned: true,
  includeSubagentSessions: false,
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A whole number within `[min, max]`, or the fallback. */
function boundedInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  return rounded >= min && rounded <= max ? rounded : fallback
}

/**
 * Read one setting from the plugin row config. Cordis turns a volatile field
 * into a live reference object, so read both that and a plain configured value.
 * @param raw - the row config object.
 * @param key - the field name.
 * @param fallback - value used when the field carries no usable value.
 * @param coerce - narrows a raw value to the accepted shape.
 * @returns the resolved setting.
 */
function settingOf(raw, key, fallback, coerce) {
  const field = isPlainObject(raw) ? raw[key] : undefined
  const value = field !== null && typeof field === 'object' && typeof field.get === 'function'
    ? field.get()
    : field
  const resolved = coerce(value, fallback)
  return resolved === undefined ? fallback : resolved
}

/**
 * Normalize the row config into the shape every later decision reads.
 * @param raw - the `session-auto-archive` row config.
 * @returns the resolved settings.
 */
export function readOptions(raw) {
  return {
    enabled: settingOf(raw, 'enabled', DEFAULTS.enabled, (value, fallback) => typeof value === 'boolean' ? value : fallback),
    days: settingOf(raw, 'days', DEFAULTS.days, (value, fallback) => boundedInteger(value, fallback, 1, 3650)),
    intervalMinutes: settingOf(raw, 'intervalMinutes', DEFAULTS.intervalMinutes, (value, fallback) => boundedInteger(value, fallback, 1, 10080)),
    dryRun: settingOf(raw, 'dryRun', DEFAULTS.dryRun, (value, fallback) => typeof value === 'boolean' ? value : fallback),
    skipPinned: settingOf(raw, 'skipPinned', DEFAULTS.skipPinned, (value, fallback) => typeof value === 'boolean' ? value : fallback),
    includeSubagentSessions: settingOf(raw, 'includeSubagentSessions', DEFAULTS.includeSubagentSessions, (value, fallback) => typeof value === 'boolean' ? value : fallback),
  }
}

/**
 * Load the running harness's own `@deepseek-ai/schemastery`, so the settings
 * service recognises the schema instead of rejecting a foreign copy. The
 * harness entry (`process.argv[1]`) resolves the installed host packages; a
 * source checkout started from a workspace directory resolves through the
 * working directory, and a package with its own dependency through itself.
 * @returns the schema builder, or undefined when it cannot be resolved.
 */
export function loadSchemastery() {
  const anchors = []
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    anchors.push(entry)
    // The CLI is usually a symlink (`bin/dsh`), and Node resolves a required
    // package from the anchor's own directory, not from its target.
    try {
      anchors.push(realpathSync(entry))
    } catch {
      // A vanished entry is no anchor.
    }
  }
  try {
    anchors.push(pathToFileURL(join(process.cwd(), 'package.json')).href)
  } catch {
    // An unreadable working directory is no anchor.
  }
  anchors.push(import.meta.url)
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const resolved = require.resolve('@deepseek-ai/schemastery')
      const builder = require(resolved)
      if (builder !== null && typeof builder.object === 'function') return builder
    } catch {
      // Try the next anchor.
    }
  }
  return undefined
}

/**
 * Build the plugin's settings schema. Exported so tests can validate the shape
 * against the host's own schema builder.
 * @param z - the schemastery builder (`Schema`).
 * @returns the row config schema; every field is live-editable.
 */
export function createConfig(z) {
  return z.object({
    enabled: z.boolean()
      .default(DEFAULTS.enabled)
      .description('Whether the automatic sweep runs. Turning it off keeps the status page and the manual check available.')
      .volatile(),
    days: z.number()
      .step(1)
      .min(1)
      .max(3650)
      .default(DEFAULTS.days)
      .description('Archive a session once its stored log has not been written for this many days.')
      .volatile(),
    intervalMinutes: z.number()
      .step(1)
      .min(1)
      .max(10080)
      .default(DEFAULTS.intervalMinutes)
      .description('Minutes between two automatic sweeps.')
      .volatile(),
    dryRun: z.boolean()
      .default(DEFAULTS.dryRun)
      .description('Report which sessions would be archived without archiving them.')
      .volatile(),
    skipPinned: z.boolean()
      .default(DEFAULTS.skipPinned)
      .description('Leave pinned sessions unarchived; archiving a pinned session would drop its pin.')
      .volatile(),
    includeSubagentSessions: z.boolean()
      .default(DEFAULTS.includeSubagentSessions)
      .description('Also archive subagent child sessions, which the conversation list does not show.')
      .volatile(),
  })
}

const z = loadSchemastery()

/** Whether the settings schema could be built; reported by the status route. */
export const schemaAvailable = z !== undefined

/** Row config schema; absent only when the host's schema builder is unreachable. */
export const Config = z === undefined ? undefined : createConfig(z)

/** Sorted session ids from a registry set. */
function idSet(ids) {
  const set = new Set()
  if (!Array.isArray(ids)) return set
  for (const id of ids) if (typeof id === 'string' && id.length > 0) set.add(id)
  return set
}

/** Yield to the event loop so a long sweep never starves the host. */
function yieldToLoop() {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * When a stored session last changed, judged from the physical artifact.
 *
 * The shipped JSONL backend writes every accepted batch straight to the
 * session's compressed log, so the file modification time is a faithful "last
 * activity" that costs one `stat` instead of replaying the log. A snapshot
 * without a JSONL artifact (an unmaterialized new session, or another backend)
 * falls back to the header's creation time, and the creation time also floors
 * the result so a copied artifact cannot look older than the session.
 *
 * @param snapshot - one `sessionPersistence.list()` observation.
 * @returns the activity instant and its basis, or undefined when unknown.
 */
export async function lastActivityOf(snapshot) {
  const header = isPlainObject(snapshot) ? snapshot.header : undefined
  if (!isPlainObject(header) || typeof header.id !== 'string') return undefined
  const createdAt = typeof header.createdAt === 'number' && Number.isFinite(header.createdAt)
    ? header.createdAt
    : 0
  const location = snapshot.location
  if (isPlainObject(location) && location.kind === 'jsonl' && typeof location.path === 'string') {
    try {
      const info = await stat(location.path)
      if (typeof info.mtimeMs === 'number' && Number.isFinite(info.mtimeMs)) {
        return { time: Math.max(info.mtimeMs, createdAt), basis: 'log-mtime' }
      }
    } catch (error) {
      // A session whose artifact disappeared between listing and inspection is
      // not a candidate; the next sweep re-lists it.
      if (error?.code !== 'ENOENT') return undefined
    }
  }
  if (createdAt > 0) return { time: createdAt, basis: 'created' }
  return undefined
}

/**
 * Decide which stored sessions the sweep should archive.
 * @param ctx - Host context carrying persistence and the workspace registry.
 * @param options - resolved settings.
 * @param now - reference instant in epoch milliseconds.
 * @returns the plan, with counts explaining every skipped family.
 */
export async function collectDue(ctx, options, now = Date.now()) {
  const persistence = ctx.sessionPersistence
  const registry = ctx.workspaceRegistry
  const snapshots = await persistence.list()
  const archived = idSet(registry.archivedSessionIds)
  const pinned = idSet(registry.pinnedSessionIds)
  const cutoff = now - options.days * DAY_MS
  const due = []
  const plan = {
    now,
    cutoff,
    scanned: 0,
    due,
    skippedArchived: 0,
    skippedPinned: 0,
    skippedSubagent: 0,
    skippedRecent: 0,
    unknownActivity: 0,
  }
  for (const snapshot of snapshots) {
    plan.scanned += 1
    if (plan.scanned % 50 === 0) await yieldToLoop()
    const header = isPlainObject(snapshot) ? snapshot.header : undefined
    if (!isPlainObject(header) || typeof header.id !== 'string') continue
    if (archived.has(header.id)) {
      plan.skippedArchived += 1
      continue
    }
    if (options.skipPinned && pinned.has(header.id)) {
      plan.skippedPinned += 1
      continue
    }
    if (!options.includeSubagentSessions && header.origin === 'subagent') {
      plan.skippedSubagent += 1
      continue
    }
    const activity = await lastActivityOf(snapshot)
    if (activity === undefined) {
      plan.unknownActivity += 1
      continue
    }
    if (activity.time >= cutoff) {
      plan.skippedRecent += 1
      continue
    }
    due.push({
      sessionId: header.id,
      lastActivityAt: activity.time,
      basis: activity.basis,
      createdAt: header.createdAt,
      cwd: header.cwd,
      agentPreset: header.agentPreset,
    })
  }
  due.sort((left, right) => left.lastActivityAt - right.lastActivityAt)
  return plan
}

/** Classify an archive failure without importing the registry's error classes. */
function errorKind(error) {
  const errorName = isPlainObject(error) || error instanceof Error ? error.name : undefined
  if (errorName === 'WorkspaceActiveSessionError') return 'active'
  if (errorName === 'WorkspaceUnknownSessionError') return 'missing'
  return 'other'
}

/** A short, safe failure line for the status payload. */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 197)}...` : message
}

/**
 * Archive every due session, oldest first, up to the per-sweep cap.
 * @param ctx - Host context carrying the workspace registry.
 * @param options - resolved settings.
 * @param plan - output of {@link collectDue}.
 * @param startedAt - sweep start in epoch milliseconds.
 * @param shouldStop - optional caller check, consulted before each archive, so
 *   unloading the plugin stops a batch already in flight.
 * @returns the run summary the status page renders.
 */
export async function archiveDue(ctx, options, plan, startedAt = Date.now(), shouldStop) {
  const targets = plan.due.slice(0, MAX_ARCHIVE_PER_SWEEP)
  const result = {
    at: new Date(startedAt).toISOString(),
    dryRun: options.dryRun,
    days: options.days,
    scanned: plan.scanned,
    matched: plan.due.length,
    archived: 0,
    skippedActive: 0,
    skippedMissing: 0,
    skippedPinned: plan.skippedPinned,
    skippedSubagent: plan.skippedSubagent,
    skippedArchived: plan.skippedArchived,
    unknownActivity: plan.unknownActivity,
    failed: 0,
    truncated: plan.due.length > targets.length,
    errors: [],
    durationMs: 0,
  }
  for (const target of targets) {
    if (options.dryRun) continue
    if (typeof shouldStop === 'function' && shouldStop() === true) break
    try {
      await ctx.workspaceRegistry.archiveSession(target.sessionId, {})
      result.archived += 1
    } catch (error) {
      const kind = errorKind(error)
      if (kind === 'active') result.skippedActive += 1
      else if (kind === 'missing') result.skippedMissing += 1
      else {
        result.failed += 1
        if (result.errors.length < MAX_ERRORS) result.errors.push(describeError(error))
      }
    }
    await yieldToLoop()
  }
  result.durationMs = Math.max(0, Date.now() - startedAt)
  return result
}

/** Answer one HTTP request with a JSON body. */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

/** Whether a request came from this page's own origin. */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = request.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read one query parameter from a request target. */
function searchParam(url, key) {
  try {
    return new URL(url, 'http://localhost').searchParams.get(key)
  } catch {
    return null
  }
}

/**
 * Report how the Settings service currently sees this plugin's entry: the same
 * descriptor the browser form binds to. Only this row's fields are copied out,
 * and secret values are never requested.
 * @param ctx - Host context, possibly without a Settings service.
 * @returns the settings face of the status document.
 */
export function settingsFace(ctx) {
  let forms
  try {
    forms = ctx.get('settings')
  } catch {
    return { available: false }
  }
  if (forms === undefined) return { available: false }
  try {
    const own = forms.describe({ redactSecrets: true }).find(row => row.ns === name)
    if (own === undefined) return { available: true, served: false, writable: forms.writable }
    return {
      available: true,
      served: true,
      writable: forms.writable === true,
      autoGenerate: own.autoGenerate === true,
      revision: own.revision,
      fields: isPlainObject(own.value) ? Object.keys(own.value) : [],
      value: own.value,
      user: own.user ?? null,
    }
  } catch (error) {
    return { available: true, served: false, error: describeError(error) }
  }
}

/**
 * Register the automatic sweep, its timers, and its status route.
 *
 * @param ctx - owning Host plugin context.
 * @param rawConfig - the `session-auto-archive` row config.
 */
export async function apply(ctx, rawConfig) {
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[${name}] ${message}`)
    } catch {
      // A logger failure never breaks a sweep.
    }
  }

  const state = {
    running: false,
    lastRun: null,
    nextRunAt: null,
    lastError: null,
  }
  let timer = null
  let inFlight = null
  let disposed = false

  /** The settings as they stand right now; volatile fields update in place. */
  const current = () => readOptions(rawConfig)

  /** Stop the pending automatic sweep. */
  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** Arm the next automatic sweep from the live settings. */
  function arm(delayMs) {
    clearTimer()
    if (disposed) return
    const options = current()
    if (!options.enabled) {
      state.nextRunAt = null
      return
    }
    const delay = typeof delayMs === 'number' && delayMs > 0 ? delayMs : options.intervalMinutes * 60_000
    state.nextRunAt = new Date(Date.now() + delay).toISOString()
    timer = setTimeout(() => {
      timer = null
      void sweep('schedule').finally(() => arm())
    }, delay)
    timer.unref?.()
  }

  /** Run one sweep, sharing an in-flight sweep with a concurrent caller. */
  function sweep(reason) {
    if (disposed) return Promise.resolve(null)
    if (inFlight !== null) return inFlight
    const startedAt = Date.now()
    state.running = true
    inFlight = (async () => {
      try {
        const options = current()
        const plan = await collectDue(ctx, options, startedAt)
        const result = await archiveDue(ctx, options, plan, startedAt, () => disposed)
        state.lastRun = { ...result, reason }
        state.lastError = null
        if (result.archived > 0) {
          log('info', `archived ${result.archived} of ${result.matched} idle sessions older than ${options.days} days`)
        } else if (result.failed > 0) {
          log('warn', `sweep finished with ${result.failed} failures: ${result.errors[0] ?? 'unknown error'}`)
        } else {
          log('debug', `sweep: ${result.matched} matching sessions, nothing archived`)
        }
        return state.lastRun
      } catch (error) {
        state.lastError = describeError(error)
        log('warn', `sweep failed: ${state.lastError}`)
        return null
      } finally {
        state.running = false
        inFlight = null
      }
    })()
    return inFlight
  }

  /** Build the status document the page polls. */
  async function status(preview) {
    const options = current()
    const registry = ctx.workspaceRegistry
    const payload = {
      plugin: name,
      version: VERSION,
      config: options,
      routing: { status: `${ROUTE_PREFIX}/status`, run: `${ROUTE_PREFIX}/run` },
      archivedTotal: Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds.length : 0,
      pinnedTotal: Array.isArray(registry?.pinnedSessionIds) ? registry.pinnedSessionIds.length : 0,
      running: state.running,
      lastRun: state.lastRun,
      lastError: state.lastError,
      nextRunAt: state.nextRunAt,
      schemaAvailable,
      settings: settingsFace(ctx),
    }
    if (preview === true) {
      try {
        const plan = await collectDue(ctx, options, Date.now())
        payload.preview = {
          cutoff: new Date(plan.cutoff).toISOString(),
          scanned: plan.scanned,
          total: plan.due.length,
          skippedPinned: plan.skippedPinned,
          skippedSubagent: plan.skippedSubagent,
          unknownActivity: plan.unknownActivity,
          sessions: plan.due.slice(0, MAX_PREVIEW).map(entry => ({
            sessionId: entry.sessionId,
            lastActivityAt: new Date(entry.lastActivityAt).toISOString(),
            basis: entry.basis,
            createdAt: new Date(entry.createdAt).toISOString(),
            cwd: entry.cwd ?? null,
          })),
          truncated: plan.due.length > MAX_PREVIEW,
        }
      } catch (error) {
        payload.previewError = describeError(error)
      }
    }
    return payload
  }

  // ── automatic cadence ─────────────────────────────────────────────────────
  arm(FIRST_SWEEP_DELAY_MS)
  log('debug', `auto-archive armed: first check in ${Math.round(FIRST_SWEEP_DELAY_MS / 1000)}s`)

  // A settings write never remounts the plugin; the loader mutates the volatile
  // references and announces the changed paths, so re-arm from the new values.
  ctx.on('loader/volatile-update', () => {
    if (disposed) return
    const options = current()
    arm(state.lastRun === null ? FIRST_SWEEP_DELAY_MS : undefined)
    log('debug', `settings changed: every ${options.intervalMinutes} min, threshold ${options.days} days, enabled=${String(options.enabled)}`)
  })

  // ── status route ──────────────────────────────────────────────────────────
  ctx.inject(['webServer'], child => {
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(response, 405, { error: 'method-not-allowed' })
            return
          }
          const preview = searchParam(request.url, 'preview') === '1'
          sendJson(response, 200, await status(preview))
        } catch (error) {
          sendJson(response, 500, { error: describeError(error) })
        }
      },
    }), `${name}: status route`)

    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/run`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'method-not-allowed' })
            return
          }
          request.resume()
          if (request.headers[RUN_HEADER] !== '1' || !sameOrigin(request)) {
            sendJson(response, 403, { error: 'forbidden' })
            return
          }
          const run = await sweep('manual')
          sendJson(response, 200, { run, status: await status(false) })
        } catch (error) {
          sendJson(response, 500, { error: describeError(error) })
        }
      },
    }), `${name}: manual check route`)
  })

  // ── disposal ──────────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    disposed = true
    clearTimer()
    state.nextRunAt = null
  }, `${name}: stop the archive cadence`)
}

export { name, DEFAULTS, MAX_ARCHIVE_PER_SWEEP, ROUTE_PREFIX }
