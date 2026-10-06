// Browser half of dsh-gh-pages-artifacts: the plugin's settings page on the dsh Plugins page.
// Plain JS in the client module format dsh loads (React comes from the host's module table), so
// the package needs no client build step. Styles use the host's --dsw-alias-* theme tokens.
window.__ModuleLoader__.load({
  id: 'dsh-gh-pages-artifacts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState, useSyncExternalStore } = React

    /** Package name, and the settings namespace: the row id the bundle patch declares. */
    const PKG = 'dsh-gh-pages-artifacts'
    const NS = 'gh-pages-artifacts'
    const DEFAULT_TOKEN_ENV = 'GH_PAGES_TOKEN'
    const TOKEN_HELP = 'https://github.com/settings/personal-access-tokens/new'

    const css = {
      page: { display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 720, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      section: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)' },
      heading: { margin: 0, fontSize: 14, fontWeight: 600 },
      intro: { margin: 0, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      labelRow: { display: 'flex', alignItems: 'center', gap: 8 },
      label: { fontWeight: 500 },
      hint: { color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.4 },
      badge: { fontSize: 11, padding: '1px 6px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-secondary)' },
      reset: { marginLeft: 'auto', background: 'none', border: 'none', padding: 0, color: 'var(--dsw-alias-link)', cursor: 'pointer', font: 'inherit', fontSize: 12 },
      input: { font: 'inherit', fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', outline: 'none', minWidth: 0 },
      radios: { display: 'flex', flexDirection: 'column', gap: 6 },
      choice: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', lineHeight: 1.4 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      two: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      primary: { font: 'inherit', fontSize: 13, padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' },
      secondary: { font: 'inherit', fontSize: 13, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      link: { color: 'var(--dsw-alias-link)' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
    }

    /** Editable options, in page order. Paths address the plugin's Config. */
    const FIELDS = {
      repoStrategy: { path: ['repoStrategy'] },
      repository: { path: ['repository'], optional: true },
      owner: { path: ['owner'], optional: true },
      repo: { path: ['repo'] },
      branch: { path: ['branch'] },
      repoPrefix: { path: ['repoPrefix'] },
      repoVisibility: { path: ['repoVisibility'] },
      authorName: { path: ['commitAuthor', 'name'], optional: true, resetPath: ['commitAuthor'] },
      authorEmail: { path: ['commitAuthor', 'email'], optional: true, resetPath: ['commitAuthor'] },
      approval: { path: ['approval'] },
      noindex: { path: ['noindex'] },
      blockSecrets: { path: ['blockSecrets'] },
      tokenEnv: { path: ['tokenEnv'] },
      baseUrl: { path: ['baseUrl'], optional: true },
    }

    function at(object, path) {
      let value = object
      for (const key of path) {
        if (value === null || typeof value !== 'object') return undefined
        value = value[key]
      }
      return value
    }

    function present(object, path) {
      let value = object
      for (const key of path) {
        if (value === null || typeof value !== 'object' || !(key in value)) return false
        value = value[key]
      }
      return true
    }

    function useForm(form) {
      return useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
    }

    /** Reads whether the token credential is configured, re-reading when the Host reports a change. */
    function useCredential(ctx, ref) {
      const [state, setState] = useState({ ref, configured: false, writable: true, source: undefined, loading: true })
      const [tick, setTick] = useState(0)
      useEffect(() => {
        let live = true
        const credentials = ctx.remote && ctx.remote.credentials
        if (!credentials) {
          setState({ ref, configured: false, writable: false, source: undefined, loading: false, unavailable: true })
          return () => { live = false }
        }
        Promise.resolve(credentials.describe([ref])).then((response) => {
          if (!live) return
          const view = response && response.ok ? response.value[ref] : undefined
          setState({ ref, configured: Boolean(view && view.configured), writable: view ? view.writable !== false : true, source: view && view.source, loading: false })
        }, () => { if (live) setState(previous => ({ ...previous, ref, loading: false })) })
        return () => { live = false }
      }, [ctx, ref, tick])
      useEffect(() => {
        if (!ctx.remote || typeof ctx.remote.$on !== 'function') return undefined
        return ctx.remote.$on('credentials/reference-updated', (changed) => { if (changed === ref) setTick(value => value + 1) })
      }, [ctx, ref])
      return [state, () => setTick(value => value + 1)]
    }

    function Field({ label, hint, overridden, onReset, children }) {
      return h('div', { style: css.field },
        h('div', { style: css.labelRow },
          h('span', { style: css.label }, label),
          overridden ? h('span', { style: css.badge }, 'Set') : null,
          overridden && onReset ? h('button', { type: 'button', style: css.reset, onClick: onReset }, 'Reset to default') : null),
        children,
        hint ? h('span', { style: css.hint }, hint) : null)
    }

    function TextInput({ value, onChange, placeholder, disabled, type }) {
      return h('input', {
        type: type || 'text', value: value == null ? '' : String(value), placeholder, disabled,
        spellCheck: false, autoComplete: 'off', style: css.input,
        onChange: event => onChange(event.target.value),
      })
    }

    function Select({ value, options, onChange, disabled }) {
      return h('select', { value, disabled, style: css.input, onChange: event => onChange(event.target.value) },
        options.map(([option, text]) => h('option', { key: option, value: option }, text)))
    }

    function Toggle({ checked, onChange, disabled, label }) {
      return h('label', { style: css.choice },
        h('input', { type: 'checkbox', checked: Boolean(checked), disabled, onChange: event => onChange(event.target.checked) }),
        h('span', null, label))
    }

    function TokenSection({ ctx, tokenEnv }) {
      const [credential, refresh] = useCredential(ctx, tokenEnv)
      const [draft, setDraft] = useState('')
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const save = async () => {
        if (draft.trim() === '') return
        setBusy(true)
        setMessage(null)
        try {
          await ctx.remote.credentials.set(tokenEnv, draft.trim())
          setDraft('')
          setMessage({ ok: true, text: 'Token saved.' })
          refresh()
        } catch (error) {
          setMessage({ ok: false, text: `Could not save the token: ${error && error.message ? error.message : String(error)}` })
        } finally {
          setBusy(false)
        }
      }
      const status = credential.loading ? 'Checking…'
        : credential.configured ? `Configured${credential.source ? ` (from ${credential.source})` : ''}` : 'Not configured'
      return h('section', { style: css.section },
        h('h4', { style: css.heading }, 'GitHub token'),
        h('p', { style: css.intro },
          'The plugin publishes with a GitHub token stored in dsh’s credential store as ',
          h('code', { style: css.code }, tokenEnv), '. It never enters the conversation. ',
          h('a', { href: TOKEN_HELP, target: '_blank', rel: 'noopener noreferrer', style: css.link }, 'Create a fine-grained token'),
          ' with Contents: read and write (and Pages: read) on your artifacts repository. The per-artifact strategy needs access to all repositories with Administration, Contents, and Pages write.'),
        h('div', { style: css.row },
          h('span', { style: credential.configured ? css.ok : css.warn }, status)),
        credential.unavailable
          ? h('span', { style: css.hint }, 'This connection cannot write credentials; set the token in the environment or $DSH_HOME/.credentials.yaml.')
          : !credential.writable
            ? h('span', { style: css.hint }, 'This token comes from the environment dsh was started with, so it cannot be changed here.')
            : h('div', { style: css.row },
              h('div', { style: { flex: '1 1 260px', display: 'flex' } },
                h('input', {
                  type: 'password', value: draft, placeholder: credential.configured ? 'Paste a new token to replace it' : 'github_pat_…',
                  autoComplete: 'off', spellCheck: false, style: { ...css.input, flex: 1 },
                  onChange: event => setDraft(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') void save() },
                })),
              h('button', { type: 'button', style: { ...css.primary, opacity: busy || draft.trim() === '' ? 0.6 : 1 }, disabled: busy || draft.trim() === '', onClick: save },
                credential.configured ? 'Replace token' : 'Save token')),
        message ? h('span', { style: message.ok ? css.ok : css.error }, message.text) : null)
    }

    /** The Plugins page asks for a one-line summary or the full page. */
    function ConfigEntry(props) {
      return props.view === 'summary' ? 'Publish HTML pages and Markdown documents to GitHub Pages.' : h(ConfigPage, props)
    }

    function ConfigPage({ ctx }) {
      const form = useMemo(() => ctx.configForms.get(NS), [ctx])
      const snapshot = useForm(form)
      const [draft, setDraft] = useState({})
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      if (snapshot.status === 'loading') return h('div', { style: css.page }, h('p', { style: css.intro }, 'Loading settings…'))
      if (snapshot.status === 'unavailable' || snapshot.value === undefined) {
        return h('div', { style: css.page }, h('p', { style: css.intro }, 'Settings are not available on this connection. Edit the gh-pages-artifacts row in your profile’s cordis.patch.yml instead.'))
      }
      const value = snapshot.value
      const read = (name) => (name in draft ? draft[name] : at(value, FIELDS[name].path))
      const edit = (name, next) => { setMessage(null); setDraft(previous => ({ ...previous, [name]: next })) }
      const overridden = name => present(snapshot.user, FIELDS[name].path)
      const disabled = !snapshot.writable || busy
      const dirty = Object.keys(draft).length > 0
      const resetField = async (name) => {
        setBusy(true)
        try {
          const field = FIELDS[name]
          const ok = await form.mutate([{ op: 'unset', path: field.resetPath || field.path }], snapshot.revision)
          setDraft(previous => {
            const next = { ...previous }
            for (const other of Object.keys(FIELDS)) {
              if (other === name || (field.resetPath && FIELDS[other].resetPath === field.resetPath)) delete next[other]
            }
            return next
          })
          setMessage(ok ? { ok: true, text: 'Reset to default.' } : { ok: false, text: 'The change was not accepted; the page shows the current values.' })
        } finally {
          setBusy(false)
        }
      }
      const save = async () => {
        const name = String(read('authorName') ?? '').trim()
        const email = String(read('authorEmail') ?? '').trim()
        if ((name === '') !== (email === '')) {
          setMessage({ ok: false, text: 'Set both the commit author name and email, or neither.' })
          return
        }
        const ops = []
        for (const [field, next] of Object.entries(draft)) {
          const { path, optional } = FIELDS[field]
          const text = typeof next === 'string' ? next.trim() : next
          if (optional && text === '') ops.push({ op: 'unset', path })
          else ops.push({ op: 'set', path, value: text })
        }
        setBusy(true)
        setMessage(null)
        try {
          const ok = await form.mutate(ops, snapshot.revision)
          if (ok) {
            setDraft({})
            setMessage({ ok: true, text: 'Saved. New settings apply to the next publish.' })
          } else {
            setMessage({ ok: false, text: 'The settings were not accepted (a value may be invalid, or the file changed meanwhile). The page shows the current values.' })
            setDraft({})
          }
        } catch (error) {
          setMessage({ ok: false, text: `Could not save: ${error && error.message ? error.message : String(error)}` })
        } finally {
          setBusy(false)
        }
      }
      const strategy = read('repoStrategy')
      const tokenEnv = String(at(value, ['tokenEnv']) || DEFAULT_TOKEN_ENV)
      return h('div', { style: css.page },
        h(TokenSection, { ctx, tokenEnv }),
        h('section', { style: css.section },
          h('h4', { style: css.heading }, 'Where artifacts are published'),
          h('p', { style: css.intro }, 'You can also change this in chat, for example “use github.com/me/team-pages for artifacts” or “put each artifact in its own repo”; the agent saves the choice here. Existing artifacts stay where they were published.'),
          h(Field, { label: 'Repository strategy', overridden: overridden('repoStrategy'), onReset: () => resetField('repoStrategy') },
            h('div', { style: css.radios },
              [['shared', 'One shared repository', 'Every artifact gets its own folder in one repository.'],
                ['per-artifact', 'A new repository for each artifact', 'Each new artifact gets its own repository and GitHub Pages site.']].map(([option, title, text]) =>
                h('label', { key: option, style: css.choice },
                  h('input', { type: 'radio', name: 'gh-pages-artifacts-strategy', value: option, checked: strategy === option, disabled, onChange: () => edit('repoStrategy', option) }),
                  h('span', null, h('span', { style: css.label }, title), h('br'), h('span', { style: css.hint }, text)))))),
          strategy === 'per-artifact'
            ? h('div', { style: css.two },
              h(Field, { label: 'Owner of new repositories', hint: 'Your account or an organization; defaults to the token’s account.', overridden: overridden('owner'), onReset: () => resetField('owner') },
                h(TextInput, { value: read('owner'), placeholder: 'token’s account', disabled, onChange: next => edit('owner', next) })),
              h(Field, { label: 'Repository name prefix', hint: 'New repositories are named <prefix><artifact id>.', overridden: overridden('repoPrefix'), onReset: () => resetField('repoPrefix') },
                h(TextInput, { value: read('repoPrefix'), disabled, onChange: next => edit('repoPrefix', next) })),
              h(Field, { label: 'Visibility of new repositories', hint: 'Pages on private repositories needs a paid plan; pages are public either way.', overridden: overridden('repoVisibility'), onReset: () => resetField('repoVisibility') },
                h(Select, { value: read('repoVisibility'), options: [['public', 'Public'], ['private', 'Private']], disabled, onChange: next => edit('repoVisibility', next) })))
            : h(Field, { label: 'Shared repository', hint: 'owner/name or a remote URL such as https://github.com/owner/name.git or git@github.com:owner/name.git. Leave empty to use the owner and name below.', overridden: overridden('repository'), onReset: () => resetField('repository') },
              h(TextInput, { value: read('repository'), placeholder: 'owner/name or https://github.com/owner/name.git', disabled, onChange: next => edit('repository', next) })),
          strategy === 'per-artifact' ? null : h('div', { style: css.two },
            h(Field, { label: 'Owner', hint: 'Used when no shared repository is set; defaults to the token’s account.', overridden: overridden('owner'), onReset: () => resetField('owner') },
              h(TextInput, { value: read('owner'), placeholder: 'token’s account', disabled, onChange: next => edit('owner', next) })),
            h(Field, { label: 'Repository name', hint: 'Used when no shared repository is set.', overridden: overridden('repo'), onReset: () => resetField('repo') },
              h(TextInput, { value: read('repo'), disabled, onChange: next => edit('repo', next) }))),
          h(Field, { label: 'Pages branch', hint: 'GitHub Pages publishes this branch; it is created when missing.', overridden: overridden('branch'), onReset: () => resetField('branch') },
            h(TextInput, { value: read('branch'), disabled, onChange: next => edit('branch', next) }))),
        h('section', { style: css.section },
          h('h4', { style: css.heading }, 'Commits'),
          h('div', { style: css.two },
            h(Field, { label: 'Author name', hint: 'Leave both empty to use the token’s account.', overridden: overridden('authorName'), onReset: () => resetField('authorName') },
              h(TextInput, { value: read('authorName'), placeholder: 'Your Name', disabled, onChange: next => edit('authorName', next) })),
            h(Field, { label: 'Author email', overridden: overridden('authorEmail'), onReset: () => resetField('authorEmail') },
              h(TextInput, { value: read('authorEmail'), placeholder: 'you@example.com', disabled, onChange: next => edit('authorEmail', next) })))),
        h('section', { style: css.section },
          h('h4', { style: css.heading }, 'Safety'),
          h(Field, { label: 'Ask before publishing and deleting', overridden: overridden('approval'), onReset: () => resetField('approval') },
            h(Select, {
              value: read('approval'), disabled, onChange: next => edit('approval', next),
              options: [['unless-full-access', 'Always, except in Full access sessions'], ['always', 'Always'], ['off', 'Never']],
            })),
          h(Toggle, { label: 'Ask search engines not to index published pages', checked: read('noindex'), disabled, onChange: next => edit('noindex', next) }),
          h(Toggle, { label: 'Refuse to publish credential files and text that looks like a secret', checked: read('blockSecrets'), disabled, onChange: next => edit('blockSecrets', next) })),
        h('section', { style: css.section },
          h('h4', { style: css.heading }, 'Advanced'),
          h('div', { style: css.two },
            h(Field, { label: 'Token credential name', hint: 'Environment variable / credential reference holding the token.', overridden: overridden('tokenEnv'), onReset: () => resetField('tokenEnv') },
              h(TextInput, { value: read('tokenEnv'), disabled, onChange: next => edit('tokenEnv', next) })),
            h(Field, { label: 'Site URL (custom domain)', hint: 'Only needed for a custom domain the token cannot read from GitHub.', overridden: overridden('baseUrl'), onReset: () => resetField('baseUrl') },
              h(TextInput, { value: read('baseUrl'), placeholder: 'https://pages.example.com', disabled, onChange: next => edit('baseUrl', next) })))),
        h('div', { style: css.actions },
          h('button', { type: 'button', style: { ...css.primary, opacity: dirty && !disabled ? 1 : 0.6 }, disabled: !dirty || disabled, onClick: save }, busy ? 'Saving…' : 'Save'),
          h('button', { type: 'button', style: { ...css.secondary, opacity: dirty ? 1 : 0.6 }, disabled: !dirty || busy, onClick: () => { setDraft({}); setMessage(null) } }, 'Discard'),
          snapshot.writable ? null : h('span', { style: css.hint }, 'These settings are fixed by a higher configuration layer and cannot be edited here.'),
          message ? h('span', { style: message.ok ? css.ok : css.error }, message.text) : null),
        h('p', { style: css.hint }, 'Everything published is listed under Artifacts in the sidebar.'))
    }

    // ---- Artifacts sidebar entry and panel -------------------------------------------------

    /** One id for the sidebar entry and its main panel; namespaced so it never collides with a built-in. */
    const PANEL_ID = 'dsh-gh-pages-artifacts'
    /** Plugins is order 0 and Automation tasks 10; the entry sorts after both. */
    const PANEL_ORDER = 20
    /** Document-relative routes the Host half serves (never '/api/...': the page may be mounted under a prefix). */
    const LIST_ROUTE = 'api/gh-pages-artifacts/list'
    const REFRESH_ROUTE = 'api/gh-pages-artifacts/refresh'
    const DELETE_ROUTE = 'api/gh-pages-artifacts/delete'

    /** Sidebar glyph: the sidebar passes { size, active } and draws the button around it. */
    function ArtifactsIcon({ size, className }) {
      return h('svg', {
        width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round', strokeLinecap: 'round',
      },
      h('path', { d: 'M8 2.5 13.5 5.25 8 8 2.5 5.25Z' }),
      h('path', { d: 'M2.5 8 8 10.75 13.5 8' }),
      h('path', { d: 'M2.5 10.75 8 13.5 13.5 10.75' }))
    }

    function TrashIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round', strokeLinecap: 'round',
      },
      h('path', { d: 'M2.5 4.5h11' }),
      h('path', { d: 'M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5' }),
      h('path', { d: 'M4 4.5l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1' }),
      h('path', { d: 'M6.75 7v4M9.25 7v4' }))
    }

    /** The host's list-page frame (Automation tasks / Plugins), as literal values and theme tokens. */
    const PANEL_CSS = `
.gpa-page{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.gpa-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.gpa-content{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.gpa-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:28px;margin-bottom:8px}
html[data-platform='darwin'] .gpa-head{padding-top:calc(28px + var(--dsh-frame-top-clearance, 0px))}
.gpa-head h1{flex:1;min-width:0;margin:0;font-size:20px;line-height:28px;font-weight:500}
.gpa-intro{margin:0 0 20px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.gpa-button{height:32px;padding:0 12px;border-radius:16px;border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.gpa-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gpa-button:disabled{opacity:.6;cursor:default}
.gpa-rows{display:flex;flex-direction:column;gap:2px;margin:0 -8px;padding:0;list-style:none}
.gpa-item{display:flex;flex-direction:column;border-radius:12px}
.gpa-item:hover,.gpa-item.gpa-confirming{background:var(--dsw-alias-interactive-bg-hover)}
.gpa-main{display:flex;align-items:flex-start;gap:4px}
.gpa-row{display:flex;flex:1;min-width:0;align-items:flex-start;gap:12px;padding:8px;border-radius:12px;color:inherit;text-decoration:none}
.gpa-actions{flex:none;padding:8px 8px 0 0}
.gpa-icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-caption);cursor:pointer;opacity:0}
.gpa-item:hover .gpa-icon-button,.gpa-icon-button:focus-visible{opacity:1}
@media (hover:none){.gpa-icon-button{opacity:1}}
.gpa-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary)}
.gpa-icon-button:focus-visible,.gpa-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px}
.gpa-confirm{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 8px 8px 36px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.gpa-confirm-text{flex:1;min-width:200px}
.gpa-danger{height:28px;padding:0 12px;border:0;border-radius:14px;background:var(--dsw-alias-state-error-primary);color:#fff;font:inherit;font-size:13px;cursor:pointer}
.gpa-danger:disabled{opacity:.6;cursor:default}
.gpa-small{height:28px;border-radius:14px}
.gpa-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px}
.gpa-glyph{flex:none;width:16px;height:20px;margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.gpa-body{display:flex;flex:1;flex-direction:column;min-width:0}
.gpa-title{overflow:hidden;font-weight:500;line-height:23px;text-overflow:ellipsis;white-space:nowrap}
.gpa-link{color:var(--dsw-alias-link);font-size:13px;line-height:21px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gpa-summary{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:21px;overflow-wrap:anywhere}
.gpa-meta+.gpa-meta::before{content:'·';padding:0 2px}
.gpa-empty{display:flex;flex-direction:column;align-items:center;padding:48px 20px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:14px}
.gpa-notice{margin:0 0 16px;padding:12px 14px;border-radius:10px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.gpa-error{color:var(--dsw-alias-state-error-primary)}
`

    /** One <style> owned by this package, removed when the panel registration goes away. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const element = document.createElement('style')
      element.setAttribute('data-plugin', PKG)
      element.textContent = PANEL_CSS
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    /** Registry data is not trusted markup: only http(s) URLs become links. */
    function safeHref(url) {
      try {
        const parsed = new URL(String(url))
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined
      } catch {
        return undefined
      }
    }

    async function requestArtifacts(route, method, signal, payload) {
      const response = await fetch(route, {
        method, signal,
        headers: payload === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...payload === undefined ? {} : { body: JSON.stringify(payload) },
      })
      if (response.status === 401) throw new Error('This browser is no longer signed in to dsh. Reopen dsh from the link it printed.')
      if (response.status === 404) throw new Error('The artifact list is not available. Is the GitHub Pages Artifacts plugin running?')
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
      return body
    }

    /** Loads the list when the panel opens and after a reconnect; refresh() also checks GitHub. */
    function useArtifacts(ctx) {
      const [state, setState] = useState({ status: 'loading', artifacts: [], notes: [], error: null })
      const [generation, setGeneration] = useState(0)
      useEffect(() => ctx.on('connection/reset', () => setGeneration(value => value + 1)), [ctx])
      useEffect(() => {
        const abort = new AbortController()
        requestArtifacts(LIST_ROUTE, 'GET', abort.signal).then(
          body => setState({ status: 'ready', artifacts: body.artifacts || [], notes: body.notes || [], error: null }),
          (error) => { if (!abort.signal.aborted) setState(previous => ({ ...previous, status: 'error', error: String((error && error.message) || error) })) })
        return () => abort.abort()
      }, [generation])
      const refresh = async () => {
        setState(previous => ({ ...previous, status: 'refreshing', error: null }))
        try {
          const body = await requestArtifacts(REFRESH_ROUTE, 'POST')
          setState({ status: 'ready', artifacts: body.artifacts || [], notes: body.notes || [], error: null })
        } catch (error) {
          setState(previous => ({ ...previous, status: 'error', error: String((error && error.message) || error) }))
        }
      }
      /** Delete after the user confirmed; the Host answers with the remaining list. */
      const remove = async (id) => {
        const body = await requestArtifacts(DELETE_ROUTE, 'POST', undefined, { id })
        setState(previous => ({ ...previous, status: 'ready', artifacts: body.artifacts || [], error: null }))
        return body.deleted
      }
      return [state, refresh, remove]
    }

    function formatTime(value) {
      const time = Date.parse(value)
      return Number.isNaN(time) ? '' : new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    }

    /** The main-column page; mounted only while selected, so opening it loads the list again. */
    function ArtifactsPage({ ctx }) {
      const [state, refresh, remove] = useArtifacts(ctx)
      const [confirming, setConfirming] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const [flash, setFlash] = useState(null)
      const rows = state.artifacts.filter(item => item && item.status !== 'deleted')
      const busy = state.status === 'loading' || state.status === 'refreshing' || deleting !== null
      const confirmDelete = async (item) => {
        setDeleting(item.id)
        setFlash(null)
        try {
          const result = await remove(item.id)
          const notes = result && Array.isArray(result.notes) ? result.notes : []
          setFlash({ ok: true, text: [`Deleted \u201c${item.title || item.id}\u201d. Its link stops working within a few minutes.`, ...notes].join(' ') })
          setConfirming(null)
        } catch (error) {
          setFlash({ ok: false, text: `Could not delete \u201c${item.title || item.id}\u201d: ${String((error && error.message) || error)}` })
        } finally {
          setDeleting(null)
        }
      }
      return h('section', { className: 'gpa-page', 'aria-label': 'Artifacts' },
        h('div', { className: 'gpa-scroll' },
          h('div', { className: 'gpa-content' },
            h('div', { className: 'gpa-head', 'data-window-drag': '' },
              h('h1', null, 'Artifacts'),
              h('button', { type: 'button', className: 'gpa-button', disabled: busy, onClick: refresh, title: 'Also look on GitHub for artifacts published elsewhere' },
                state.status === 'refreshing' ? 'Refreshing…' : 'Refresh')),
            h('p', { className: 'gpa-intro' }, rows.length === 0 ? 'Pages and documents the agent publishes to GitHub Pages.'
              : `${rows.length} published page${rows.length === 1 ? '' : 's'}. Links open in a new tab.`),
            state.status === 'error' ? h('p', { className: 'gpa-notice gpa-error', role: 'alert' }, `Could not load artifacts: ${state.error}`) : null,
            flash ? h('p', { className: flash.ok ? 'gpa-notice' : 'gpa-notice gpa-error', role: flash.ok ? 'status' : 'alert' }, flash.text) : null,
            state.notes.map(note => h('p', { key: note, className: 'gpa-notice' }, note)),
            state.status === 'loading' && rows.length === 0 ? h('div', { className: 'gpa-empty', role: 'status' }, 'Loading…') : null,
            state.status === 'ready' && rows.length === 0
              ? h('div', { className: 'gpa-empty', role: 'status' }, 'Nothing published yet. Ask the agent to make a page and publish it.')
              : null,
            rows.length > 0 ? h('ul', { className: 'gpa-rows', 'aria-label': 'Published artifacts', 'aria-busy': busy },
              rows.map((item) => {
                const href = safeHref(item.url)
                const meta = [
                  item.kind === 'markdown' ? 'Document' : 'Page',
                  item.repository,
                  item.rev > 1 ? `rev ${item.rev}` : undefined,
                  item.updatedAt ? `updated ${formatTime(item.updatedAt)}` : undefined,
                ].filter(Boolean)
                const body = [
                  h(ArtifactsIcon, { key: 'glyph', size: 16, className: 'gpa-glyph' }),
                  h('span', { key: 'body', className: 'gpa-body' },
                    h('span', { className: 'gpa-title' }, item.title || item.id),
                    href ? h('span', { className: 'gpa-link' }, href) : null,
                    item.description ? h('span', { className: 'gpa-summary' }, item.description) : null,
                    h('span', { className: 'gpa-summary' }, meta.map(text => h('span', { key: text, className: 'gpa-meta' }, text)))),
                ]
                const title = item.title || item.id
                const isConfirming = confirming === item.id
                const isDeleting = deleting === item.id
                return h('li', { key: item.id, className: isConfirming ? 'gpa-item gpa-confirming' : 'gpa-item' },
                  h('div', { className: 'gpa-main' },
                    href
                      ? h('a', { className: 'gpa-row', href, target: '_blank', rel: 'noopener noreferrer' }, ...body)
                      : h('div', { className: 'gpa-row' }, ...body),
                    isConfirming ? null : h('div', { className: 'gpa-actions' },
                      h('button', {
                        type: 'button', className: 'gpa-icon-button', disabled: busy,
                        title: 'Delete', 'aria-label': `Delete ${title}`,
                        onClick: () => { setFlash(null); setConfirming(item.id) },
                      }, h(TrashIcon)))),
                  isConfirming ? h('div', { className: 'gpa-confirm', role: 'group', 'aria-label': `Confirm deleting ${title}` },
                    h('span', { className: 'gpa-confirm-text' },
                      `Delete this page from ${item.repository || 'GitHub Pages'}? The link stops working for everyone; the repository history keeps a copy.`),
                    h('button', { type: 'button', className: 'gpa-danger', disabled: isDeleting, onClick: () => confirmDelete(item) },
                      isDeleting ? 'Deleting\u2026' : 'Delete'),
                    h('button', { type: 'button', className: 'gpa-button gpa-small', disabled: isDeleting, onClick: () => setConfirming(null) }, 'Cancel'))
                    : null)
              })) : null)))
    }

    /** Register the sidebar entry and its main panel; returns one disposer. */
    function registerArtifactsPanel(ctx) {
      const Page = props => h(ArtifactsPage, { ...props, ctx })
      const offStyles = installStyles()
      // The main entry first: selecting a sidebar entry needs a 'main' entry with the same key.
      const offMain = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Page))
      // The sidebar draws the button, label, tooltip, and active state; the component is just the glyph.
      const offEntry = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: 'Artifacts',
      }, ArtifactsIcon))
      return () => { offEntry(); offMain(); offStyles() }
    }

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.credentials'],
      apply(ctx) {
        const Page = props => h(ConfigEntry, { ...props, ctx })
        // The page exists while the Host serves this plugin's settings, i.e. while its row runs.
        ctx.effect(() => ctx.configForms.whileServed([NS], () => {
          const offBundle = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PKG }, Page))
          const offRow = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${PKG}#${NS}` }, Page))
          // The sidebar entry lives exactly as long as the plugin's row runs, like the settings page.
          const offPanel = registerArtifactsPanel(ctx)
          return () => { offPanel(); offRow(); offBundle() }
        }), 'gh-pages-artifacts: settings page and artifacts panel')
      },
    }
  },
})
