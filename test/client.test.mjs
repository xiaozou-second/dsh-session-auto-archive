/**
 * Wiring tests for the browser half. They execute the module-loader bundle with
 * stubbed `react` and primitives, then assert the slot registration, the
 * settings field specs, and the page's one-liner.
 *
 * Run: node --test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** The bundle registers itself once, when the module is first imported. */
let bundleEntry

/** Import the bundle with a capturing module loader. */
async function loadBundleEntry() {
  if (bundleEntry === undefined) {
    globalThis.window = {
      __ModuleLoader__: {
        load(descriptor) {
          bundleEntry = descriptor
        },
      },
    }
    await import('../client.js')
  }
  return bundleEntry
}

/** Load the client bundle with a stubbed module loader and return its exports. */
async function loadClient() {
  const entry = await loadBundleEntry()
  const models = []
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    Fragment: 'Fragment',
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useSyncExternalStore: () => ({}),
  }

  class SettingsFormModel {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = specs
      models.push(this)
    }

    bind(projection) {
      this.projection = projection
      return {
        getSnapshot: () => this.projection(),
        subscribe: () => () => {},
      }
    }

    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }

    field(name) {
      const spec = this.specs.find(item => item.field === name)
      const value = this.scope.getSnapshot().value?.[name]
      return { text: spec.format(value), overridden: false, invalid: false }
    }

    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} }
    }

    dispose() {}
  }

  const primitives = {
    SettingsForm: () => null,
    SettingsValueField: () => null,
    Switch: () => null,
    Button: () => null,
    SettingsFormModel,
    settingsNumberField: field => ({
      field,
      format: value => (typeof value === 'number' ? String(value) : ''),
      parse: text => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        const number = Number(trimmed)
        return Number.isFinite(number) ? { kind: 'set', value: number } : undefined
      },
    }),
  }

  const stubs = {
    react,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }

  assert.ok(entry !== undefined, 'bundle registered itself')
  assert.equal(entry.id, '@xiaozou-wine/session-auto-archive')
  const exports = entry.factory(id => {
    const stub = stubs[id]
    if (stub === undefined) throw new Error(`unexpected require(${id})`)
    return stub
  })
  return { exports, models }
}

/** A browser plugin context with the three services the page injects. */
function createContext() {
  const registrations = []
  const served = []
  const dictionaries = []
  const value = { enabled: true, days: 30, intervalMinutes: 60, dryRun: false, skipPinned: true, includeSubagentSessions: false }
  const ctx = {
    effect(callback) {
      callback()
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    locale: {
      register(namespace, dictionary) {
        dictionaries.push({ namespace, dictionary })
        return () => {}
      },
      bind(namespace) {
        return key => `${namespace}:${key}`
      },
    },
    configForms: {
      get(namespace) {
        return {
          namespace,
          getSnapshot: () => ({ status: 'ready', value, revision: 1, writable: true }),
          subscribe: () => () => {},
          mutate: async () => true,
          set: async () => true,
          unset: async () => true,
        }
      },
      whileServed(namespaces, register) {
        served.push({ namespaces: [...namespaces], register })
        const dispose = register(new Set(namespaces))
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
    },
    slots: {
      inject(_name, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, served, dictionaries, value }
}

test('registers the row configuration page under the bundle and row ids', async () => {
  const { exports } = await loadClient()
  const harness = createContext()
  exports.apply(harness.ctx)

  assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms'])
  assert.deepEqual(harness.served.map(item => item.namespaces), [['session-auto-archive']])
  assert.equal(harness.registrations.length, 1)
  const [registration] = harness.registrations
  assert.equal(registration.options.name, 'plugins.row.config')
  assert.equal(registration.options.key, '@xiaozou-wine/session-auto-archive#session-auto-archive')
  assert.equal(registration.options.locale, 'settings.sessionAutoArchive')

  const dictionary = harness.dictionaries.find(item => item.namespace === 'settings.sessionAutoArchive')
  assert.ok(dictionary !== undefined, 'page dictionary registered')
  assert.equal(typeof dictionary.dictionary.en.days, 'string')
  assert.equal(typeof dictionary.dictionary.zh.days, 'string')
  for (const key of Object.keys(dictionary.dictionary.en)) {
    assert.equal(typeof dictionary.dictionary.zh[key], 'string', `zh copy for ${key}`)
  }
})

test('stages every setting as one form, including the switches', async () => {
  const { exports, models } = await loadClient()
  const harness = createContext()
  exports.apply(harness.ctx)

  assert.equal(models.length, 1)
  const model = models[0]
  assert.deepEqual(model.specs.map(spec => spec.field), [
    'enabled',
    'days',
    'intervalMinutes',
    'dryRun',
    'skipPinned',
    'includeSubagentSessions',
  ])

  const enabled = model.specs.find(spec => spec.field === 'enabled')
  assert.equal(enabled.format(true), 'on')
  assert.equal(enabled.format(false), 'off')
  assert.deepEqual(enabled.parse('on'), { kind: 'set', value: true })
  assert.deepEqual(enabled.parse('off'), { kind: 'set', value: false })

  const days = model.specs.find(spec => spec.field === 'days')
  assert.equal(days.format(7), '7')
  assert.deepEqual(days.parse('7'), { kind: 'set', value: 7 })
  assert.deepEqual(days.parse(''), { kind: 'clear' })
  assert.equal(days.parse('seven'), undefined)

  // The bound projection carries the shell state plus every field.
  const projection = model.projection()
  assert.equal(projection.available, true)
  assert.equal(projection.days.text, '30')
  assert.equal(projection.enabled.text, 'on')
  assert.equal(projection.includeSubagentSessions.text, 'off')
})

test('renders the one-liner before the page opens', async () => {
  const { exports } = await loadClient()
  const harness = createContext()
  exports.apply(harness.ctx)
  const registration = harness.registrations[0]
  const inject = registration.options.inject()

  const summary = registration.component({
    ...inject,
    view: 'summary',
    t: key => `copy:${key}`,
  })
  assert.equal(summary, 'copy:summary')

  // The slot-supplied `t` wins; the injected reader is the fallback.
  const fallback = registration.component({
    ...inject,
    view: 'summary',
  })
  assert.equal(fallback, 'settings.sessionAutoArchive:summary')
})
