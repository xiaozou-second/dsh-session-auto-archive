/**
 * Behavioural tests for the session auto-archive host half. They drive the
 * exported decision/archive functions and the plugin's own HTTP routes with a
 * fake context, so no harness boot is needed.
 *
 * Run: node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULTS,
  apply,
  archiveDue,
  collectDue,
  lastActivityOf,
  readOptions,
} from '../index.js'

const DAY_MS = 86_400_000

/** A live reference shaped like a Cordis volatile config field. */
function ref(value) {
  return {
    value,
    get() {
      return this.value
    },
    set(next) {
      this.value = next
    },
  }
}

/** Plain volatile refs for a full row config. */
function settings(overrides = {}) {
  const source = { ...DEFAULTS, ...overrides }
  const raw = {}
  for (const [key, value] of Object.entries(source)) {
    raw[key] = typeof value === 'boolean' ? ref(value) : ref(value)
  }
  return raw
}

/** A fake Cordis context with the two required services and the web server. */
function createHarness({ snapshots, archived = [], pinned = [], failures = {} }) {
  const archivedSet = new Set(archived)
  const pinnedSet = new Set(pinned)
  const archiveCalls = []
  const listeners = new Map()
  const disposers = []
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    sessionPersistence: {
      list: async () => snapshots,
    },
    workspaceRegistry: {
      get archivedSessionIds() {
        return [...archivedSet]
      },
      get pinnedSessionIds() {
        return [...pinnedSet]
      },
      async archiveSession(sessionId, options) {
        archiveCalls.push({ sessionId, options })
        const failure = failures[sessionId]
        if (failure !== undefined) {
          const error = new Error(failure)
          error.name = failure
          throw error
        }
        if (!archivedSet.has(sessionId)) archivedSet.add(sessionId)
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(listener), 1)
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get() {
      return undefined
    },
  }
  return {
    ctx,
    routes,
    archiveCalls,
    archivedSet,
    /** Fire one plugin lifecycle event, as the loader would. */
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    async dispose() {
      for (const disposer of disposers.splice(0)) await disposer()
    },
  }
}

/** Answer one handler route with `request` and capture the JSON response. */
async function call(harness, path, request) {
  const route = harness.routes.get(path)
  assert.ok(route, `route ${path} registered`)
  let status = 0
  let body = ''
  const response = {
    headers: {},
    writeHead(code, headers) {
      status = code
      this.headers = headers ?? {}
    },
    end(chunk) {
      body += chunk ?? ''
    },
  }
  await route.handler(request, response)
  return { status, body: body === '' ? undefined : JSON.parse(body) }
}

/** One stored-session snapshot over a real temporary log file. */
async function snapshot(dir, id, { ageMs, createdAt, origin, cwd = '/work/repo' }) {
  const path = join(dir, `${id}.jsonl.zstd`)
  await writeFile(path, '')
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
  return {
    header: {
      version: 4,
      id,
      createdAt: createdAt ?? Date.now() - ageMs,
      cwd,
      isSeeded: false,
      ...(origin === undefined ? {} : { origin }),
    },
    revision: 'unused',
    location: { kind: 'jsonl', path },
  }
}

test('reads every setting, including a plain object row config', () => {
  const options = readOptions(settings({ days: 7, intervalMinutes: 15, dryRun: true }))
  assert.equal(options.days, 7)
  assert.equal(options.intervalMinutes, 15)
  assert.equal(options.dryRun, true)
  assert.equal(options.enabled, true)
  assert.equal(options.skipPinned, true)
  assert.equal(options.includeSubagentSessions, false)

  const plain = readOptions({ days: 3.9, intervalMinutes: 0, enabled: 'yes', skipPinned: false })
  assert.equal(plain.days, 3)
  assert.equal(plain.intervalMinutes, DEFAULTS.intervalMinutes)
  assert.equal(plain.enabled, DEFAULTS.enabled)
  assert.equal(plain.skipPinned, false)

  const empty = readOptions(undefined)
  assert.equal(empty.days, DEFAULTS.days)
  assert.equal(empty.enabled, DEFAULTS.enabled)
})

