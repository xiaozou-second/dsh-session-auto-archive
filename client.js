/**
 * Browser half: the Settings page of the session auto-archive plugin.
 *
 * The page registers into the Plugins page's `plugins.row.config` slot for this
 * bundle's row, so the row gains a configure control whose page edits the live
 * volatile settings through the Host's config forms. A small status card reads
 * the Host plugin's JSON route, previews which sessions are due, and runs a
 * sweep on demand.
 */

window.__ModuleLoader__.load({
  id: '@xiaozou-wine/session-auto-archive',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Dictionary namespace owned by this page. */
    const NS = 'settings.sessionAutoArchive'

    /** Profile entry id the Host registers for this bundle's row. */
    const ENTRY_ID = 'session-auto-archive'

    /** Bundle package name; the row slot key prefixes it. */
    const PACKAGE_NAME = '@xiaozou-wine/session-auto-archive'

    /** Route prefix the Host plugin serves. */
    const API = '/plugin-api/session-auto-archive'

    /** Header the Host requires on a manual sweep request. */
    const RUN_HEADER = 'x-session-auto-archive'

    const en = {
      summary: 'Archive sessions that have been quiet for a configurable number of days.',
      intro: 'Sessions whose stored log has not changed for the number of days below are moved to the archive. Nothing is deleted — restore any of them from the session list whenever you need it.',
      enabled: 'Automatic archiving',
      enabledHint: 'Run a check on the interval below and archive matching sessions.',
      days: 'Inactive for (days)',
      daysHint: 'A session is due once it has been quiet for at least this many days.',
      interval: 'Check every (minutes)',
      intervalHint: 'How often the automatic sweep runs while archiving is on.',
      dryRun: 'Dry run',
      dryRunHint: 'Report what would be archived without archiving anything.',
      skipPinned: 'Skip pinned sessions',
      skipPinnedHint: 'Archiving a pinned session would remove its pin.',
      includeSubagent: 'Include subagent sessions',
      includeSubagentHint: 'Subagent child sessions never appear in the conversation list.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a whole number.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'The Host does not expose this plugin’s settings right now.',
      saveFailed: 'The Host did not accept these values; they are kept for you to correct.',
      save: 'Save',
      saving: 'Saving…',
      statusTitle: 'Archive status',
      statusLoading: 'Reading status…',
      statusUnavailable: 'The status route is unavailable; settings still apply on the next check.',
      statusFailed: 'Last check failed: {error}',
      never: 'No automatic check has run yet.',
      lastCheck: 'Last check {time}',
      lastCheckDetail: 'scanned {scanned} · due {matched} · archived {archived} · {duration}s',
      lastCheckDryRun: 'scanned {scanned} · due {matched} · dry run, nothing archived',
      lastCheckSkipped: '{active} active · {missing} missing · {failed} failed',
      nextCheck: 'Next check {time}',
      disabledNext: 'Automatic archiving is off.',
      archivedTotal: '{count} sessions are archived in this profile.',
      previewTitle: 'Due now ({count})',
      previewEmpty: 'No session is due right now.',
      previewMore: '…and {count} more',
      previewFallback: 'creation time',
      runNow: 'Check now',
      refresh: 'Refresh',
      running: 'Checking…',
      noCwd: 'no working directory',
    }

    const zh = {
      summary: '把超过设定天数没有活动的会话自动归档。',
      intro: '会话日志超过下面设定的天数没有变化，就会被移入归档。不会删除任何数据——需要时随时可以从会话列表恢复。',
      enabled: '自动归档',
      enabledHint: '按下面的间隔自动检查，并归档符合条件的会话。',
      days: '未活动天数',
      daysHint: '会话安静至少这么多天后才会被归档。',
      interval: '检查间隔（分钟）',
      intervalHint: '开启自动归档时，多久检查一次。',
      dryRun: '试运行',
      dryRunHint: '只报告会被归档的会话，不真正归档。',
      skipPinned: '跳过置顶会话',
      skipPinnedHint: '归档置顶会话会同时去掉它的置顶。',
      includeSubagent: '包含子代理会话',
      includeSubagentHint: '子代理产生的会话不会显示在会话列表中。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填整数。',
      readOnly: '本部署的设置为只读。',
      unavailable: 'Host 当前没有提供本插件的设置。',
      saveFailed: 'Host 没有接受这些值，已保留供你修改。',
      save: '保存',
      saving: '保存中…',
      statusTitle: '归档状态',
      statusLoading: '正在读取状态…',
      statusUnavailable: '状态接口不可用；设置仍会在下次检查时生效。',
      statusFailed: '上次检查失败：{error}',
      never: '还没有执行过自动检查。',
      lastCheck: '上次检查 {time}',
      lastCheckDetail: '扫描 {scanned} · 命中 {matched} · 已归档 {archived} · 耗时 {duration}s',
      lastCheckDryRun: '扫描 {scanned} · 命中 {matched} · 试运行，未归档',
      lastCheckSkipped: '{active} 个运行中 · {missing} 个已不存在 · {failed} 个失败',
      nextCheck: '下次检查 {time}',
      disabledNext: '自动归档已关闭。',
      archivedTotal: '当前 profile 中共有 {count} 个会话处于归档状态。',
      previewTitle: '当前命中（{count}）',
      previewEmpty: '当前没有符合条件的会话。',
      previewMore: '…另有 {count} 个',
      previewFallback: '创建时间',
      runNow: '立即检查',
      refresh: '刷新',
      running: '检查中…',
      noCwd: '没有工作目录',
    }

    const CSS = `
.dsh-saa-page { display: flex; flex-direction: column; gap: 16px; max-width: 560px; }
.dsh-saa-intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.dsh-saa-switch { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 10px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-saa-switch:first-of-type { border-top: 0; }
.dsh-saa-switchText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-saa-switchLabel { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.dsh-saa-switchHint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-saa-switchControl { flex: none; padding-top: 2px; }
.dsh-saa-status { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
.dsh-saa-statusHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-saa-statusTitle { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; line-height: 20px; }
.dsh-saa-statusLine { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-saa-statusMuted { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-saa-statusError { margin: 0; color: var(--dsw-alias-label-error); font-size: 12px; line-height: 18px; }
.dsh-saa-preview { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.dsh-saa-previewRow { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dsh-saa-previewId { font-family: var(--dsw-font-mono, ui-monospace, monospace); color: var(--dsw-alias-label-tertiary); flex: none; }
.dsh-saa-previewLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-saa-previewMeta { margin-left: auto; flex: none; color: var(--dsw-alias-label-tertiary); }
.dsh-saa-actions { display: flex; gap: 8px; align-items: center; }
`

    /** Format one instant for the reader's locale, or a placeholder. */
    function timeText(iso, fallback) {
      if (typeof iso !== 'string' || iso.length === 0) return fallback
      const time = new Date(iso)
      return Number.isNaN(time.getTime()) ? fallback : time.toLocaleString()
    }

    /** Interpolate the `{name}` placeholders of one copy string. */
    function fill(text, values) {
      return text.replace(/\{(\w+)\}/g, (match, key) => {
        const value = values[key]
        return value === undefined ? match : String(value)
      })
    }

    /** A staged boolean field over the same form model the numbers use. */
    function settingsSwitchField(field) {
      return {
        field,
        format: value => (value === false ? 'off' : 'on'),
        parse: text => ({ kind: 'set', value: text !== 'off' }),
      }
    }

    /** Whether a staged switch field asks for the on state. */
    function isOn(field) {
      return field !== undefined && field.text === 'on'
    }

    /** One labelled switch row inside the settings form. */
    function SwitchRow(props) {
      const { label, hint, checked, disabled, onChange } = props
      return h('div', { className: 'dsh-saa-switch' },
        h('div', { className: 'dsh-saa-switchText' },
          h('span', { className: 'dsh-saa-switchLabel' }, label),
          h('span', { className: 'dsh-saa-switchHint' }, hint)),
        h('div', { className: 'dsh-saa-switchControl' },
          h(primitives.Switch, {
            checked: checked === true,
            disabled: disabled === true,
            label,
            onChange: next => onChange(next === true),
          })))
    }

    /** One preview row: which session, when it was last active, and where. */
    function PreviewRow(props) {
      const { t, session } = props
      const label = session.cwd === null || session.cwd === undefined
        ? t('noCwd')
        : String(session.cwd)
      const basis = session.basis === 'created' ? ` · ${t('previewFallback')}` : ''
      return h('li', { className: 'dsh-saa-previewRow' },
        h('span', { className: 'dsh-saa-previewId' }, String(session.sessionId).slice(0, 8)),
        h('span', { className: 'dsh-saa-previewLabel', title: label }, label),
        h('span', { className: 'dsh-saa-previewMeta' }, `${timeText(session.lastActivityAt, '')}${basis}`))
    }

    /** The Host-reported archive state, with its manual trigger. */
    function StatusCard(props) {
      const { t, snapshot, busy, onRun, onRefresh } = props
      const data = snapshot.data
      const lastRun = data !== null && data !== undefined ? data.lastRun : null
      const lines = []
      if (snapshot.phase === 'loading' && data === null) {
        lines.push(h('p', { key: 'loading', className: 'dsh-saa-statusMuted' }, t('statusLoading')))
      } else if (snapshot.phase === 'error' && data === null) {
        lines.push(h('p', { key: 'error', className: 'dsh-saa-statusError' }, t('statusUnavailable')))
        if (snapshot.error !== null && snapshot.error !== undefined) {
          lines.push(h('p', { key: 'error-detail', className: 'dsh-saa-statusMuted' }, String(snapshot.error)))
        }
      }
      if (lastRun !== null && lastRun !== undefined) {
        lines.push(h('p', { key: 'last', className: 'dsh-saa-statusLine' },
          t('lastCheck').replace('{time}', timeText(lastRun.at, '—'))))
        lines.push(h('p', { key: 'detail', className: 'dsh-saa-statusMuted' },
          lastRun.dryRun === true
            ? fill(t('lastCheckDryRun'), { scanned: lastRun.scanned, matched: lastRun.matched })
            : fill(t('lastCheckDetail'), {
                scanned: lastRun.scanned,
                matched: lastRun.matched,
                archived: lastRun.archived,
                duration: (Number(lastRun.durationMs) / 1000).toFixed(1),
              })))
        if (Number(lastRun.skippedActive) + Number(lastRun.skippedMissing) + Number(lastRun.failed) > 0) {
          lines.push(h('p', { key: 'skipped', className: 'dsh-saa-statusMuted' },
            fill(t('lastCheckSkipped'), {
              active: lastRun.skippedActive,
              missing: lastRun.skippedMissing,
              failed: lastRun.failed,
            })))
        }
        if (Array.isArray(lastRun.errors) && lastRun.errors.length > 0) {
          lines.push(h('p', { key: 'errors', className: 'dsh-saa-statusError' }, String(lastRun.errors[0])))
        }
      } else if (snapshot.phase === 'ready') {
        lines.push(h('p', { key: 'never', className: 'dsh-saa-statusMuted' }, t('never')))
      }
      if (data !== null && data !== undefined) {
        lines.push(h('p', { key: 'next', className: 'dsh-saa-statusMuted' },
          data.config !== undefined && data.config !== null && data.config.enabled === false
            ? t('disabledNext')
            : t('nextCheck').replace('{time}', timeText(data.nextRunAt, '—'))))
        if (data.lastError !== null && data.lastError !== undefined) {
          lines.push(h('p', { key: 'host-error', className: 'dsh-saa-statusError' },
            t('statusFailed').replace('{error}', String(data.lastError))))
        }
        lines.push(h('p', { key: 'archived', className: 'dsh-saa-statusMuted' },
          t('archivedTotal').replace('{count}', String(data.archivedTotal))))
        const preview = data.preview
        if (preview !== undefined && preview !== null) {
          if (preview.total === 0) {
            lines.push(h('p', { key: 'preview-empty', className: 'dsh-saa-statusMuted' }, t('previewEmpty')))
          } else {
            lines.push(h('p', { key: 'preview-title', className: 'dsh-saa-statusLine' },
              t('previewTitle').replace('{count}', String(preview.total))))
            lines.push(h('ul', { key: 'preview', className: 'dsh-saa-preview' },
              preview.sessions.map(session => h(PreviewRow, { key: session.sessionId, t, session }))))
            if (preview.truncated === true) {
              lines.push(h('p', { key: 'preview-more', className: 'dsh-saa-statusMuted' },
                t('previewMore').replace('{count}', String(preview.total - preview.sessions.length))))
            }
          }
        }
      }
      return h('section', { className: 'dsh-saa-status', 'aria-live': 'polite' },
        h('div', { className: 'dsh-saa-statusHead' },
          h('h3', { className: 'dsh-saa-statusTitle' }, t('statusTitle')),
          h('div', { className: 'dsh-saa-actions' },
            h(primitives.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busy,
              onClick: onRefresh,
            }, t('refresh')),
            h(primitives.Button, {
              variant: 'outline',
              size: 'sm',
              disabled: busy,
              onClick: onRun,
            }, busy ? t('running') : t('runNow')))),
        lines)
    }

    /** The short one-liner the Plugins page shows before the page opens. */
    function PageShell(props) {
      const t = props.t ?? props.boundT
      const withCopy = { ...props, t }
      if (props.view === 'summary') return t('summary')
      return h(PageBody, withCopy)
    }

    /** The full page: the settings form, then the archive status card. */
    function PageBody(props) {
      const t = props.t
      const store = props.store
      const status = props.status
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const statusSnapshot = React.useSyncExternalStore(status.subscribe, status.getSnapshot, status.getSnapshot)

      React.useEffect(() => {
        status.load(true)
      }, [])

      const field = name => state[name]
      const onSave = () => {
        Promise.resolve(props.save()).then(saved => {
          if (saved === false) return
          // The loader applies a volatile update while the write settles; give the
          // Host a beat so the refreshed document already carries the new cadence.
          setTimeout(() => status.load(true), 200)
        })
      }
      const busy = statusSnapshot.busy === true
        || (statusSnapshot.data !== null && statusSnapshot.data !== undefined && statusSnapshot.data.running === true)

      return h('div', { className: 'dsh-saa-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('p', { className: 'dsh-saa-intro' }, t('intro')),
        h(primitives.SettingsForm, {
          labels: {
            unavailable: t('unavailable'),
            readOnly: t('readOnly'),
            saveFailed: t('saveFailed'),
            save: t('save'),
            saving: t('saving'),
          },
          state,
          onSave,
          onDiscard: props.discard,
        },
        h(SwitchRow, {
          label: t('enabled'),
          hint: t('enabledHint'),
          checked: isOn(field('enabled')),
          disabled: !state.writable,
          onChange: next => props.edit('enabled', next ? 'on' : 'off'),
        }),
        h(primitives.SettingsValueField, {
          id: 'plugin-config-session-auto-archive-days',
          label: t('days'),
          hint: t('daysHint'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalidNumber'),
          numeric: true,
          disabled: !state.writable,
          ...field('days'),
          onEdit: text => props.edit('days', text),
          onReset: () => props.resetField('days'),
        }),
        h(primitives.SettingsValueField, {
          id: 'plugin-config-session-auto-archive-interval',
          label: t('interval'),
          hint: t('intervalHint'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalidNumber'),
          numeric: true,
          disabled: !state.writable,
          ...field('intervalMinutes'),
          onEdit: text => props.edit('intervalMinutes', text),
          onReset: () => props.resetField('intervalMinutes'),
        }),
        h(SwitchRow, {
          label: t('dryRun'),
          hint: t('dryRunHint'),
          checked: isOn(field('dryRun')),
          disabled: !state.writable,
          onChange: next => props.edit('dryRun', next ? 'on' : 'off'),
        }),
        h(SwitchRow, {
          label: t('skipPinned'),
          hint: t('skipPinnedHint'),
          checked: isOn(field('skipPinned')),
          disabled: !state.writable,
          onChange: next => props.edit('skipPinned', next ? 'on' : 'off'),
        }),
        h(SwitchRow, {
          label: t('includeSubagent'),
          hint: t('includeSubagentHint'),
          checked: isOn(field('includeSubagentSessions')),
          disabled: !state.writable,
          onChange: next => props.edit('includeSubagentSessions', next ? 'on' : 'off'),
        })),
        h(StatusCard, {
          t,
          snapshot: statusSnapshot,
          busy,
          onRun: () => status.run(),
          onRefresh: () => status.load(true),
        }))
    }

    /** Polling face over the Host plugin's JSON routes. */
    function createStatusStore() {
      let snapshot = { phase: 'idle', data: null, error: null, busy: false }
      const listeners = new Set()
      const publish = patch => {
        snapshot = { ...snapshot, ...patch }
        for (const listener of [...listeners]) listener()
      }
      const request = async (path, options) => {
        const response = await fetch(`${API}${path}`, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          ...options,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return snapshot
        },
        async load(preview) {
          publish({ phase: snapshot.data === null ? 'loading' : snapshot.phase })
          try {
            const data = await request(`/status${preview === true ? '?preview=1' : ''}`)
            publish({ phase: 'ready', data, error: null })
          } catch (error) {
            publish({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
          }
        },
        async run() {
          if (snapshot.busy) return
          publish({ busy: true })
          try {
            const body = await request('/run', {
              method: 'POST',
              headers: { accept: 'application/json', [RUN_HEADER]: '1' },
            })
            publish({ phase: 'ready', data: body.status ?? snapshot.data, error: null })
            const data = await request('/status?preview=1')
            publish({ phase: 'ready', data, error: null })
          } catch (error) {
            publish({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
          } finally {
            publish({ busy: false })
          }
        },
      }
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-auto-archive: dictionaries')
        const boundT = ctx.locale.bind(NS)
        const scope = ctx.configForms.get(ENTRY_ID)
        const model = new primitives.SettingsFormModel(scope, [
          settingsSwitchField('enabled'),
          primitives.settingsNumberField('days'),
          primitives.settingsNumberField('intervalMinutes'),
          settingsSwitchField('dryRun'),
          settingsSwitchField('skipPinned'),
          settingsSwitchField('includeSubagentSessions'),
        ])
        const store = model.bind(() => ({
          ...model.shell(),
          enabled: model.field('enabled'),
          days: model.field('days'),
          intervalMinutes: model.field('intervalMinutes'),
          dryRun: model.field('dryRun'),
          skipPinned: model.field('skipPinned'),
          includeSubagentSessions: model.field('includeSubagentSessions'),
        }))
        const status = createStatusStore()
        ctx.effect(() => () => model.dispose(), 'session-auto-archive: form subscription')
        ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: `${PACKAGE_NAME}#${ENTRY_ID}`,
          locale: NS,
          inject: () => ({
            ...model.actions(),
            store,
            status,
            boundT,
          }),
        }, PageShell))), 'session-auto-archive: settings page')
      },
    }
  },
})
