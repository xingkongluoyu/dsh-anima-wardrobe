/**
 * dsh-anima-wardrobe — 客户端半。
 *
 * 在 Better Sidebar 里注册一个 tab：Anima 面板。
 *   · 模型：全局共享 CLIP / VAE / UNet
 *   · 画幅：图片参数大全（比例、宽高、批次数）+ 采样步数 / CFG
 *   · 提示词：负向词（官方，本流）、自动拼接质量词（本流）
 *   · LoRA 列表（增删改强度）
 *   · 权重：上次出图用的 fields 层滑条 + 权重来源模式 + 「下次沿用」开关
 *   · 出图浏览：单图显示 + 翻页
 *
 * 所有数据读写都走 host 半注册的 /anima-wardrobe/*.json 路由。
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') window.__ModuleLoader__.load({
  id: 'dsh-anima-wardrobe',
  factory(require) {
    const module = { exports: {} }
    // Cordis client entries are CJS-flavoured: the loader calls factory(require) and
    // expects `exports` — declare it, otherwise activate() throws "exports is not defined".
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const R = require('react')
    const React = typeof R?.createElement === 'function' ? R : (R?.default ?? R)
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const PLUGIN_ID = 'anima-wardrobe'
    // 右侧栏（内核 sidebar-right）里的 tab 类型身份。id 必须全局唯一并带包前缀；
    // kind 是分派用的页类型名，openTab(kind) 用它打开。
    const TAB_ID = 'anima-wardrobe:panel'
    const TAB_KIND = 'anima-wardrobe'
    const BASE = '/anima-wardrobe'

    /* ------------------------------------------------------------------ fetch ---- */

    async function getJson(path) {
      const res = await fetch(path, { cache: 'no-store' })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body || body.ok === false) {
        throw new Error(body?.reason || `HTTP ${res.status}`)
      }
      return body
    }

    async function postJson(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok || !payload || payload.ok === false) {
        throw new Error(payload?.reason || `HTTP ${res.status}`)
      }
      return payload
    }

    /* ------------------------------------------------------------------- utils ---- */

    const NUM = (value, fallback = 0) => {
      const n = Number(value)
      return Number.isFinite(n) ? n : fallback
    }

    const hasWeight = (value) => Math.abs(NUM(value, 1) - 1) > 1e-9

    function weightCount(weights) {
      let n = 0
      for (const layer of ['sections', 'fields']) {
        for (const value of Object.values(weights?.[layer] ?? {})) if (hasWeight(value)) n += 1
      }
      for (const sub of Object.values(weights?.options ?? {})) {
        for (const value of Object.values(sub ?? {})) if (hasWeight(value)) n += 1
      }
      return n
    }

    /* ------------------------------------------------------------------- styles --- */

    const CSS = `
.aw-root{height:100%;min-height:0;display:flex;flex-direction:column;font-size:12px;line-height:1.45;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent)}
.aw-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:0 0 auto}
.aw-title{font-weight:600;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-tertiary)}
.aw-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary)}
.aw-dot[data-on="0"]{background:var(--dsw-alias-state-error-primary)}
.aw-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;padding:0}
.aw-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aw-viewer{flex:0 0 auto;padding:6px 10px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.aw-shot{position:relative;display:flex;align-items:center;justify-content:center;height:min(34vh,260px);
  border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.aw-shot img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.aw-shot-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center;padding:0 12px}
.aw-shot-bar{display:flex;align-items:center;gap:6px;margin-top:5px}
.aw-shot-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary);font-size:11px}
.aw-body{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 14px}
.aw-sect{margin-bottom:12px}
.aw-sect-head{display:flex;align-items:center;gap:6px;margin:2px 0 6px}
.aw-sect-title{font-size:11px;font-weight:600;letter-spacing:.05em;color:var(--dsw-alias-label-secondary);text-transform:uppercase;flex:1}
.aw-sect-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.aw-row{display:flex;align-items:center;gap:6px;margin-bottom:5px}
.aw-row>.aw-lbl{flex:0 0 62px;color:var(--dsw-alias-label-secondary);font-size:11px}
.aw-row>.aw-grow{flex:1;min-width:0}
.aw-inline{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.aw-inline.aw-dim{opacity:.55}
.aw-inline>.aw-type{flex:0 0 108px;min-width:0;display:flex}
.aw-inline>.aw-shift{flex:0 0 62px;min-width:0;display:flex}
.aw-mode{flex:0 0 auto;border-radius:999px;padding:2px 8px;font:inherit;font-size:10px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.aw-mode[data-on="1"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;
  color:var(--dsw-alias-button-primary-label,#fff);font-weight:600}
.aw-in,.aw-sel,.aw-ta{background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;
  border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 6px;min-width:0}
.aw-sel{flex:1}
.aw-in{width:100%}
.aw-in[type=number]{text-align:right;padding-right:4px}
.aw-ta{width:100%;resize:vertical;min-height:54px;line-height:1.45;font-family:inherit}
.aw-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;border-radius:6px;padding:4px 9px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:inherit;
  font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.aw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.aw-btn:disabled{opacity:.5;cursor:default}
.aw-btn[data-variant=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-primary-label,#fff);
  border-color:transparent;font-weight:600}
.aw-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.aw-btn[data-variant=ghost]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.aw-btn[data-variant=danger]{color:var(--dsw-alias-danger);border-color:transparent;background:transparent}
.aw-lora{display:flex;align-items:center;gap:5px;margin-bottom:5px}
.aw-lora>.aw-sel{flex:1}
.aw-lora>.aw-in{width:56px;flex:0 0 56px}
.aw-check{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;user-select:none}
.aw-check input{accent-color:var(--dsw-alias-accent);margin:0}
.aw-wlist{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden}
.aw-wrow{display:flex;align-items:center;gap:4px;padding:1px 5px;min-height:23px}
.aw-wrow+.aw-wrow,.aw-wadd{border-top:1px solid var(--dsw-alias-border-l2)}
.aw-wrow-1{padding-left:14px}
.aw-wrow-2{padding-left:28px}
.aw-wtag{flex:0 0 24px;font-size:9px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.aw-wname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.aw-num{flex:0 0 50px;width:50px;text-align:right;font:inherit;font-size:11px;font-variant-numeric:tabular-nums;
  background:var(--dsw-alias-bg-layer-2);color:inherit;border:1px solid var(--dsw-alias-border-l2);
  border-radius:5px;padding:1px 3px}
.aw-wadd{padding:2px 5px}
.aw-wadd-1{padding-left:14px}
.aw-wadd-2{padding-left:28px}
.aw-wadd>.aw-sel{font-size:11px;padding:2px 4px}
.aw-actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 2px}
.aw-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:6px;word-break:break-all}
.aw-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);
  margin:2px 0 12px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2)}
.aw-err{font-size:11px;color:var(--dsw-alias-state-error-primary);margin-top:6px;word-break:break-all}
.aw-ok{font-size:11px;color:var(--dsw-alias-state-success-primary);margin-top:6px}
.aw-radio{display:flex;flex-direction:column;gap:3px;margin-bottom:6px}
.aw-radio label{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.aw-radio input{accent-color:var(--dsw-alias-accent);margin:0}
.aw-busy{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.aw-launch{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:8px 10px;
  border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.aw-launch>.aw-hint{margin:0;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-launch>a.aw-btn{flex:0 0 auto;text-decoration:none;display:inline-flex;align-items:center}
.aw-spin{width:11px;height:11px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);
  border-top-color:var(--dsw-alias-accent);animation:aw-spin .8s linear infinite}
@keyframes aw-spin{to{transform:rotate(360deg)}}
.aw-foot{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.2;
  cursor:pointer;transition:background .15s,border-color .15s}
.aw-foot:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-accent)}
.aw-foot:active{background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-accent)}
.aw-foot .aw-foot-ico{display:flex;flex:0 0 auto;color:var(--dsw-alias-accent)}
.aw-foot .aw-foot-text{font-weight:600;letter-spacing:.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-foot[data-wide="0"]{justify-content:center;padding:6px 0}
.aw-foot[data-wide="0"] .aw-foot-text{display:none}
`

    function installStyles(ctx) {
      return ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', PLUGIN_ID)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { try { style.remove() } catch { /* ignore */ } }
      }, 'anima-wardrobe:styles')
    }

    /* --------------------------------------------------------------------- UI ---- */

    function Section({ title, note, children }) {
      return h('div', { className: 'aw-sect' },
        h('div', { className: 'aw-sect-head' },
          h('div', { className: 'aw-sect-title' }, title),
          note ? h('div', { className: 'aw-sect-note' }, note) : null),
        children)
    }

    function Row({ label, children }) {
      return h('div', { className: 'aw-row' },
        h('div', { className: 'aw-lbl' }, label),
        h('div', { className: 'aw-grow' }, children))
    }

    function Select({ value, options, onChange, placeholder }) {
      const list = Array.isArray(options) ? options : []
      const known = value === '' || list.includes(value)
      return h('select', { className: 'aw-sel', value: value ?? '', onChange: (event) => onChange(event.target.value) },
        placeholder !== undefined ? h('option', { value: '' }, placeholder) : null,
        known ? null : h('option', { value }, `${value}（未知）`),
        list.map((item) => h('option', { key: item, value: item }, item)))
    }

    // 带自定义标签的下拉：items = [{ value, label }]。
    function Picker({ value, items, onChange, placeholder, disabled }) {
      const list = Array.isArray(items) ? items : []
      const current = value ?? ''
      const known = current === '' || list.some((item) => item.value === current)
      return h('select', {
        className: 'aw-sel',
        value: current,
        disabled: Boolean(disabled),
        onChange: (event) => onChange(event.target.value),
      },
        h('option', { value: '' }, placeholder ?? '—'),
        known ? null : h('option', { value: current }, `${current}（未知）`),
        list.map((item) => h('option', { key: item.value, value: item.value }, item.label)))
    }

    // 互斥开关：同一时刻只有一行是「生效」。
    function ModeButton({ on, onClick, title }) {
      return h('button', {
        type: 'button',
        className: 'aw-mode',
        'data-on': on ? '1' : '0',
        title,
        onClick,
      }, on ? '● 生效' : '○ 选择')
    }

    function FieldLabel(fieldsByKey, key) {
      const field = fieldsByKey?.[key]
      return field ? field.lab : key
    }

    // 权重数字框：0–3，步进 0.1，用原生上下箭头选择（不受控文本，避免小数输入被打断）。
    function NumBox({ value, onChange, min = 0, max = 3, step = 0.1, title }) {
      const initial = (() => { const n = Number(value); return Number.isFinite(n) ? n : 1 })()
      const [text, setText] = useState(String(initial))
      const lastCommit = useRef(initial)
      useEffect(() => {
        const next = (() => { const n = Number(value); return Number.isFinite(n) ? n : 1 })()
        if (Math.abs(next - lastCommit.current) > 1e-9) {
          lastCommit.current = next
          setText(String(next))
        }
      }, [value])
      const apply = (raw) => {
        if (raw === '' || raw === '-' || raw === '+' || raw === '.') {
          setText(raw)
          return
        }
        const n = Number(raw)
        if (!Number.isFinite(n)) return
        const clamped = Math.min(max, Math.max(min, Math.round(n * 100) / 100))
        lastCommit.current = clamped
        setText(raw)
        onChange(clamped)
      }
      return h('input', {
        className: 'aw-num', type: 'number', min, max, step, title, value: text,
        onChange: (event) => apply(event.target.value),
        onBlur: () => setText(String(lastCommit.current)),
      })
    }

    /* ---- 出图浏览 ---- */

    function Viewer({ images, index, onIndex, loading }) {
      const current = images[index] ?? null
      const src = current ? `${BASE}/image.png?rel=${encodeURIComponent(current.rel)}&t=${Math.round(current.mtime ?? 0)}` : ''
      return h('div', { className: 'aw-viewer' },
        h('div', { className: 'aw-shot' },
          current
            ? h('img', { src, alt: current.name, loading: 'lazy' })
            : h('div', { className: 'aw-shot-empty' }, loading ? '读取出图目录…' : '还没有图片')),
        h('div', { className: 'aw-shot-bar' },
          h('button', {
            className: 'aw-icon-btn', title: '上一张（更新）', disabled: index <= 0,
            onClick: () => onIndex(Math.max(0, index - 1)),
          }, '‹'),
          h('button', {
            className: 'aw-icon-btn', title: '下一张（更旧）', disabled: index >= images.length - 1,
            onClick: () => onIndex(Math.min(images.length - 1, index + 1)),
          }, '›'),
          h('div', { className: 'aw-shot-name' }, current ? current.rel : '—'),
          h('div', { className: 'aw-shot-name', style: { flex: '0 0 auto' } },
            images.length ? `${index + 1} / ${images.length}` : '0 / 0')))
    }

    /* ---- 主面板 ---- */

    function StudioPanel({ visible }) {
      const [options, setOptions] = useState(null)
      const [state, setState] = useState(null)
      const [images, setImages] = useState([])
      const [index, setIndex] = useState(0)
      const [online, setOnline] = useState(false)
      const [loadingImages, setLoadingImages] = useState(true)
      const [busy, setBusy] = useState(false)
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')
      const [addSection, setAddSection] = useState('')
      const [addFieldFor, setAddFieldFor] = useState('')
      const [addOptionFor, setAddOptionFor] = useState('')
      const [launching, setLaunching] = useState(false)
      const [launchSeconds, setLaunchSeconds] = useState(0)
      const [stopping, setStopping] = useState(false)
      const [presetName, setPresetName] = useState('')
      const [presetPick, setPresetPick] = useState('')

      // 角色库：作品 IP 下拉 + 该作品下的角色下拉（数据来自 host 的 options.json）。
      const works = Array.isArray(options?.works) ? options.works : []
      const characters = Array.isArray(options?.characters) ? options.characters : []
      const workPick = state?.workPick ?? ''
      const roleMode = state?.roleMode === 'work' ? 'work' : 'role'
      const workItems = useMemo(
        () => works.map((w) => ({
          value: w.id || w.en,
          label: w.zh && w.zh !== w.en ? `${w.zh}（${w.count}）` : `${w.en}（${w.count}）`,
        })),
        [works],
      )
      const charItems = useMemo(() => {
        // 没选作品时只给前 200 个，避免一次渲染两千多个选项；选了作品就是该 IP 全集。
        const pool = workPick
          ? characters.filter((c) => c.workId === workPick || c.work === workPick)
          : characters.slice(0, 200)
        return pool.map((c) => ({
          value: c.trigger,
          label: c.zh ? `${c.zh} · ${c.trigger}` : c.trigger,
        }))
      }, [characters, workPick])

      const timer = useRef(null)
      const pending = useRef(null)
      const stateRef = useRef(null)
      const mounted = useRef(true)

      useEffect(() => () => { mounted.current = false }, [])

      const currentState = useCallback(() => stateRef.current ?? state, [state])

      const applyState = useCallback((next) => {
        stateRef.current = next
        setState(next)
      }, [])

      const loadImages = useCallback(async () => {
        try {
          const body = await getJson(`${BASE}/images.json`)
          if (!mounted.current) return
          const list = Array.isArray(body.images) ? body.images : []
          setImages(list)
          setIndex((prev) => (prev >= list.length ? 0 : prev))
        } catch (err) {
          if (mounted.current) setError(String(err?.message ?? err))
        } finally {
          if (mounted.current) setLoadingImages(false)
        }
      }, [])

      const loadAll = useCallback(async () => {
        setError('')
        try {
          const [opt, st] = await Promise.all([
            getJson(`${BASE}/options.json`),
            getJson(`${BASE}/state.json`),
          ])
          if (!mounted.current) return
          setOptions(opt)
          setOnline(Boolean(opt.online))
          applyState(st.state)
        } catch (err) {
          if (mounted.current) setError(String(err?.message ?? err))
        }
        await loadImages()
      }, [loadImages, applyState])

      useEffect(() => { loadAll() }, [loadAll])

      // 可见时才轮询出图目录。
      useEffect(() => {
        if (!visible) return undefined
        const id = setInterval(loadImages, 15000)
        return () => clearInterval(id)
      }, [visible, loadImages])

      const flush = useCallback(async () => {
        if (!pending.current) return
        const snapshot = pending.current
        pending.current = null
        setSaving(true)
        try {
          const body = await postJson(`${BASE}/state.json`, { settings: snapshot })
          if (!mounted.current) return
          // 请求期间用户可能又改了：只在没有新改动时回灌 host 的规范值。
          if (pending.current === null) applyState(body.state ?? snapshot)
          setMessage('已保存')
        } catch (err) {
          if (mounted.current) setError(`保存失败：${err?.message ?? err}`)
        } finally {
          if (mounted.current) setSaving(false)
        }
      }, [applyState])

      const patch = useCallback((partial) => {
        const prev = stateRef.current
        if (!prev) return
        const next = { ...prev, ...partial }
        applyState(next)
        pending.current = next
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => { flush() }, 500)
      }, [applyState, flush])

      const refreshOptions = useCallback(async () => {
        try {
          const opt = await getJson(`${BASE}/options.json`)
          if (!mounted.current) return opt
          setOptions(opt)
          setOnline(Boolean(opt.online))
          return opt
        } catch (err) {
          if (mounted.current) {
            setOnline(false)
            setError(`读取面板选项失败：${err?.message ?? err}`)
          }
          return null
        }
      }, [])

      /* ---- 启动 ComfyUI（离线时的兜底） ---- */

      const pollRef = useRef({ timer: 0 })

      const stopPoll = useCallback(() => {
        if (pollRef.current.timer) {
          clearTimeout(pollRef.current.timer)
          pollRef.current.timer = 0
        }
      }, [])

      useEffect(() => () => stopPoll(), [stopPoll])

      const pollStatus = useCallback(async () => {
        try {
          const status = await getJson(`${BASE}/status.json`)
          if (!mounted.current) return
          if (status.online) {
            stopPoll()
            setLaunching(false)
            setLaunchSeconds(0)
            setOnline(true)
            setMessage('ComfyUI 已就绪')
            await refreshOptions()
            return
          }
          if (!status.launching) {
            stopPoll()
            setLaunching(false)
            setError(status.logTail
              ? `ComfyUI 启动失败，日志末尾：\n${String(status.logTail).slice(-600)}`
              : 'ComfyUI 启动失败（进程没起来或端口被占）。')
            return
          }
          setLaunchSeconds(status.seconds ?? 0)
          const wait = (status.seconds ?? 0) < 15 ? 500 : (status.seconds ?? 0) < 90 ? 1500 : 3000
          pollRef.current.timer = setTimeout(pollStatus, wait)
        } catch (err) {
          stopPoll()
          setLaunching(false)
          if (mounted.current) setError(`查询启动状态失败：${err?.message ?? err}`)
        }
      }, [refreshOptions, stopPoll])

      const startComfy = useCallback(async () => {
        setError('')
        setMessage('')
        stopPoll()
        setLaunching(true)
        setLaunchSeconds(0)
        try {
          const result = await postJson(`${BASE}/launch.json`, {})
          if (result.error) {
            setLaunching(false)
            setError(`启动失败：${result.error}`)
            return
          }
          if (result.online) {
            setLaunching(false)
            setOnline(true)
            setMessage('ComfyUI 已在线')
            await refreshOptions()
            return
          }
          pollRef.current.timer = setTimeout(pollStatus, 800)
        } catch (err) {
          setLaunching(false)
          setError(`启动失败：${err?.message ?? err}`)
        }
      }, [pollStatus, refreshOptions, stopPoll])

      const stopService = useCallback(async () => {
        setError('')
        setMessage('')
        stopPoll()
        setLaunching(false)
        setLaunchSeconds(0)
        setStopping(true)
        try {
          const result = await postJson(`${BASE}/stop.json`, {})
          if (mounted.current) setOnline(Boolean(result.online))
          await refreshOptions()
          if (!mounted.current) return
          if (result.online) setError(result.reason || '停止失败：8188 端口仍被占用')
          else setMessage('ComfyUI 已停止')
        } catch (err) {
          if (mounted.current) setError(`停止失败：${err?.message ?? err}`)
        } finally {
          if (mounted.current) setStopping(false)
        }
      }, [refreshOptions, stopPoll])

      const generate = useCallback(async () => {
        if (!state) return
        setBusy(true)
        setError('')
        setMessage('')
        try {
          const result = await postJson(`${BASE}/generate.json`, { settings: state })
          if (!mounted.current) return
          setMessage(`出图完成：${result.seconds}s，seed ${result.seed}`)
          setIndex(0)
          await loadImages()
          const fresh = await getJson(`${BASE}/state.json`)
          if (mounted.current && fresh?.state) applyState(fresh.state)
        } catch (err) {
          if (mounted.current) setError(`出图失败：${err?.message ?? err}`)
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [state, loadImages, applyState])

      const writeBack = useCallback(async () => {
        setError('')
        setMessage('')
        try {
          const body = await postJson(`${BASE}/writeback.json`, {})
          if (!mounted.current) return
          setMessage(`已写回工作流 JSON（${(body.changed ?? []).length} 项，备份 ${String(body.backup ?? '').split(/[\\/]/u).pop()}）`)
        } catch (err) {
          if (mounted.current) setError(`写回失败：${err?.message ?? err}`)
        }
      }, [])

      /* ---- LoRA ---- */

      const loraOptions = options?.loras ?? []
      const setLoras = (list) => patch({ loras: list })
      const updateLora = (i, part) => {
        const list = (currentState()?.loras ?? []).map((item, idx) => (idx === i ? { ...item, ...part } : item))
        setLoras(list)
      }

      // LoRA 预设：命名保存整份 lora 列表，之后一键切换。
      const loraPresets = Array.isArray(state?.loraPresets) ? state.loraPresets : []
      const applyPreset = (name) => {
        const hit = (currentState()?.loraPresets ?? []).find((p) => p.name === name)
        if (!hit) return
        setPresetPick(name)
        setLoras((hit.loras ?? []).map((l) => ({ ...l })))
        setMessage(`已应用 LoRA 预设「${name}」`)
      }
      const savePreset = () => {
        const name = presetName.trim()
        if (name === '') { setMessage('先给预设起个名字'); return }
        const cur = currentState()
        const list = (cur?.loraPresets ?? []).filter((p) => p.name !== name)
        list.push({ name, loras: (cur?.loras ?? []).filter((l) => l && l.name) })
        patch({ loraPresets: list })
        setPresetName('')
        setPresetPick(name)
        setMessage(`已保存 LoRA 预设「${name}」`)
      }
      const dropPreset = () => {
        const name = presetPick
        if (name === '') { setMessage('先在下拉里选一个预设'); return }
        const list = (currentState()?.loraPresets ?? []).filter((p) => p.name !== name)
        patch({ loraPresets: list })
        setPresetPick('')
        setMessage(`已删除预设「${name}」`)
      }

      /* ---- 模型档案：每个 UNet 一套 CLIP/VAE/CFG/采样器/调度器/步数 ---- */

      const modelProfiles = state?.modelProfiles ?? {}
      const hasProfile = Boolean(state?.unet && modelProfiles[state.unet])
      const pickUnet = (value) => {
        const profile = modelProfiles[value]
        if (!profile) { patch({ unet: value }); return }
        const cur = currentState()
        patch({
          unet: value,
          clip: { ...(cur?.clip ?? {}), name: profile.clipName, type: profile.clipType },
          vae: profile.vaeName,
          guidance: profile.cfg,
          sampler: profile.sampler,
          scheduler: profile.scheduler,
          steps: profile.steps,
          useAuraFlow: profile.useAuraFlow === true,
          auraFlowShift: profile.auraFlowShift ?? 1,
        })
        setMessage(`已套用「${value}」的档案`)
      }
      const saveProfile = () => {
        const cur = currentState()
        const unet = cur?.unet ?? ''
        if (unet === '') { setMessage('先选一个 UNet 模型'); return }
        const next = {
          ...(cur.modelProfiles ?? {}),
          [unet]: {
            clipName: cur.clip?.name ?? '',
            clipType: cur.clip?.type ?? 'stable_diffusion',
            vaeName: cur.vae ?? '',
            cfg: Number(cur.guidance ?? 1),
            sampler: cur.sampler ?? 'er_sde',
            scheduler: cur.scheduler ?? 'beta',
            steps: Number(cur.steps ?? 25),
            useAuraFlow: cur.useAuraFlow === true,
            auraFlowShift: Number(cur.auraFlowShift ?? 1),
          },
        }
        patch({ modelProfiles: next })
        setMessage(`已保存「${unet}」的档案`)
      }

      /* ---- 权重（三层：sections → fields → options） ---- */

      const panelWeights = state?.panelWeights ?? { sections: {}, fields: {}, options: {} }
      const sectionDefs = options?.sections ?? []
      const fieldOptionMap = options?.fieldOptions ?? {}

      const patchWeights = (mutate) => {
        const base = currentState()?.panelWeights ?? { sections: {}, fields: {}, options: {} }
        const next = {
          sections: { ...(base.sections ?? {}) },
          fields: { ...(base.fields ?? {}) },
          options: { ...(base.options ?? {}) },
        }
        mutate(next)
        patch({ panelWeights: next })
      }

      const setWeight = (layer, key, value, ownerKey) => patchWeights((next) => {
        if (layer === 'sections') next.sections[key] = value
        else if (layer === 'fields') next.fields[key] = value
        else next.options[ownerKey] = { ...(next.options[ownerKey] ?? {}), [key]: value }
      })

      const dropWeight = (layer, key, ownerKey) => patchWeights((next) => {
        if (layer === 'sections') {
          delete next.sections[key]
          return
        }
        if (layer === 'fields') {
          delete next.fields[key]
          delete next.options[key]
          return
        }
        const sub = { ...(next.options[ownerKey] ?? {}) }
        delete sub[key]
        if (Object.keys(sub).length === 0) delete next.options[ownerKey]
        else next.options[ownerKey] = sub
      })

      // 把三层权重整理成「段 → 字段 → 选项」的树，只列出有值的项。
      const weightRows = useMemo(() => {
        const secW = panelWeights.sections ?? {}
        const fldW = panelWeights.fields ?? {}
        const optW = panelWeights.options ?? {}
        const rows = []
        for (const section of sectionDefs) {
          const children = []
          for (const field of section.fields ?? []) {
            const tags = Object.keys(optW[field.key] ?? {})
            if (fldW[field.key] === undefined && tags.length === 0) continue
            children.push({ field, weight: fldW[field.key], tags })
          }
          if (secW[section.id] === undefined && children.length === 0) continue
          rows.push({ section, weight: secW[section.id], children })
        }
        return rows
      }, [sectionDefs, panelWeights])

      const renderWeights = () => {
        const out = []
        for (const row of weightRows) {
          const sec = row.section
          out.push(h('div', { className: 'aw-wrow', key: `s:${sec.id}` },
            h('span', { className: 'aw-wtag' }, '段'),
            h('span', { className: 'aw-wname', title: sec.id }, sec.title),
            h(NumBox, { value: NUM(row.weight, 1), onChange: (value) => setWeight('sections', sec.id, value) }),
            h('button', {
              className: 'aw-icon-btn', title: addFieldFor === sec.id ? '收起' : '在段下加字段',
              onClick: () => {
                setAddOptionFor('')
                setAddFieldFor(addFieldFor === sec.id ? '' : sec.id)
              },
            }, '+'),
            h('button', {
              className: 'aw-icon-btn', title: '移除该段',
              onClick: () => dropWeight('sections', sec.id),
            }, '×')))
          if (addFieldFor === sec.id) {
            out.push(h('div', { className: 'aw-wadd aw-wadd-1', key: `sf:${sec.id}` },
              h(Picker, {
                value: '',
                items: (sec.fields ?? []).map((field) => ({ value: field.key, label: `${field.lab}（${field.key}）` })),
                placeholder: '选择要加权重的字段…',
                onChange: (value) => {
                  setAddFieldFor('')
                  if (value) setWeight('fields', value, 3)
                },
              })))
          }
          for (const child of row.children) {
            const field = child.field
            out.push(h('div', { className: 'aw-wrow aw-wrow-1', key: `f:${field.key}` },
              h('span', { className: 'aw-wtag' }, '字段'),
              h('span', { className: 'aw-wname', title: field.key }, field.lab),
              h(NumBox, { value: NUM(child.weight, 1), onChange: (value) => setWeight('fields', field.key, value) }),
              h('button', {
                className: 'aw-icon-btn', title: addOptionFor === field.key ? '收起' : '在字段下加选项',
                onClick: () => {
                  setAddFieldFor('')
                  setAddOptionFor(addOptionFor === field.key ? '' : field.key)
                },
              }, '+'),
              h('button', {
                className: 'aw-icon-btn', title: '移除该字段',
                onClick: () => dropWeight('fields', field.key),
              }, '×')))
            if (addOptionFor === field.key) {
              const pairs = fieldOptionMap[field.key] ?? []
              out.push(h('div', { className: 'aw-wadd aw-wadd-2', key: `fo:${field.key}` },
                h(Picker, {
                  value: '',
                  items: pairs
                    .map((pair) => ({
                      value: String(pair?.[1] ?? '').trim().toLowerCase(),
                      label: `${pair?.[0] ?? ''}（${pair?.[1] ?? ''}）`,
                    }))
                    .filter((item) => item.value !== ''),
                  placeholder: '选择要加权重的选项…',
                  onChange: (value) => {
                    setAddOptionFor('')
                    if (value) setWeight('options', value, 3, field.key)
                  },
                })))
            }
            const pairs = fieldOptionMap[field.key] ?? []
            for (const tag of child.tags) {
              const hit = pairs.find((pair) => String(pair?.[1] ?? '').trim().toLowerCase() === tag)
              out.push(h('div', { className: 'aw-wrow aw-wrow-2', key: `o:${field.key}:${tag}` },
                h('span', { className: 'aw-wtag' }, '选项'),
                h('span', { className: 'aw-wname', title: tag }, hit ? hit[0] : tag),
                h(NumBox, {
                  value: NUM((panelWeights.options?.[field.key] ?? {})[tag], 1),
                  onChange: (value) => setWeight('options', tag, value, field.key),
                }),
                h('button', {
                  className: 'aw-icon-btn', title: '移除该选项',
                  onClick: () => dropWeight('options', tag, field.key),
                }, '×')))
            }
          }
        }
        return out
      }

      if (!state) {
        return h('div', { className: 'aw-root' },
          h('div', { className: 'aw-head' }, h('div', { className: 'aw-title' }, 'Anima 面板')),
          h('div', { className: 'aw-body' },
            error ? h('div', { className: 'aw-err' }, error) : h('div', { className: 'aw-hint' }, '读取插件状态…')))
      }

      /* ---- 渲染 ---- */

      return h('div', { className: 'aw-root' },
        h('div', { className: 'aw-head' },
          h('span', { className: 'aw-dot', 'data-on': online ? '1' : '0', title: online ? 'ComfyUI 在线' : 'ComfyUI 离线' }),
          h('div', { className: 'aw-title' }, 'Anima 面板'),
          saving ? h('div', { className: 'aw-busy' }, h('span', { className: 'aw-spin' })) : null,
          h('button', { className: 'aw-icon-btn', title: '刷新可选项', onClick: refreshOptions }, '⟳'),
          h('button', { className: 'aw-icon-btn', title: '重新读取出图', onClick: loadImages }, '⭘')),

        h(Viewer, { images, index, onIndex: setIndex, loading: loadingImages }),

        h('div', { className: 'aw-body' },
          options?.warn ? h('div', { className: 'aw-hint' }, options.warn) : null,
          h(Section, { title: '模型' },
            h(Row, { label: 'CLIP' },
              h('div', { className: 'aw-inline' },
                h(Select, {
                  value: state.clip?.name ?? '',
                  options: options?.clip ?? [],
                  placeholder: '(未设置)',
                  onChange: (value) => patch({ clip: { ...state.clip, name: value } }),
                }),
                h('div', { className: 'aw-type', title: 'CLIP 加载器的 type（不同模型必须选对）' },
                  h(Select, {
                    value: state.clip?.type ?? 'stable_diffusion',
                    options: options?.clipType ?? [],
                    onChange: (value) => patch({ clip: { ...state.clip, type: value } }),
                  })))),
            h(Row, { label: 'VAE' },
              h(Select, {
                value: state.vae ?? '',
                options: options?.vae ?? [],
                placeholder: '(未设置)',
                onChange: (value) => patch({ vae: value }),
              })),
            h(Row, { label: 'UNet' },
              h(Select, {
                value: state.unet ?? '',
                options: options?.unet ?? [],
                placeholder: '(未设置)',
                onChange: pickUnet,
              })),
            h(Row, { label: '档案' },
              h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', minWidth: 0 } },
                h('button', { className: 'aw-btn', onClick: saveProfile }, '保存为当前模型档案'),
                h('span', { className: 'aw-hint', style: { flex: '1', minWidth: 0 } },
                  hasProfile ? '已有档案，切换模型时自动套用' : '还没有档案'))),
            h('div', { className: 'aw-note' },
              '档案存的是这个 UNet 配套的一整套参数：CLIP 名 + CLIP 类型、VAE、CFG、采样器、调度器、步数、采样偏移（AuraFlow 开关与 shift）、VAE 解码方式。下次在下拉里切回这个模型时自动整套套用；没档案的模型只换模型本身，其它参数不动。')),

          h(Section, { title: '图片参数' },
            h(Row, { label: '比例' },
              h(Select, {
                value: state.aspectRatio ?? '',
                options: options?.aspectRatio ?? [],
                onChange: (value) => patch({ aspectRatio: value }),
              })),
            h(Row, { label: '宽 / 高' },
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('input', {
                  className: 'aw-in', type: 'number', min: 64, step: 8, value: state.width ?? 0,
                  onChange: (event) => patch({ width: NUM(event.target.value) }),
                }),
                h('input', {
                  className: 'aw-in', type: 'number', min: 64, step: 8, value: state.height ?? 0,
                  onChange: (event) => patch({ height: NUM(event.target.value) }),
                }))),
            h(Row, { label: '步数 / CFG' },
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('input', {
                  className: 'aw-in', type: 'number', min: 1, max: 100, step: 1, value: state.steps ?? 0,
                  onChange: (event) => patch({ steps: NUM(event.target.value, 25) }),
                }),
                h('input', {
                  className: 'aw-in', type: 'number', min: 0, max: 30, step: 0.1, value: state.guidance ?? 0,
                  onChange: (event) => patch({ guidance: NUM(event.target.value, 1) }),
                }))),
            h(Row, { label: '采样器' },
              h(Picker, {
                value: state.sampler ?? '',
                items: (options?.samplers ?? []).map((name) => ({ value: name, label: name })),
                placeholder: '(默认)',
                onChange: (value) => patch({ sampler: value }),
              })),
            h(Row, { label: '调度器' },
              h(Picker, {
                value: state.scheduler ?? '',
                items: (options?.schedulers ?? []).map((name) => ({ value: name, label: name })),
                placeholder: '(默认)',
                onChange: (value) => patch({ scheduler: value }),
              })),
            h(Row, { label: '采样偏移' },
              h('div', { className: 'aw-inline' },
                h('label', { className: 'aw-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: state.useAuraFlow === true,
                    onChange: (event) => patch({ useAuraFlow: event.target.checked }),
                  }),
                  'AuraFlow'),
                h('div', { className: 'aw-shift' },
                  h(NumBox, {
                    value: state.auraFlowShift ?? 1,
                    min: 0,
                    max: 100,
                    step: 0.1,
                    title: 'shift：MOSS / Flux 常用 3–5；Anima / Qwen 官方模板不带，填 1 或关掉',
                    onChange: (value) => patch({ auraFlowShift: value }),
                  })))),
            h('div', { className: 'aw-note' },
              '给 flow-matching 模型做 sigma 偏移（工作流里的 ModelSamplingAuraFlow 节点，插在 UNet 与 LoRA 之间）。MOSS 官方要求 5，Flux 系常用 3–5；Anima 与 Qwen-Image 的官方模板不带这个节点，保持关闭即可。关掉时该节点整个不提交，不占计算。'),
            h(Row, { label: 'VAE 解码' },
              h('label', { className: 'aw-check', title: '分块解码省显存，但 Qwen-Image-2.1 这类 VAE 会在块边界留下紫色/绿色色偏。默认整块解码。' },
                h('input', {
                  type: 'checkbox',
                  checked: state.useTiledVae === true,
                  onChange: (event) => patch({ useTiledVae: event.target.checked }),
                }),
                '分块（省显存，可能产生色偏）')),
            h('div', { className: 'aw-note' },
              '不勾 = 整块解码（VAEDecode）：一次把整张 latent 解出来，画质干净，但占显存。勾上 = 分块解码（XB_VAEDecodeTiledImage，320/32）：按 320px 小块逐步解，省显存，代价是块边界可能留下紫色或绿色色带 —— Qwen-Image-2.1 这类 VAE 尤其明显。默认整块。'),
            h(Row, { label: '张数' },
              h('input', {
                className: 'aw-in', type: 'number', min: 1, max: 8, step: 1, value: state.batchSize ?? 1,
                onChange: (event) => patch({ batchSize: Math.max(1, NUM(event.target.value, 1)) }),
              }))),

          h(Section, { title: '提示词' },
            h('div', { style: { marginBottom: '4px' } },
              h('div', { className: 'aw-lbl', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', marginBottom: '2px' } }, '负向词（官方，本流）'),
              h('textarea', {
                className: 'aw-ta', value: state.negative ?? '', spellCheck: false,
                onChange: (event) => patch({ negative: event.target.value }),
              })),
            h('div', null,
              h('div', { className: 'aw-lbl', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', marginBottom: '2px' } }, '自动拼接：官方质量词（本流）'),
              h('textarea', {
                className: 'aw-ta', value: state.quality ?? '', spellCheck: false,
                onChange: (event) => patch({ quality: event.target.value }),
              }))),

          h(Section, { title: 'LoRA', note: `${(state.loras ?? []).length} 个` },
            h(Row, { label: '预设' },
              h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center', minWidth: 0 } },
                h(Picker, {
                  value: presetPick,
                  items: loraPresets.map((p) => ({ value: p.name, label: `${p.name}（${(p.loras ?? []).length}）` })),
                  placeholder: '选择预设…',
                  onChange: applyPreset,
                }),
                h('button', { className: 'aw-icon-btn', title: '删除所选预设', onClick: dropPreset }, '×'))),
            (state.loras ?? []).map((lora, i) => h('div', { className: 'aw-lora', key: `${i}-${lora.name}` },
              h(Select, {
                value: lora.name, options: loraOptions, placeholder: '(选择 LoRA)',
                onChange: (value) => updateLora(i, { name: value }),
              }),
              h('input', {
                className: 'aw-in', type: 'number', min: 0, max: 3, step: 0.05, value: lora.strength ?? 1,
                title: '强度', onChange: (event) => updateLora(i, { strength: NUM(event.target.value, 1), clipStrength: NUM(event.target.value, 1) }),
              }),
              h('button', {
                className: 'aw-icon-btn', title: '移除', onClick: () => setLoras((currentState()?.loras ?? []).filter((_x, idx) => idx !== i)),
              }, '×'),
              h('button', {
                className: 'aw-icon-btn', title: lora.active === false ? '已启用？点击停用' : '点击停用',
                onClick: () => updateLora(i, { active: lora.active === false }),
              }, lora.active === false ? '○' : '●'))),
            h('button', {
              className: 'aw-btn', onClick: () => {
                // 已经有一个空槽就不要再叠一行，避免用户点了两次出现两个「(选择 LoRA)」。
                const list = currentState()?.loras ?? []
                if (list.some((item) => !item?.name)) return
                setLoras([...list, { name: '', strength: 1, clipStrength: 1, active: true }])
              },
            }, '+ 添加 LoRA'),
            h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center', marginTop: '5px', minWidth: 0 } },
              h('input', {
                className: 'aw-in', type: 'text', value: presetName, placeholder: '预设名字…',
                style: { flex: '1', minWidth: 0, width: 'auto' },
                onChange: (event) => setPresetName(event.target.value),
              }),
              h('button', { className: 'aw-btn', onClick: savePreset }, '存为预设'))),

          h(Section, { title: '提示词权重', note: `${weightCount(panelWeights)} 项` },
            h('label', { className: 'aw-check', style: { marginBottom: '5px' } },
              h('input', {
                type: 'checkbox', checked: state.followPanel !== false,
                onChange: (event) => patch({ followPanel: event.target.checked }),
              }),
              '模型参考页面配置（关掉 = 只用模型自己传的权重）'),
            h('div', { className: 'aw-hint', style: { marginBottom: '5px' } },
              '0 = 关闭 · 1 = 默认（不写） · 3 = 必现'),
            h('div', { className: 'aw-wlist' },
              weightRows.length === 0
                ? h('div', { className: 'aw-hint', style: { padding: '6px' } }, '还没有配置。点下方「添加段」，再逐层加字段和选项。')
                : renderWeights()),
            h('div', { className: 'aw-row', style: { marginTop: '6px' } },
              h(Picker, {
                value: '',
                items: sectionDefs.map((s) => ({ value: s.id, label: `${s.title}（${s.id}）` })),
                placeholder: '+ 添加段…',
                onChange: (value) => {
                  if (value) setWeight('sections', value, 3)
                },
              }))),

          h(Section, { title: 'Anima 参数' },
            h(Row, { label: '作品 IP' },
              h('div', { className: `aw-inline${roleMode === 'work' ? '' : ' aw-dim'}` },
                h(Picker, {
                  value: workPick,
                  items: workItems,
                  placeholder: works.length ? '不限定作品' : '角色库未加载',
                  disabled: !works.length,
                  onChange: (value) => patch({ workPick: value, charPick: '', roleMode: value ? 'work' : 'role' }),
                }),
                h(ModeButton, {
                  on: roleMode === 'work',
                  title: '让「限定作品 IP」生效，同时角色选择不参与',
                  onClick: () => patch({ roleMode: 'work' }),
                }))),
            h(Row, { label: '角色' },
              h('div', { className: `aw-inline${roleMode === 'role' ? '' : ' aw-dim'}` },
                h(Picker, {
                  value: state.charPick ?? '',
                  items: charItems,
                  placeholder: workPick ? '该作品下随机' : (characters.length ? '不指定角色' : '角色库未加载'),
                  disabled: !characters.length,
                  onChange: (value) => patch({ charPick: value, roleMode: 'role' }),
                }),
                h(ModeButton, {
                  on: roleMode === 'role',
                  title: '让「已选角色」生效，同时作品 IP 限定不参与',
                  onClick: () => patch({ roleMode: 'role' }),
                }))),
            h(Row, { label: '特征' },
              h('label', { className: 'aw-check' },
                h('input', {
                  type: 'checkbox', checked: state.roleFeature !== false,
                  onChange: (event) => patch({ roleFeature: event.target.checked }),
                }),
                '补齐角色特征 tag（狐耳 / 多尾 / 双色发…）')),
            h(Row, { label: '外观' },
              h('label', { className: 'aw-check' },
                h('input', {
                  type: 'checkbox', checked: state.appearanceFollow !== false,
                  onChange: (event) => patch({ appearanceFollow: event.target.checked }),
                }),
                '跟随角色外观（发色 / 瞳色 / 体型，会盖过权重里的发色）')),
            h(Row, { label: '干爽' },
              h('label', { className: 'aw-check', title: 'V6 输入 dry_skin_filter：禁止汗 / 湿润类标签' },
                h('input', {
                  type: 'checkbox', checked: state.drySkinFilter === true,
                  onChange: (event) => patch({ drySkinFilter: event.target.checked }),
                }),
                '禁止汗 / 湿润类标签（V6）')),
            h(Row, { label: '双女' },
              h('label', { className: 'aw-check', title: 'V6 输入 duo_role_fill：只选 1 位角色画多人时，自动补同作品另一位女性' },
                h('input', {
                  type: 'checkbox', checked: state.duoRoleFill !== false,
                  onChange: (event) => patch({ duoRoleFill: event.target.checked }),
                }),
                '双女自动补位（V6）')),
            h(Row, { label: '档位' },
              h(Select, {
                value: state.nsfwLevel ?? 'sfw', options: options?.nsfwLevel ?? [],
                onChange: (value) => patch({ nsfwLevel: value }),
              })),
            h(Row, { label: '服装' },
              h(Select, {
                value: state.outfitStyle ?? '', options: options?.outfitStyle ?? [],
                onChange: (value) => patch({ outfitStyle: value }),
              })),
            h(Row, { label: '胸围' },
              h(Select, {
                value: state.breastSize ?? '', options: options?.breastSize ?? [],
                onChange: (value) => patch({ breastSize: value }),
              })),
            h(Row, { label: '场景锁' },
              h('input', {
                className: 'aw-in', value: state.forcedScene ?? '',
                placeholder: 'V6：填场景 id 定点锁定，如 sc_cafe_window_rain（留空 = 不锁）',
                title: '写进 weights_json 的 forced.n_canon，优先于整库随机与权重池；仅 AnimaWardrobe V6 生效',
                onChange: (event) => patch({ forcedScene: event.target.value }),
              })),
            h(Row, { label: '额外正文' },
              h('input', {
                className: 'aw-in', value: state.extraBody ?? '', placeholder: '追加到提示词末尾的英文短句',
                onChange: (event) => patch({ extraBody: event.target.value }),
              }))),

          h('div', { className: 'aw-actions' },
            h('button', {
              className: 'aw-btn', 'data-variant': 'primary', disabled: busy || !online, onClick: generate,
            }, busy ? h('span', { className: 'aw-busy' }, h('span', { className: 'aw-spin' }), '出图中…') : '生成一张'),
            h('button', { className: 'aw-btn', onClick: () => flush() }, '立即保存'),
            h('button', { className: 'aw-btn', 'data-variant': 'ghost', onClick: writeBack }, '写回工作流 JSON')),

          message ? h('div', { className: 'aw-ok' }, message) : null,
          error ? h('div', { className: 'aw-err' }, error) : null,
          h('div', { className: 'aw-hint' }, '出图保存在 ComfyUI 的 output 目录；对话内让 AI 出图时说清权重即可。')),

        h('div', { className: 'aw-launch' },
          h('span', {
            className: 'aw-dot',
            'data-on': online ? '1' : '0',
            title: online ? 'ComfyUI 在线' : 'ComfyUI 离线',
          }),
          h('span', { className: 'aw-hint' },
            launching
              ? `正在启动 ComfyUI… ${launchSeconds}s`
              : online ? 'ComfyUI 已连接' : 'ComfyUI 未启动'),
          launching
            ? h('span', { className: 'aw-busy' }, h('span', { className: 'aw-spin' }))
            : (online
              ? h('button', {
                className: 'aw-btn', 'data-variant': 'ghost', disabled: stopping,
                title: '结束 8188 端口上的 ComfyUI 进程',
                onClick: stopService,
              }, stopping ? '停止中…' : '停止')
              : h('button', {
                className: 'aw-btn', 'data-variant': 'primary', onClick: startComfy,
              }, '启动 ComfyUI')),
          h('a', {
            className: 'aw-btn',
            'data-variant': 'ghost',
            href: 'http://127.0.0.1:8188',
            target: '_blank',
            rel: 'noreferrer',
            title: '在新标签页打开 ComfyUI 界面',
          }, '打开 ComfyUI 界面')))
    }

    /* ------------------------------------------------------------------- 注册 ---- */

    // 诊断上报：客户端激活/注册出的任何问题都写一行到 host，重启后能直接读到原因。
    function describeDiag(detail) {
      if (detail == null) return ''
      if (typeof detail === 'string') return detail
      if (detail instanceof Error) return String(detail.stack ?? detail.message ?? detail)
      try {
        return JSON.stringify(detail, (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value))
      } catch {
        return String(detail)
      }
    }

    function reportDiag(stage, detail) {
      try {
        fetch(`${BASE}/diag.json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, detail: describeDiag(detail) }),
          cache: 'no-store',
          keepalive: true,
        }).catch(() => {})
      } catch { /* 上报本身绝不允许再抛 */ }
    }

    // ctx.effect 在客户端上下文里不一定存在；缺失时退化成「直接执行一次」。
    function safeEffect(ctx, callback, id) {
      try {
        if (typeof ctx?.effect === 'function') return ctx.effect(callback, id)
      } catch (error) {
        reportDiag('effect', error)
      }
      try {
        return callback()
      } catch (error) {
        reportDiag('effect-run', error)
        return undefined
      }
    }

    // 右侧栏 tab 打开时才会渲染这块；轮询本身很轻（15 秒一次小 JSON），先不按可见性门控。
    function PanelBody() {
      return h(StudioPanel, { visible: true })
    }

    function PanelTitle() {
      return h('span', null, 'Anima')
    }

    function AnimaIcon(size) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 17.5 9.2 6.6a1 1 0 0 1 1.8 0l2.2 4.7 1.5-2.9a1 1 0 0 1 1.8 0L20 17.5',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('circle', { cx: 12, cy: 17.5, r: 1.6, fill: 'currentColor' }))
    }

    let pluginCtx = null

    /** 打开右侧栏里的 Anima 面板：先打开 tab，再把右栏展开。 */
    function openStudio() {
      const ctx = pluginCtx
      try {
        if (typeof ctx?.sidebarRight?.openTab === 'function') {
          ctx.sidebarRight.openTab(TAB_KIND, { replaceTab: true })
        } else {
          reportDiag('open-tab', 'sidebarRight.openTab 不可用')
        }
      } catch (error) {
        reportDiag('open-tab', error)
      }
      try {
        if (typeof ctx?.layout?.openRightbar === 'function') ctx.layout.openRightbar(false, false)
      } catch (error) {
        reportDiag('open-rightbar', error)
      }
    }

    /** 左侧边栏底部、设置按钮旁的入口。owner 只下发 { wide }，视觉走 .aw-foot。 */
    function SidebarFootButton(props) {
      const wide = props?.wide !== false
      return h('button', {
        type: 'button',
        className: 'aw-foot',
        'data-wide': wide ? '1' : '0',
        title: '打开 Anima 面板（右侧栏）',
        'aria-label': '打开 Anima 面板',
        onClick: openStudio,
      },
      h('span', { className: 'aw-foot-ico' }, AnimaIcon(18)),
      h('span', { className: 'aw-foot-text' }, 'Anima'))
    }

    function registerPanel(ctx) {
      pluginCtx = ctx
      try {
        installStyles(ctx)
      } catch (error) {
        reportDiag('styles', error)
      }
      // 1) 声明 tab 类型：只注册 slot body 而不注册类型，tab 是打不开的。
      safeEffect(ctx, () => {
        try {
          const dispose = ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => 'Anima',
            keepMounted: true,
          })
          reportDiag('tab-type', { id: TAB_ID, kind: TAB_KIND, disposeType: typeof dispose })
          return typeof dispose === 'function' ? dispose : undefined
        } catch (error) {
          reportDiag('tab-type-error', error)
          return undefined
        }
      }, 'anima-wardrobe:tab-type')
      // 2) 面板主体与标题
      safeEffect(ctx, () => ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, PanelBody)), 'anima-wardrobe:pane')
      safeEffect(ctx, () => ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, PanelTitle)), 'anima-wardrobe:pane-title')
      // 3) 左侧边栏底部的入口按钮
      safeEffect(ctx, () => ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'anima-wardrobe:open', order: 40, label: () => 'Anima' }, SidebarFootButton)), 'anima-wardrobe:launcher')
    }

    function apply(ctx) {
      try {
        if (!ctx) return
        // Cordis 的 ctx 是 Proxy：只有写进 inject 的服务才能读，否则直接抛
        // `cannot get property "X" without inject`。这些服务都在 inject 里，
        // Cordis 会等到它们就绪后才调用 apply。
        let tabs
        try {
          tabs = ctx.sidebarRightTabs
        } catch {
          tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined
        }
        reportDiag('apply', {
          hasSidebarRightTabs: Boolean(tabs),
          hasRegister: typeof tabs?.register,
          hasSlots: typeof ctx.slots?.register,
          hasEffect: typeof ctx.effect,
        })
        if (tabs && typeof tabs.register === 'function') {
          registerPanel(ctx)
          return
        }
        reportDiag('no-sidebar-right', 'sidebarRightTabs 服务不可用，面板未注册')
      } catch (error) {
        // 绝不外抛：客户端入口的 activate 失败会让整个 web 启动被判为失败。
        reportDiag('apply-fatal', error)
      }
    }

    exports.name = PLUGIN_ID
    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'layout']
    exports.apply = apply
    return module.exports
  },
})
