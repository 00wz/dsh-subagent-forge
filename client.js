window.__ModuleLoader__.load({
  id: '@local/subagent-forge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/subagent-forge/config'

    const DICT_EN = {
      tab: 'Subagent forge',
      title: 'Models agents may choose',
      hint: 'Each route is written as provider/model. The description is what the agent reads when it picks a model. An empty list allows only the parent route.',
      route: 'Route',
      description: 'Description for the agent',
      add: 'Add model',
      remove: 'Remove',
      grantHint: 'A delegation grant is given per launch: the agent states it on every call, and there is no default.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. New sessions see the updated tool.',
      notApplied: 'The save was accepted but the new value did not come back. Check the plugin log.',
      loadFailed: 'Could not load the configuration.',
      saveFailed: 'Could not save the configuration.',
      retry: 'Retry',
      loading: 'Loading…',
      noModels: 'No models yet.',
    }

    const DICT_RU = {
      tab: 'Кузница субагентов',
      title: 'Модели, доступные агентам',
      hint: 'Маршрут записывается как provider/model. Описание — это то, что агент читает при выборе модели. Пустой список разрешает только маршрут родителя.',
      route: 'Маршрут',
      description: 'Описание для агента',
      add: 'Добавить модель',
      remove: 'Удалить',
      grantHint: 'Право делегирования выдаётся на каждый запуск отдельно: его указывают в каждом вызове, значения по умолчанию нет.',
      save: 'Сохранить',
      saving: 'Сохраняем…',
      saved: 'Сохранено. Новые сессии увидят обновлённый инструмент.',
      notApplied: 'Сохранение принято, но новое значение не вернулось. Проверьте лог плагина.',
      loadFailed: 'Не удалось загрузить конфигурацию.',
      saveFailed: 'Не удалось сохранить конфигурацию.',
      retry: 'Повторить',
      loading: 'Загрузка…',
      noModels: 'Моделей пока нет.',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      input: {
        flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 12,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6,
      },
      inputNarrow: { flex: '1 1 46%' },
      button: {
        padding: '6px 12px', fontSize: 12, cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6,
      },
      buttonPrimary: {
        padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
        color: '#fff', background: 'var(--dsw-alias-brand-primary)', border: 'none', borderRadius: 6,
      },
      ghost: {
        padding: '6px 10px', fontSize: 12, cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6,
      },
      card: {
        display: 'flex', flexDirection: 'column', gap: 10, padding: 12,
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
      },
      status: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
    }

    function Page(props) {
      const t = props.t
      const [state, setState] = React.useState({ phase: 'loading', value: null, dirty: false, message: '', error: '' })

      const load = React.useCallback(async () => {
        setState((prev) => ({ ...prev, phase: 'loading', error: '' }))
        try {
          const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `${response.status}`)
          setState({ phase: 'ready', value: body.value, dirty: false, message: '', error: '' })
        } catch (error) {
          setState({ phase: 'error', value: null, dirty: false, message: '', error: error.message })
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const setModel = (index, patch) => {
        setState((prev) => {
          const models = prev.value.models.map((model, at) => at === index ? { ...model, ...patch } : model)
          return { ...prev, dirty: true, message: '', value: { ...prev.value, models } }
        })
      }

      const addModel = () => {
        setState((prev) => ({
          ...prev, dirty: true, message: '',
          value: { ...prev.value, models: [...prev.value.models, { route: '', description: '' }] },
        }))
      }

      const removeModel = (index) => {
        setState((prev) => ({
          ...prev, dirty: true, message: '',
          value: { ...prev.value, models: prev.value.models.filter((_, at) => at !== index) },
        }))
      }

      const save = async () => {
        setState((prev) => ({ ...prev, phase: 'saving', error: '' }))
        const sent = state.value
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: sent }),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `${response.status}`)
          for (let attempt = 0; attempt < 15; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            const fresh = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
            if (!fresh.ok) continue
            const next = await fresh.json()
            const sameModels = JSON.stringify(next.value?.models) === JSON.stringify(sent.models)
            if (sameModels) {
              setState({ phase: 'ready', value: next.value, dirty: false, message: t('saved'), error: '' })
              return
            }
          }
          setState((prev) => ({ ...prev, phase: 'ready', error: t('notApplied') }))
        } catch (error) {
          setState((prev) => ({ ...prev, phase: 'ready', error: `${t('saveFailed')} ${error.message}` }))
        }
      }

      if (state.phase === 'loading') return h('div', { style: S.page }, h('p', { style: S.hint }, t('loading')))
      if (state.phase === 'error') {
        return h('div', { style: S.page },
          h('p', { style: S.error }, `${t('loadFailed')} ${state.error}`),
          h('div', { style: S.row }, h('button', { type: 'button', style: S.button, onClick: load }, t('retry'))))
      }

      const models = state.value.models ?? []
      const saving = state.phase === 'saving'

      return h('div', { style: S.page },
        h('div', { style: S.card },
          h('h3', { style: S.title }, t('title')),
          h('p', { style: S.hint }, t('hint')),
          models.length === 0 ? h('p', { style: S.hint }, t('noModels')) : null,
          ...models.map((model, index) => h('div', { style: S.row, key: index },
            h('input', {
              style: { ...S.input, ...S.inputNarrow },
              value: model.route ?? '',
              placeholder: 'polza/deepseek/deepseek-v4.1-flash-1017',
              'aria-label': t('route'),
              onChange: (event) => setModel(index, { route: event.target.value }),
            }),
            h('input', {
              style: S.input,
              value: model.description ?? '',
              placeholder: t('description'),
              'aria-label': t('description'),
              onChange: (event) => setModel(index, { description: event.target.value }),
            }),
            h('button', { type: 'button', style: S.ghost, onClick: () => removeModel(index) }, t('remove')))),
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.button, onClick: addModel }, t('add')))),
        h('div', { style: S.card },
          h('p', { style: S.hint }, t('grantHint'))),
        h('div', { style: S.row },
          h('button', {
            type: 'button',
            style: { ...S.buttonPrimary, opacity: state.dirty && !saving ? 1 : 0.55, cursor: state.dirty && !saving ? 'pointer' : 'default' },
            disabled: !state.dirty || saving,
            onClick: save,
          }, saving ? t('saving') : t('save')),
          state.error ? h('span', { style: S.error }, state.error) : null,
          !state.error && state.message ? h('span', { style: S.status }, state.message) : null))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register('subagent-forge', 'en', DICT_EN)
        ctx.locale.register('subagent-forge', 'ru', DICT_RU)
        const t = ctx.locale.bind('subagent-forge')
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'subagent-forge',
          order: 40,
          label: () => t('tab'),
        }, () => h(Page, { t })))
      },
    }
  },
})