test('judges activity from the log mtime and falls back to creation time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saa-'))
  try {
    const fresh = await snapshot(dir, 'fresh', { ageMs: 2 * DAY_MS })
    const activity = await lastActivityOf(fresh)
    assert.equal(activity.basis, 'log-mtime')
    assert.ok(Math.abs(activity.time - (Date.now() - 2 * DAY_MS)) < 60_000)

    const pending = {
      header: { id: 'pending', createdAt: Date.now() - 5 * DAY_MS },
      revision: 'unused',
    }
    const fallback = await lastActivityOf(pending)
    assert.equal(fallback.basis, 'created')
    assert.equal(fallback.time, pending.header.createdAt)

    const missing = {
      header: { id: 'missing', createdAt: 1234 },
      revision: 'unused',
      location: { kind: 'jsonl', path: join(dir, 'absent.jsonl.zstd') },
    }
    const missingActivity = await lastActivityOf(missing)
    assert.equal(missingActivity.basis, 'created')
    assert.equal(missingActivity.time, 1234)

    assert.equal(await lastActivityOf({}), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plans only idle, unarchived, unpinned, non-subagent sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saa-'))
  try {
    const snapshots = [
      await snapshot(dir, 'old-idle', { ageMs: 40 * DAY_MS }),
      await snapshot(dir, 'recent', { ageMs: 1 * DAY_MS }),
      await snapshot(dir, 'archived', { ageMs: 40 * DAY_MS }),
      await snapshot(dir, 'pinned', { ageMs: 40 * DAY_MS }),
      await snapshot(dir, 'child', { ageMs: 40 * DAY_MS, origin: 'subagent' }),
      await snapshot(dir, 'created-old-but-active', { ageMs: 2 * DAY_MS, createdAt: Date.now() - 90 * DAY_MS }),
    ]
    const harness = createHarness({
      snapshots,
      archived: ['archived'],
      pinned: ['pinned'],
    })
    const plan = await collectDue(harness.ctx, readOptions(settings({ days: 30 })))
    assert.equal(plan.scanned, 6)
    assert.deepEqual(plan.due.map(entry => entry.sessionId), ['old-idle'])
    assert.equal(plan.skippedArchived, 1)
    assert.equal(plan.skippedPinned, 1)
    assert.equal(plan.skippedSubagent, 1)
    assert.equal(plan.skippedRecent, 2)
    assert.equal(plan.unknownActivity, 0)

    const withChildren = await collectDue(
      harness.ctx,
      readOptions(settings({ days: 30, includeSubagentSessions: true, skipPinned: false })),
    )
    assert.deepEqual(withChildren.due.map(entry => entry.sessionId).sort(), ['child', 'old-idle', 'pinned'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('archives oldest first, ignoring active and vanished sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saa-'))
  try {
    const snapshots = [
      await snapshot(dir, 'oldest', { ageMs: 60 * DAY_MS }),
      await snapshot(dir, 'older', { ageMs: 45 * DAY_MS }),
      await snapshot(dir, 'busy', { ageMs: 50 * DAY_MS }),
      await snapshot(dir, 'gone', { ageMs: 55 * DAY_MS }),
      await snapshot(dir, 'broken', { ageMs: 70 * DAY_MS }),
    ]
    const harness = createHarness({
      snapshots,
      failures: {
        busy: 'WorkspaceActiveSessionError',
        gone: 'WorkspaceUnknownSessionError',
        broken: 'disk full',
      },
    })
    const options = readOptions(settings({ days: 30 }))
    const plan = await collectDue(harness.ctx, options)
    const result = await archiveDue(harness.ctx, options, plan)
    assert.equal(result.matched, 5)
    assert.equal(result.archived, 2)
    assert.equal(result.skippedActive, 1)
    assert.equal(result.skippedMissing, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.errors[0], 'disk full')
    assert.deepEqual(harness.archiveCalls.map(call => call.sessionId), ['broken', 'oldest', 'gone', 'busy', 'older'])
    // The sweep never asks the registry to stop running work.
    for (const call of harness.archiveCalls) assert.deepEqual(call.options, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dry run archives nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saa-'))
  try {
    const snapshots = [await snapshot(dir, 'old', { ageMs: 40 * DAY_MS })]
    const harness = createHarness({ snapshots })
    const options = readOptions(settings({ days: 30, dryRun: true }))
    const plan = await collectDue(harness.ctx, options)
    const result = await archiveDue(harness.ctx, options, plan)
    assert.equal(result.matched, 1)
    assert.equal(result.archived, 0)
    assert.equal(result.dryRun, true)
    assert.equal(harness.archiveCalls.length, 0)
    assert.equal(harness.archivedSet.size, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('serves the status document and runs a sweep over POST', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saa-'))
  try {
    const snapshots = [
      await snapshot(dir, 'old', { ageMs: 40 * DAY_MS }),
      await snapshot(dir, 'recent', { ageMs: 1 * DAY_MS }),
    ]
    const harness = createHarness({ snapshots })
    await apply(harness.ctx, settings({ days: 30 }))

    const status = await call(harness, '/plugin-api/session-auto-archive/status', {
      method: 'GET',
      url: '/plugin-api/session-auto-archive/status?preview=1',
      headers: { host: '127.0.0.1:1' },
    })
    assert.equal(status.status, 200)
    assert.equal(status.body.plugin, 'session-auto-archive')
    assert.equal(status.body.config.days, 30)
    assert.equal(status.body.lastRun, null)
    assert.equal(typeof status.body.nextRunAt, 'string')
    assert.equal(status.body.preview.total, 1)
    assert.equal(status.body.preview.sessions[0].sessionId, 'old')

    const forbidden = await call(harness, '/plugin-api/session-auto-archive/run', {
      method: 'POST',
      url: '/plugin-api/session-auto-archive/run',
      headers: { host: '127.0.0.1:1', origin: 'https://evil.example' },
      resume() {},
    })
    assert.equal(forbidden.status, 403)

    const method = await call(harness, '/plugin-api/session-auto-archive/run', {
      method: 'GET',
      url: '/plugin-api/session-auto-archive/run',
      headers: { host: '127.0.0.1:1' },
    })
    assert.equal(method.status, 405)

    const run = await call(harness, '/plugin-api/session-auto-archive/run', {
      method: 'POST',
      url: '/plugin-api/session-auto-archive/run',
      headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', 'x-session-auto-archive': '1' },
      resume() {},
    })
    assert.equal(run.status, 200)
    assert.equal(run.body.run.archived, 1)
    assert.equal(run.body.run.reason, 'manual')
    assert.equal(run.body.status.archivedTotal, 1)
    assert.deepEqual([...harness.archivedSet], ['old'])

    const afterRun = await call(harness, '/plugin-api/session-auto-archive/status', {
      method: 'GET',
      url: '/plugin-api/session-auto-archive/status',
      headers: { host: '127.0.0.1:1' },
    })
    assert.equal(afterRun.body.lastRun.archived, 1)
    assert.equal(afterRun.body.preview, undefined)

    await harness.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a settings change re-reads the live values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saa-'))
  try {
    const snapshots = [await snapshot(dir, 'old', { ageMs: 10 * DAY_MS })]
    const harness = createHarness({ snapshots })
    const config = settings({ days: 30 })
    await apply(harness.ctx, config)

    const before = await collectDue(harness.ctx, readOptions(config))
    assert.equal(before.due.length, 0)

    config.days.set(7)
    harness.emit('loader/volatile-update', [['days']])
    const after = await collectDue(harness.ctx, readOptions(config))
    assert.equal(after.due.length, 1)

    const status = await call(harness, '/plugin-api/session-auto-archive/status', {
      method: 'GET',
      url: '/plugin-api/session-auto-archive/status',
      headers: { host: '127.0.0.1:1' },
    })
    assert.equal(status.body.config.days, 7)

    config.enabled.set(false)
    harness.emit('loader/volatile-update', [['enabled']])
    const disabled = await call(harness, '/plugin-api/session-auto-archive/status', {
      method: 'GET',
      url: '/plugin-api/session-auto-archive/status',
      headers: { host: '127.0.0.1:1' },
    })
    assert.equal(disabled.body.config.enabled, false)
    assert.equal(disabled.body.nextRunAt, null)

    await harness.dispose()
    assert.equal(harness.routes.has('/plugin-api/session-auto-archive/status'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a disposal mid-sweep stops the remaining archives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saa-'))
  try {
    const snapshots = [
      await snapshot(dir, 'first', { ageMs: 60 * DAY_MS }),
      await snapshot(dir, 'second', { ageMs: 50 * DAY_MS }),
      await snapshot(dir, 'third', { ageMs: 40 * DAY_MS }),
    ]
    const harness = createHarness({ snapshots })
    const options = readOptions(settings({ days: 30 }))
    const plan = await collectDue(harness.ctx, options)
    // The check runs before each archive, so the first one lands and the rest stop.
    const result = await archiveDue(harness.ctx, options, plan, Date.now(), () => harness.archiveCalls.length >= 1)
    assert.equal(result.archived, 1)
    assert.equal(result.matched, 3)
    assert.deepEqual(harness.archiveCalls.map(call => call.sessionId), ['first'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
