/**
 * dsh-anima-wardrobe — Host half
 *
 * 两件事：
 *   1. 提供 `anima_draw` 工具：按面板设置 / 工具参数改写 AnimaWardrobe V5 工作流的
 *      API 格式模板，提交给本机 ComfyUI，出图后把文件登记为本次 Turn 的交付物。
 *   2. 提供面板用 HTTP 接口：可选项、面板设置、上次生成使用的权重、出图列表与字节、
 *      页面内生成、写回用户的 UI 格式工作流 JSON。
 *
 * 状态保存在 $DSH_HOME/anima-wardrobe.json；模板与字段清单在包内 templates/。
 */

import { promises as fsp, openSync, closeSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '.'
const DSH_HOME = process.env.DSH_HOME ?? path.join(HOME, '.dsh')
const APPDATA = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming')

/** 工作流里我们用到的节点 id（模板与 UI JSON 共用）。 */
const normalizeWorkflowName = (file) => {
  const text = String(file ?? '').trim()
  if (!text) return ''
  const parts = text.split(/[\\/]/u)
  return parts[parts.length - 1] || ''
}

const NID = {
  clip: '1002',
  vae: '1003',
  crText: '1004',
  seed: '1006',
  ctx: '1032',
  unet: '1033',
  quality: '1034',
  positive: '1035',
  negative: '1036',
  save: '1039',
  trigger: '1075',
  concat: '1076',
  // 分块 VAE 解码（XB 插件）。Qwen-Image-2.1 这类 VAE 在块边界会留下色偏，
  // 所以默认走下面的 decodePlain，需要省显存时才切回来。
  decode: '1096',
  // 整块 VAE 解码（ComfyUI 原生）。与 decode 二选一，另一个从提交里删掉。
  decodePlain: '1152',
  sage: '1100',
  // 采样偏移（AuraFlow shift），插在 UNET → SageAttention 之间；不用时整个节点从提交里删掉。
  auraFlow: '1150',
  sampler: '1104',
  params: '1116',
  latent: '1117',
  lora: '1142',
  anima: '1145',
  // PreviewAny：只把 1145 的第 2 个输出（report 文本）回传到 /history，不产图。
  report: '1151',
}

const DEFAULT_NEGATIVE = 'lowres,bad anatomy,(worst quality:1.8),low quality,hands bad,(normal quality:1.3),bad hands,mutated hands and fingers,extra finger,extra legs,duplicate,cropped,jpeg,artifacts,long body,mutated,disfigured,bad proportions,bad feet,ugly,text font ui,missing limb,black bars, ugly hands, extra fingers,logo,patreon username, text,watermark, extra toes,walls,'
const DEFAULT_QUALITY = 'masterpiece, best quality, score_9, score_8, highres, absurdres, anime screenshot, official art'

const DEFAULTS = {
  comfyUrl: 'http://127.0.0.1:8188',
  outputRoot: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\output',
  imageRelDir: '图片/Anima/ANIMA12',
  workflowFile: 'C:\\Users\\pc\\Downloads\\V5-Anima_miaomiaoHarem_anima.json',
  workflowFileComfy: '',
  templateFile: '',
  fieldsFile: '',
  // 角色库位置：留空 = 自动在下面的 ROSTER_FALLBACKS 里找（V6 优先，再 V5）。
  charactersFile: '',
  // AnimaWardrobe 的 presets 目录（含 outfit_library.json / character_outfits.json）。
  // 留空 = 自动探测 Comfyui-Anima-Wardrobe-V6 → V5。
  presetDir: '',
  timeoutMs: 900000,
  pollIntervalMs: 1200,
  statePath: path.join(DSH_HOME, 'anima-wardrobe.json'),
  diagPath: path.join(DSH_HOME, 'anima-wardrobe-diag.log'),
  // 「一键启动 ComfyUI」用：Desktop 的数据目录 + 可执行文件覆盖项（留空则自动推导）。
  desktopHome: path.join(APPDATA, 'Comfy Desktop'),
  comfyPython: '',
  comfyWorkdir: '',
  comfyArgs: '',
  // ComfyUI 会在 Host 与 Origin 域名不一致时返回 403（server.py:214-233）。
  // 把 ComfyUI 嵌进面板 iframe 时 Origin 就是 DSH 的地址，必然不一致 → 整页 403。
  // 加 --enable-cors-header 会让 ComfyUI 换用 CORS 中间件、不再做这个校验；
  // 只想自己用就别改，介意的话设成 false（面板里仍可用「新窗口」）。
  comfyCors: true,
  launchLogPath: path.join(DSH_HOME, 'anima-wardrobe-comfy.log'),
  workflowId: 'anima-wardrobe',
}

const NSFW_LEVELS = ['sfw', 'suggestive', 'explicit', 'hardcore', 'extreme', 'any']

/** 引擎的默认权重（1 = 不写进 weights_json）。 */
const DEFAULT_WEIGHT = 1

/**
 * 「人物特征」字段 —— 与 AnimaWardrobe V5 的 `anima_v4_rules.py:2884 CHAR_APPEAR_FIELDS` 完全一致。
 *
 * 引擎的规则是：只要 `role_pick=True`（这一抽会抽角色），这些字段的「选项必现池」就被清空
 * （rules.py:3890 `_forced = [] if (role_pick and key in CHAR_APPEAR_FIELDS)`），
 * 因为外貌归角色官方设定。问题是「用户没指定角色、引擎从全库随机抽一个」也走这个分支，
 * 于是发色 / 瞳色 / 发型的权重被静默忽略（bug 报告 B1）。
 *
 * 我们的对策：没指定角色、但权重里动了这些字段时，自动把 role_pick 设成 false（纯词库人物）。
 */
const CHAR_APPEAR_FIELDS = [
  'hair_color', 'eyes_color', 'figure', 'skin', 'face_shape',
  'hair_len', 'hair_tie', 'hair_curl', 'hair_acc',
]

/** 段 id 白名单（`anima_v4_pools.json` 的 15 个 section，顺序即面板顺序）。 */
const SECTION_IDS = [
  'count', 'hair', 'face', 'body', 'makeup', 'cloth_sfw', 'cloth_nsfw',
  'pose_sfw', 'pose_nsfw', 'scene', 'camera', 'lighting', 'special_nsfw', 'canon', 'nl_block',
]

const diagnostics = { lastDelivery: null, lastError: '' }

export const name = 'anima-wardrobe'

/* ------------------------------------------------------------------ helpers ---- */

function makeLog(root) {
  return (level, message) => {
    const line = `[anima-wardrobe] ${message}`
    try {
      const logger = root?.logger ?? root?.log
      if (logger && typeof logger[level] === 'function') {
        logger[level](line)
        return
      }
    } catch { /* fall through */ }
    if (level === 'warn' || level === 'error') console.warn(line)
    else console.log(line)
  }
}

function nowIso() {
  return new Date().toISOString()
}

function pad(value, size) {
  return String(value).padStart(size, '0')
}

function formatDate(pattern, date = new Date()) {
  const map = {
    yyyy: String(date.getFullYear()),
    yy: String(date.getFullYear()).slice(2),
    MM: pad(date.getMonth() + 1, 2),
    dd: pad(date.getDate(), 2),
    HH: pad(date.getHours(), 2),
    mm: pad(date.getMinutes(), 2),
    ss: pad(date.getSeconds(), 2),
  }
  return pattern.replace(/(yyyy|yy|MM|dd|HH|mm|ss)/gu, (m) => map[m] ?? m)
}

function expandDateTokens(text) {
  if (typeof text !== 'string' || text === '') return text
  return text.replace(/%date:([^%]+)%/gu, (_m, fmt) => formatDate(fmt))
}

function clampWeight(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(3, Math.round(n * 1000) / 1000))
}

/** 只保留非 1.0 项，与 anima_v4_rules.dump_weights 同口径。 */
function compactWeights(weights) {
  const out = {}
  const bag = (source) => {
    const clean = {}
    for (const [k, v] of Object.entries(source ?? {})) {
      const w = clampWeight(v)
      if (w !== null && Math.abs(w - 1) > 1e-9) clean[k] = w
    }
    return clean
  }
  const sections = bag(weights?.sections)
  const fields = bag(weights?.fields)
  if (Object.keys(sections).length > 0) out.sections = sections
  if (Object.keys(fields).length > 0) out.fields = fields
  const options = {}
  for (const [fk, sub] of Object.entries(weights?.options ?? {})) {
    const clean = bag(sub)
    if (Object.keys(clean).length > 0) options[fk] = clean
  }
  if (Object.keys(options).length > 0) out.options = options
  return out
}

function mergeWeights(base, patch) {
  const out = {
    sections: { ...(base?.sections ?? {}) },
    fields: { ...(base?.fields ?? {}) },
    options: {},
  }
  for (const [k, v] of Object.entries(base?.options ?? {})) out.options[k] = { ...v }
  for (const [k, v] of Object.entries(patch?.sections ?? {})) out.sections[k] = v
  for (const [k, v] of Object.entries(patch?.fields ?? {})) out.fields[k] = v
  for (const [fk, sub] of Object.entries(patch?.options ?? {})) {
    out.options[fk] = { ...(out.options[fk] ?? {}), ...(sub ?? {}) }
  }
  return lenient(out)
}

/** 数值化 + 丢弃无法解析的项（权重为 0 也要保留：0 = 关闭）。 */
function lenient(weights) {
  const norm = (source) => {
    const clean = {}
    for (const [k, v] of Object.entries(source ?? {})) {
      const w = clampWeight(v)
      if (w !== null) clean[String(k).trim()] = w
    }
    return clean
  }
  const out = {
    sections: norm(weights?.sections),
    fields: norm(weights?.fields),
    options: {},
  }
  for (const [fk, sub] of Object.entries(weights?.options ?? {})) {
    const clean = {}
    for (const [k, v] of Object.entries(sub ?? {})) {
      const w = clampWeight(v)
      if (w !== null) clean[String(k).trim().toLowerCase()] = w
    }
    if (Object.keys(clean).length > 0) out.options[fk] = clean
  }
  return out
}

function countWeights(weights) {
  let n = 0
  n += Object.keys(weights?.sections ?? {}).length
  n += Object.keys(weights?.fields ?? {}).length
  for (const sub of Object.values(weights?.options ?? {})) n += Object.keys(sub ?? {}).length
  return n
}

function isForced(value) {
  return typeof value === 'number' && Math.abs(value - 3) < 1e-9
}

function isOn(value) {
  return typeof value === 'number' && Math.abs(value - DEFAULT_WEIGHT) > 1e-9
}

/**
 * 权重里有没有动过「人物特征」字段（发色 / 瞳色 / 体型 / 肤色 / 脸型 / 发型四件套）。
 * 只要动过，就必须让引擎走「不抽角色」那条路，否则这些权重会被静默忽略。
 */
function appearanceWeightKeys(weights) {
  const hit = new Set()
  for (const [k, v] of Object.entries(weights?.fields ?? {})) {
    if (CHAR_APPEAR_FIELDS.includes(k) && isOn(v)) hit.add(k)
  }
  for (const [fk, sub] of Object.entries(weights?.options ?? {})) {
    if (!CHAR_APPEAR_FIELDS.includes(fk)) continue
    if (Object.values(sub ?? {}).some(isOn)) hit.add(fk)
  }
  return [...hit]
}

/**
 * 把 AnimaV5RandomPrompt 的 report 文本压成几条可读摘要。
 * report 是引擎自己渲染的中文巡检报告（约 2–3K 字），含每字段最终值、`w3.0` 权重标记、所有 notes。
 */
function summarizeReport(text) {
  const out = { weightLine: '', forced: [], weighted: [], warnings: [], notes: [], tagCount: 0 }
  if (typeof text !== 'string' || text === '') return out
  const lines = text.split(/\r?\n/u)
  const grab = (re) => {
    for (const line of lines) {
      const hit = re.exec(line)
      if (hit) return hit
    }
    return null
  }
  const tagHit = grab(/标签数\s*[:：]\s*(\d+)/u)
  if (tagHit) out.tagCount = Number(tagHit[1])
  const s16 = lines.find((line) => line.includes('S16 权重生效'))
  if (s16) {
    const m = /已调\s*(\d+)\s*项权重/u.exec(s16)
    out.weightLine = m ? `已调 ${m[1]} 项权重` : '本次未使用权重（全默认）'
  }
  const forcedHit = grab(/按选项权重\s*3\s*强制出现\s*[:：]\s*(.+)$/u)
  if (forcedHit) out.forced = forcedHit[1].split(/[、,，]/u).map((s) => s.trim()).filter(Boolean)
  for (const line of lines) {
    const t = line.trim()
    const bare = t.replace(/^[·•]\s*/u, '')
    if (bare.startsWith('⚠')) {
      out.warnings.push(bare.replace(/^⚠️?\s*/u, ''))
      continue
    }
    if (bare.includes('未选角色') || bare.includes('外貌对齐') || bare.includes('按选中角色数')) {
      out.notes.push(bare)
    }
  }
  // 调试区形如：`hair_color       L0 w3.0   粉发 = pink hair`
  const reDbg = /^\s{1,}(\w+)\s+L\d+\s+w([\d.]+)\s+(.+)$/u
  for (const line of lines) {
    const m = reDbg.exec(line)
    if (!m) continue
    const w = Number(m[2])
    if (!Number.isFinite(w) || Math.abs(w - DEFAULT_WEIGHT) < 1e-9) continue
    out.weighted.push(`${m[1]} ${m[3].trim()}`)
    if (out.weighted.length >= 12) break
  }
  return out
}

/** 用 templates/fields.json 校验权重里的段 / 字段 / 选项是否存在，返回人话警告。 */
function validateWeights(weights, fields) {
  const warnings = []
  const known = new Map() // fieldKey → Set(英文 tag，已小写)
  for (const section of fields?.sections ?? []) {
    for (const field of section?.fields ?? []) {
      const tags = new Set()
      for (const opt of field?.opts ?? []) {
        if (Array.isArray(opt) && opt.length >= 2) tags.add(String(opt[1]).trim().toLowerCase())
      }
      known.set(String(field?.key ?? ''), tags)
    }
  }
  for (const key of Object.keys(weights?.sections ?? {})) {
    if (!SECTION_IDS.includes(key)) warnings.push(`段「${key}」不存在（可能把字段名写成了段），已忽略`)
  }
  for (const key of Object.keys(weights?.fields ?? {})) {
    if (!known.has(key)) warnings.push(`字段「${key}」不存在，已忽略`)
  }
  for (const [fk, sub] of Object.entries(weights?.options ?? {})) {
    const tags = known.get(fk)
    if (!tags) {
      warnings.push(`选项所属字段「${fk}」不存在，已忽略`)
      continue
    }
    const bad = Object.keys(sub ?? {}).filter((tag) => !tags.has(String(tag).trim().toLowerCase()))
    if (bad.length > 0) {
      warnings.push(`字段「${fk}」没有选项 ${bad.map((b) => `「${b}」`).join('')}（要用英文 tag），已忽略`)
    }
  }
  return warnings
}

/* -------------------------------------------------------------- comfy client ---- */

async function comfyFetch(cfg, url, init, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...(init ?? {}), signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function probeComfy(cfg) {
  try {
    const res = await comfyFetch(cfg, `${cfg.comfyUrl}/system_stats`, { method: 'GET' }, 4000)
    return res.ok
  } catch {
    return false
  }
}

/* ------------------------------------------------------- ComfyUI 一键启动 ---- */

/**
 * Comfy Desktop 自己就是这样起的 ComfyUI（见 asar 里 `pythonPath -s ComfyUI/main.py …`）。
 * Desktop 没有命令行参数、也没有协议能“打开后自动进实例”，所以这里直接拉起本体进程，
 * 参数完全复刻 Desktop 写在 installations.json / settings.json / instance-model-paths 里的值。
 */
let launchState = { pid: 0, since: 0, logPath: '' }

async function resolveLaunchSpec(cfg) {
  const desktopHome = String(cfg.desktopHome ?? '').trim()
  const installs = await readJsonFile(desktopHome ? path.join(desktopHome, 'installations.json') : '')
  const list = Array.isArray(installs) ? installs : []
  const local = list.find((item) => item
    && String(item.id ?? '').startsWith('inst-')
    && String(item.installPath ?? '') !== '')
  const installPath = String(local?.installPath ?? '')
  const workdir = String(cfg.comfyWorkdir ?? '').trim() || installPath
  if (workdir === '') return { error: '没找到 ComfyUI 安装目录（Desktop 的 installations.json 里没有本地实例）' }

  // Desktop 的 installations.json 只知道安装根目录；真正的解释器带 torch 的那个
  // 是 `<安装目录>\ComfyUI\.venv`，而 `<安装目录>\standalone-env` 里没有 torch（实测会 ModuleNotFoundError）。
  const pyRel = process.platform === 'win32'
    ? ['Scripts', 'python.exe']
    : ['bin', 'python3']
  const pythonCandidates = [
    String(cfg.comfyPython ?? '').trim(),
    path.join(workdir, 'ComfyUI', '.venv', ...pyRel),
    path.join(workdir, '.venv', ...pyRel),
    path.join(workdir, 'standalone-env', ...pyRel),
    path.join(workdir, 'python_embeded', 'python.exe'),
  ].filter((item) => item !== '')
  let python = ''
  for (const candidate of pythonCandidates) {
    if (await exists(candidate)) {
      python = candidate
      break
    }
  }
  if (python === '') return { error: `找不到可用的 python（试过 ${pythonCandidates.join(' / ')}）` }

  // python.exe 是控制台程序，detached 起来仍可能弹一个黑框；同目录的 pythonw.exe 没有控制台，
  // 输出照样重定向到日志文件，所以优先用它。
  if (/python\.exe$/iu.test(python)) {
    const pythonw = python.replace(/python\.exe$/iu, 'pythonw.exe')
    if (await exists(pythonw)) python = pythonw
  }

  const mainRel = path.join('ComfyUI', 'main.py')
  if (!(await exists(path.join(workdir, mainRel)))) {
    return { error: `找不到 main.py：${path.join(workdir, mainRel)}` }
  }

  const desktopSettings = await readJsonFile(desktopHome ? path.join(desktopHome, 'settings.json') : '')

  // instance-model-paths 里的 yaml 决定模型搜索目录，少了它模型下拉会和 Desktop 不一致。
  let modelPathsConfig = ''
  const yamlDir = desktopHome ? path.join(desktopHome, 'instance-model-paths') : ''
  if (yamlDir && await exists(yamlDir)) {
    const preferred = local?.id ? `${local.id}.yaml` : ''
    let entries = []
    try {
      entries = await fsp.readdir(yamlDir)
    } catch { /* 目录不可读就跳过 */ }
    const names = entries.filter((name) => name.toLowerCase().endsWith('.yaml'))
    const pickName = names.includes(preferred)
      ? preferred
      : names.sort((a, b) => a.localeCompare(b)).at(-1) ?? ''
    if (pickName !== '') modelPathsConfig = path.join(yamlDir, pickName)
  }

  const inputDir = String(desktopSettings?.inputDir ?? '').trim()
  const outputDir = String(desktopSettings?.outputDir ?? '').trim()

  const args = ['-s', mainRel, '--enable-assets', '--enable-manager']
  if (cfg.comfyCors !== false) args.push('--enable-cors-header', '*')
  if (modelPathsConfig !== '') args.push('--extra-model-paths-config', modelPathsConfig)
  if (inputDir !== '') args.push('--input-directory', inputDir)
  if (outputDir !== '') args.push('--output-directory', outputDir)
  const extra = String(cfg.comfyArgs ?? '').trim()
  if (extra !== '') args.push(...extra.split(/\s+/u).filter(Boolean))

  return {
    python,
    args,
    cwd: workdir,
    installId: String(local?.id ?? ''),
    command: `${python} ${args.join(' ')}`,
    warning: '',
  }
}

async function startComfy(cfg, log) {
  if (await probeComfy(cfg)) {
    launchState = { pid: 0, since: 0, logPath: '' }
    return { online: true, already: true, launching: false }
  }
  if (launchState.pid > 0 && Date.now() - launchState.since < 180000) {
    return {
      online: false,
      launching: true,
      pid: launchState.pid,
      seconds: Math.round((Date.now() - launchState.since) / 1000),
      already: true,
    }
  }

  const spec = await resolveLaunchSpec(cfg)
  if (spec.error) return { online: false, launching: false, error: spec.error }

  const logPath = cfg.launchLogPath
  try {
    await fsp.mkdir(path.dirname(logPath), { recursive: true })
    await fsp.appendFile(
      logPath,
      `\n===== ${nowIso()} 启动 ComfyUI =====\n${spec.command}\ncwd=${spec.cwd}\n`,
      'utf8',
    )
  } catch { /* 日志写不了也不影响启动 */ }

  let fd
  try {
    fd = openSync(logPath, 'a')
  } catch {
    fd = 'ignore'
  }
  let child
  try {
    child = spawn(spec.python, spec.args, {
      cwd: spec.cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
  } catch (error) {
    if (typeof fd === 'number') closeSync(fd)
    return { online: false, launching: false, error: `启动失败：${error?.message ?? error}` }
  }
  child.on('error', (error) => log?.('warn', `启动 ComfyUI 失败：${error?.message ?? error}`))
  // 进程秒退（比如缺 torch）时不要傻等 180 秒，记下来让 /status.json 立刻报错。
  child.on('exit', (code, signal) => {
    if (launchState.pid === child.pid) {
      launchState.exited = { code, signal, at: Date.now() }
      log?.('warn', `ComfyUI 进程退出（code=${code} signal=${signal}）`)
    }
  })
  child.unref()
  if (typeof fd === 'number') closeSync(fd)

  launchState = { pid: child.pid ?? 0, since: Date.now(), logPath, exited: null }
  log?.('info', `已启动 ComfyUI（pid=${child.pid}）：${spec.command}`)
  return {
    online: false,
    launching: true,
    pid: child.pid ?? 0,
    seconds: 0,
    command: spec.command,
    logPath,
  }
}

async function comfyStatus(cfg) {
  const online = await probeComfy(cfg)
  if (online) launchState = { pid: 0, since: 0, logPath: '', exited: null }
  const elapsed = launchState.pid > 0 ? Date.now() - launchState.since : 0
  const exited = launchState.exited ?? null
  const launching = !online && launchState.pid > 0 && exited === null && elapsed < 180000
  return {
    online,
    launching,
    pid: launching ? launchState.pid : 0,
    seconds: launching ? Math.round(elapsed / 1000) : 0,
    timeoutSeconds: 180,
    url: cfg.comfyUrl,
    exitCode: exited?.code ?? null,
    logTail: !online && !launching && launchState.pid > 0
      ? await readLogTail(launchState.logPath)
      : '',
  }
}

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

function runCapture(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, maxBuffer: 4 << 20 }, (error, stdout) => {
        resolve(error ? '' : String(stdout ?? ''))
      })
    } catch {
      resolve('')
    }
  })
}

async function findListenerPid(cfg) {
  if (process.platform !== 'win32') return 0
  let port = 8188
  try {
    port = Number(new URL(cfg.comfyUrl).port || 8188)
  } catch { /* 用默认端口 */ }
  const text = await runCapture('netstat', ['-ano'])
  for (const line of text.split(/\r?\n/u)) {
    const hit = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu)
    if (hit && Number(hit[1]) === port) return Number(hit[2])
  }
  return 0
}

async function stopComfy(cfg, log) {
  const pid = launchState.pid > 0 ? launchState.pid : await findListenerPid(cfg)
  if (pid === 0) {
    return { online: await probeComfy(cfg), stopped: false, reason: '没找到正在运行的 ComfyUI 进程' }
  }
  if (process.platform === 'win32') {
    await runCapture('taskkill', ['/PID', String(pid), '/T', '/F'])
    // python 和真正 listen 的可能不是同一个 pid，补一刀。
    const listener = await findListenerPid(cfg)
    if (listener > 0 && listener !== pid) {
      await runCapture('taskkill', ['/PID', String(listener), '/T', '/F'])
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      log?.('warn', `结束进程失败：${error?.message ?? error}`)
    }
  }
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (!(await probeComfy(cfg))) break
    await new Promise((resolve) => { setTimeout(resolve, 300) })
  }
  launchState = { pid: 0, since: 0, logPath: '', exited: null }
  const online = await probeComfy(cfg)
  log?.(online ? 'warn' : 'info', `停止 ComfyUI（pid=${pid}）：${online ? '端口仍被占用' : '已停止'}`)
  return { online, stopped: !online, pid }
}

async function readLogTail(file, limit = 1600) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return text.length > limit ? text.slice(-limit) : text
  } catch {
    return ''
  }
}

let infoCache = { at: 0, data: null }
async function getObjectInfo(cfg, force = false) {
  if (!force && infoCache.data !== null && Date.now() - infoCache.at < 30000) return infoCache.data
  const res = await comfyFetch(cfg, `${cfg.comfyUrl}/object_info`, { method: 'GET' }, 20000)
  if (!res.ok) throw new Error(`ComfyUI 的 /object_info 返回 HTTP ${res.status}`)
  const data = await res.json()
  infoCache = { at: Date.now(), data }
  return data
}

async function submitPrompt(cfg, workflow) {
  const res = await comfyFetch(cfg, `${cfg.comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: cfg.workflowId }),
  }, 30000)
  const text = await res.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = null }
  if (!res.ok) {
    const detail = payload?.error?.message ?? payload?.error ?? text.slice(0, 600)
    const nodeErrors = payload?.node_errors ?? null
    throw new Error(`ComfyUI 拒绝了这次任务（HTTP ${res.status}）：${String(detail)}`
      + (nodeErrors ? `\n节点校验详情：${JSON.stringify(nodeErrors).slice(0, 900)}` : ''))
  }
  if (payload?.error) {
    throw new Error(`ComfyUI 报错：${JSON.stringify(payload.error).slice(0, 900)}`)
  }
  const promptId = payload?.prompt_id
  if (typeof promptId !== 'string' || promptId === '') throw new Error('ComfyUI 没有返回 prompt_id')
  return promptId
}

async function waitForResult(cfg, promptId, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? cfg.timeoutMs)
  const pollMs = options.pollIntervalMs ?? cfg.pollIntervalMs
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('已取消')
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    let res
    try {
      res = await comfyFetch(cfg, `${cfg.comfyUrl}/history/${promptId}`, { method: 'GET' }, 15000)
    } catch {
      continue
    }
    if (!res.ok) continue
    const payload = await res.json().catch(() => null)
    const entry = payload?.[promptId]
    if (!entry) continue
    const status = entry.status ?? {}
    if (status.status_str === 'error') {
      const messages = Array.isArray(status.messages) ? status.messages : []
      const failure = messages.find((m) => Array.isArray(m) && m[0] === 'execution_error')
      const info = failure?.[1] ?? {}
      throw new Error(`ComfyUI 执行出错：${info.exception_message ?? info.exception_type ?? '未知错误'}`
        + (info.node_type ? `（节点 ${info.node_type}）` : ''))
    }
    const images = []
    let report = ''
    for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
      // PreviewAny（NID.report）回传的是 AnimaV5RandomPrompt 的 report 文本，不产图。
      if (nodeId === NID.report) {
        const raw = output?.text
        report = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '')
        continue
      }
      for (const image of output?.images ?? []) {
        if (image?.filename) images.push(image)
      }
    }
    if (images.length > 0) return { images, entry, report }
    if (status.completed === true) throw new Error('ComfyUI 已完成，但没有产出任何图片')
  }
  throw new Error(`等待 ComfyUI 出图超时（${Math.round((options.timeoutMs ?? cfg.timeoutMs) / 1000)} 秒）`)
}

async function fetchImageBytes(cfg, image) {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  })
  const res = await comfyFetch(cfg, `${cfg.comfyUrl}/view?${query.toString()}`, { method: 'GET' }, 60000)
  if (!res.ok) throw new Error(`取图失败（HTTP ${res.status}）：${image.filename}`)
  return Buffer.from(await res.arrayBuffer())
}

/* ------------------------------------------------------------- state storage ---- */

let stateCache = null

function defaultState() {
  return {
    version: 1,
    clip: { name: '', type: 'stable_diffusion', device: 'default' },
    vae: '',
    unet: '',
    aspectRatio: '9:16 (Portrait Widescreen)',
    width: 800,
    height: 1424,
    batchSize: 1,
    steps: 25,
    guidance: 1,
    sampler: 'er_sde',
    scheduler: 'beta',
    // 采样偏移：MOSS / Flux 这类 flow-matching 模型需要 shift（Anima / Qwen 官方模板不带，默认关）。
    useAuraFlow: false,
    auraFlowShift: 1,
    // 分块 VAE 解码：默认关（用原生 VAEDecode）。Qwen-Image-2.1 这类 VAE 在分块边界
    // 会留下紫色/绿色色偏，整块解码没有接缝；只有分辨率很大、显存不够时才需要打开。
    useTiledVae: false,
    negative: DEFAULT_NEGATIVE,
    quality: DEFAULT_QUALITY,
    loras: [],
    // 每个 UNet 的配置档案：{ [unet文件名]: { clipName, clipType, vaeName, cfg, sampler, scheduler, steps } }
    // 切换 UNet 时，若该模型有档案就自动套用；没有就保持当前设置，等用户点「保存为档案」。
    modelProfiles: {},
    // LoRA 预设：用户可以把当前 LoRA 列表命名保存，之后一键切换。
    loraPresets: [],
    // 模型（anima_draw 工具）是否参考页面配置的三层权重：
    // true = 以页面权重为底、工具参数再往上覆盖；false = 只看工具参数。
    followPanel: true,
    panelWeights: { sections: {}, fields: {}, options: {} },
    nsfwLevel: 'sfw',
    extraBody: '',
    mainTagCap: '自动',
    baseProb: 1,
    selectedRoles: '',
    // 角色控制：'role' = 以「已选角色」为准（写 selected_roles）；
    //           'work' = 以「作品 IP」为准（写 role_works，每次从该作品里随机抽角色）。
    roleMode: 'role',
    workPick: '',
    charPick: '',
    outfitStyle: '日常',
    breastSize: '巨乳',
    // 指定角色时，把角色库里该角色的特征 tags（狐耳 / 多尾 / 双色发 …）补进提示词。
    // V5 引擎自己只对齐发色 / 瞳色，种族特征 tags 单角色模式下从不写入。
    roleFeature: true,
    rolePick: true,
    scenePick: false,
    // 抽到角色时，让角色的发色 / 瞳色 / 体型等特征盖过其它字段（包括权重里指定的发色）。
    appearanceFollow: true,
    // AnimaWardrobe V6 新增输入 —— dry_skin_filter：禁止汗 / 湿润类标签（默认关，与节点默认一致）。
    drySkinFilter: false,
    // AnimaWardrobe V6 新增输入 —— duo_role_fill：只选 1 位角色 + 多人数时，自动补同作品另一位女性。
    // 默认开（V6 节点默认即 True），关掉 = 完全不介入、不消耗随机数。
    duoRoleFill: true,
    // AnimaWardrobe V6 新增 —— weights_json 的 forced 段：按场景 id 定点锁定（如 sc_cafe_window_rain）。
    // 压过整库随机与权重池，写进 { forced: { n_canon: <场景 id> } }；空串 = 不用。
    forcedScene: '',
    updatedAt: '',
  }
}

function normalizeLoraEntries(list) {
  return Array.isArray(list) ? list.map((l) => ({
    name: String(l?.name ?? ''),
    strength: Number.isFinite(Number(l?.strength)) ? Number(l.strength) : 1,
    clipStrength: Number.isFinite(Number(l?.clipStrength)) ? Number(l.clipStrength) : Number(l?.strength ?? 1),
    active: l?.active !== false,
  })) : []
}

// 采样偏移（AuraFlow shift）的范围：0–100，非法值回落到 1。
function clampShift(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100))
}

// 每个 UNet 的配置档案。
function normalizeProfiles(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key ?? '').trim()
    if (name === '' || !value || typeof value !== 'object') continue
    out[name] = {
      clipName: String(value.clipName ?? ''),
      clipType: String(value.clipType ?? 'stable_diffusion'),
      vaeName: String(value.vaeName ?? ''),
      cfg: Number.isFinite(Number(value.cfg)) ? Number(value.cfg) : 1,
      sampler: String(value.sampler ?? 'er_sde'),
      scheduler: String(value.scheduler ?? 'beta'),
      steps: Number.isInteger(Number(value.steps)) && Number(value.steps) > 0 ? Number(value.steps) : 25,
      useAuraFlow: value.useAuraFlow === true,
      auraFlowShift: clampShift(value.auraFlowShift),
      useTiledVae: value.useTiledVae === true,
    }
  }
  return out
}

// LoRA 预设：同名只保留第一条；预设里丢掉空名条目（那是编辑中的空槽，不该被存进预设）。
function normalizePresets(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const name = String(item?.name ?? '').trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push({ name, loras: normalizeLoraEntries(item?.loras).filter((l) => l.name !== '') })
  }
  return out
}

function normalizeState(raw) {
  const state = { ...defaultState(), ...(raw ?? {}) }
  state.clip = { ...defaultState().clip, ...(raw?.clip ?? {}) }
  state.panelWeights = lenient(state.panelWeights ?? {})
  // 注意：这里**不能**过滤空名条目。面板「+ 添加 LoRA」是先插一行空槽、
  // 再让用户在下拉里选名字；如果保存时把空名丢掉，用户刚展开的下拉会随着
  // 这次保存的回灌整行消失（表现为「选择条一闪就没」）。
  // 提交/写回时由 loraEntries() 统一跳过空名，因此留空是安全的。
  state.loras = normalizeLoraEntries(state.loras)
  state.followPanel = state.followPanel !== false
  state.sampler = typeof state.sampler === 'string' && state.sampler !== '' ? state.sampler : 'er_sde'
  state.scheduler = typeof state.scheduler === 'string' && state.scheduler !== '' ? state.scheduler : 'beta'
  state.useAuraFlow = state.useAuraFlow === true
  state.auraFlowShift = clampShift(state.auraFlowShift)
  state.useTiledVae = state.useTiledVae === true
  state.modelProfiles = normalizeProfiles(state.modelProfiles)
  state.loraPresets = normalizePresets(state.loraPresets)
  // 旧版本字段：面板权重来源 / 沿用开关 / 上次权重，已由 followPanel + 三层权重表取代。
  delete state.weightSource
  delete state.applyPanelWeights
  delete state.lastWeights
  delete state.weights
  state.roleMode = state.roleMode === 'work' ? 'work' : 'role'
  state.roleFeature = state.roleFeature !== false
  state.appearanceFollow = state.appearanceFollow !== false
  state.drySkinFilter = state.drySkinFilter === true
  state.duoRoleFill = state.duoRoleFill !== false
  state.forcedScene = typeof state.forcedScene === 'string' ? state.forcedScene.trim() : ''
  state.workPick = typeof state.workPick === 'string' ? state.workPick : ''
  state.charPick = typeof state.charPick === 'string' ? state.charPick : ''
  // selectedRoles 只是「面板点选角色」的旧字段，现在统一以 charPick 为准，
  // 留着旧值会让「不指定角色」看起来仍带着上一个角色。
  state.selectedRoles = state.charPick
  return state
}

async function readState(cfg, log) {
  if (stateCache !== null) return stateCache
  let raw = null
  try {
    raw = JSON.parse(await fsp.readFile(cfg.statePath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') log?.('warn', `读取状态失败：${error?.message ?? error}`)
  }
  if (raw === null) {
    const seeded = await seedStateFromWorkflow(cfg, log)
    stateCache = normalizeState(seeded)
    await writeState(cfg, stateCache, log)
    return stateCache
  }
  stateCache = normalizeState(raw)
  return stateCache
}

async function writeState(cfg, state, log) {
  state.updatedAt = nowIso()
  stateCache = state
  try {
    await fsp.mkdir(path.dirname(cfg.statePath), { recursive: true })
    await fsp.writeFile(cfg.statePath, JSON.stringify(state, null, 1), 'utf8')
  } catch (error) {
    log?.('warn', `写状态失败：${error?.message ?? error}`)
  }
}

/* ----------------------------------------------------- workflow json utilities ---- */

const WIDGET_TYPES = new Set([
  'INT', 'FLOAT', 'STRING', 'BOOLEAN', 'AUTOCOMPLETE_TEXT_LORAS', 'LORAS',
])

function isWidgetInput(def) {
  const type = def?.[0]
  const opts = def?.[1] ?? {}
  if (opts.forceInput) return false
  if (opts.widget === true) return true
  if (Array.isArray(type)) return true
  if (typeof type === 'string' && WIDGET_TYPES.has(type)) return true
  return false
}

/**
 * 推导某节点的 widgets_values 索引：{ name: index }（含 `name@control`）。
 * 与 ComfyUI 前端一致：按 object_info 的 required → optional 顺序消费 widget 槽，
 * seed 后面还有一个 control_after_generate 槽。
 */
/**
 * LoraManager 的 `Lora Loader (LoraManager)` 把自己的状态塞进三个 widgets_values：
 *   [0] 搜索框文本（提交名 __lm_autocomplete_meta_text）
 *   [1] lora 文本（提交名 text，后端会丢弃）
 *   [2] lora 数组（提交名 loras，真正生效）
 * 这个顺序是前端自定的，与 /object_info 的 required/optional 顺序**不一致**，
 * 推导出来会错位（把 0 当 text、1 当 loras），所以必须写死。
 */
const LORA_WIDGET_SLOTS = {
  __lm_autocomplete_meta_text: 0,
  text: 1,
  loras: 2,
}

const WIDGET_SLOT_OVERRIDES = new Map([
  ['Lora Loader (LoraManager)', LORA_WIDGET_SLOTS],
])

function deriveWidgetIndex(info, className, widgetsCount) {
  const override = WIDGET_SLOT_OVERRIDES.get(className)
  if (override) {
    return { index: { ...override }, consumed: Object.keys(override).length, widgetsCount }
  }
  const def = info?.[className]
  if (!def) return null
  const entries = [
    ...Object.entries(def.input?.required ?? {}),
    ...Object.entries(def.input?.optional ?? {}),
  ]
  const index = {}
  let i = 0
  for (const [widgetName, inputDef] of entries) {
    if (!isWidgetInput(inputDef)) continue
    index[widgetName] = i
    i += 1
    const opts = inputDef?.[1] ?? {}
    const ctrl = opts.control_after_generate === true
      || (widgetName === 'seed' && inputDef?.[0] === 'INT')
    if (ctrl) {
      index[`${widgetName}@control`] = i
      i += 1
    }
  }
  // widgets_values 末尾可能还有前端扩展多出来的槽；只报告不修改
  return { index, consumed: i, widgetsCount }
}

async function readJsonFile(file) {
  const raw = await fsp.readFile(file, 'utf8')
  return JSON.parse(raw.replace(/^\uFEFF/u, ''))
}

const COMFY_WORKFLOW_ROOTS = [
  'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI',
]

let comfyWfCache = { key: '', file: '', at: 0 }

/** ComfyUI 自己的那份工作流文件（user/default/workflows/<同名>）。找不到返回 ''。 */
async function comfyWorkflowFile(cfg) {
  const name = normalizeWorkflowName(cfg.workflowFile) || normalizeWorkflowName(cfg.workflowFileComfy)
  const roots = []
  if (cfg.comfyWorkdir) {
    roots.push(path.join(cfg.comfyWorkdir, 'ComfyUI'), cfg.comfyWorkdir)
  }
  roots.push(...COMFY_WORKFLOW_ROOTS)
  const key = String(cfg.workflowFileComfy ?? '') + '|' + name + '|' + roots.join(';')
  if (comfyWfCache.key === key && Date.now() - comfyWfCache.at < 30000) return comfyWfCache.file
  const candidates = []
  if (cfg.workflowFileComfy) candidates.push(cfg.workflowFileComfy)
  if (name) for (const root of roots) candidates.push(path.join(root, 'user', 'default', 'workflows', name))
  let found = ''
  for (const candidate of candidates) {
    if (await exists(candidate)) { found = candidate; break }
  }
  comfyWfCache = { key, file: found, at: Date.now() }
  return found
}

/** 读写的目标文件：优先 ComfyUI 那份，其次配置里的 workflowFile。 */
async function targetWorkflowFile(cfg) {
  return (await comfyWorkflowFile(cfg)) || cfg.workflowFile
}

async function loadUiWorkflow(cfg) {
  const file = await targetWorkflowFile(cfg)
  if (!file) throw new Error('没有配置 workflowFile（UI 格式工作流 JSON）')
  const json = await readJsonFile(file)
  const byId = new Map()
  for (const node of json.nodes ?? []) byId.set(String(node.id), node)
  return { json, byId }
}

/** 找出某个逻辑节点（优先 id，退化到 class_type + 标题）。 */
function findNode(byId, id, classType, titleLike) {
  const direct = byId.get(String(id))
  if (direct) return direct
  for (const node of byId.values()) {
    if (node?.type !== classType) continue
    const title = String(node?.title ?? '')
    if (titleLike && title.includes(titleLike)) return node
  }
  for (const node of byId.values()) if (node?.type === classType) return node
  return null
}

function widgetValue(node, widgetIndex, targetName) {
  const token = widgetIndex?.[targetName]
  if (!Number.isInteger(token)) return undefined
  return Array.isArray(node?.widgets_values) ? node.widgets_values[token] : undefined
}

async function seedStateFromWorkflow(cfg, log) {
  const state = defaultState()
  let ui
  try {
    ui = await loadUiWorkflow(cfg)
  } catch (error) {
    log?.('warn', `无法读取工作流 JSON（${cfg.workflowFile}）：${error?.message ?? error}`)
    return state
  }
  let info = null
  try {
    info = await getObjectInfo(cfg)
  } catch (error) {
    log?.('warn', `无法读取 ComfyUI /object_info：${error?.message ?? error}`)
  }
  const indexOf = (node, className) => (info ? deriveWidgetIndex(info, node?.type ?? className)?.index : null)

  const clipNode = findNode(ui.byId, NID.clip, 'CLIPLoader', 'CLIP')
  if (clipNode) {
    const idx = indexOf(clipNode)
    state.clip = {
      name: String(widgetValue(clipNode, idx, 'clip_name') ?? state.clip.name),
      type: String(widgetValue(clipNode, idx, 'type') ?? state.clip.type),
      device: String(widgetValue(clipNode, idx, 'device') ?? state.clip.device),
    }
  }
  const vaeNode = findNode(ui.byId, NID.vae, 'VAELoader', 'VAE')
  if (vaeNode) state.vae = String(widgetValue(vaeNode, indexOf(vaeNode), 'vae_name') ?? state.vae)

  const unetNode = findNode(ui.byId, NID.unet, 'UNETLoader', '')
  if (unetNode) state.unet = String(widgetValue(unetNode, indexOf(unetNode), 'unet_name') ?? state.unet)

  const qualityNode = findNode(ui.byId, NID.quality, 'StringConcatenate', '质量词')
  if (qualityNode) state.quality = String(widgetValue(qualityNode, indexOf(qualityNode), 'string_a') ?? state.quality)

  const negativeNode = findNode(ui.byId, NID.negative, 'CLIPTextEncode', '负向')
  if (negativeNode) state.negative = String(widgetValue(negativeNode, indexOf(negativeNode), 'text') ?? state.negative)

  const paramsNode = findNode(ui.byId, NID.params, 'XB_ImageParamsMaster', '')
  if (paramsNode) {
    const idx = indexOf(paramsNode)
    const width = Number(widgetValue(paramsNode, idx, 'width'))
    const height = Number(widgetValue(paramsNode, idx, 'height'))
    if (Number.isFinite(width) && width > 0) state.width = width
    if (Number.isFinite(height) && height > 0) state.height = height
    state.aspectRatio = String(widgetValue(paramsNode, idx, 'aspect_ratio') ?? state.aspectRatio)
    const batch = Number(widgetValue(paramsNode, idx, 'batch_size'))
    if (Number.isFinite(batch) && batch > 0) state.batchSize = batch
  }
  const samplerNode = findNode(ui.byId, NID.sampler, 'XB_KSampler', '')
  if (samplerNode) {
    const idx = indexOf(samplerNode)
    const steps = Number(widgetValue(samplerNode, idx, 'steps'))
    const guidance = Number(widgetValue(samplerNode, idx, 'cfg'))
    if (Number.isFinite(steps) && steps > 0) state.steps = steps
    if (Number.isFinite(guidance)) state.guidance = guidance
    const samplerName = widgetValue(samplerNode, idx, 'sampler_name')
    const schedulerName = widgetValue(samplerNode, idx, 'scheduler')
    if (typeof samplerName === 'string' && samplerName !== '') state.sampler = samplerName
    if (typeof schedulerName === 'string' && schedulerName !== '') state.scheduler = schedulerName
  }
  const loraNode = findNode(ui.byId, NID.lora, 'Lora Loader (LoraManager)', 'LoRA')
  if (loraNode) {
    const idx = indexOf(loraNode)
    const loras = widgetValue(loraNode, idx, 'loras')
    if (Array.isArray(loras)) {
      state.loras = loras.map((l) => ({
        name: String(l?.name ?? ''),
        strength: Number(l?.strength ?? 1),
        clipStrength: Number(l?.clipStrength ?? l?.strength ?? 1),
        active: l?.active !== false,
      })).filter((l) => l.name !== '')
    }
  }
  const animaNode = findNode(ui.byId, NID.anima, 'AnimaV5RandomPrompt', '')
  if (animaNode) {
    const idx = indexOf(animaNode)
    const pick = (name) => widgetValue(animaNode, idx, name)
    state.nsfwLevel = String(pick('nsfw_level') ?? state.nsfwLevel)
    state.mainTagCap = String(pick('tag_cap') ?? state.mainTagCap)
    const baseProb = Number(pick('base_prob'))
    if (Number.isFinite(baseProb)) state.baseProb = baseProb
    state.selectedRoles = String(pick('selected_roles') ?? '')
    // 作品 IP / 已选角色 的初始状态由工作流反推：
    //   role_works 非空 → 以作品为准；否则 selected_roles 非空 → 以角色为准。
    // 工作流里可能写英文名/中文名/danbooru tag，都归一成下拉认得的写法。
    const roleWorks = String(pick('role_works') ?? '')
    let roster = null
    try {
      roster = await loadRoster(cfg, log)
    } catch { /* 角色库读不到就保留原值 */ }
    if (roleWorks.trim() !== '') {
      state.roleMode = 'work'
      state.workPick = roleWorks.trim()
      const key = state.workPick.toLowerCase()
      const hit = roster?.works.find((w) => w.id.toLowerCase() === key
        || w.en.toLowerCase() === key || w.zh.toLowerCase() === key)
      if (hit) state.workPick = hit.id
    } else if (state.selectedRoles.trim() !== '') {
      state.roleMode = 'role'
      const raw = state.selectedRoles.split('|')[0].trim()
      const key = raw.toLowerCase()
      const hit = roster?.characters.find((c) => c.tag.toLowerCase() === key
        || c.trigger.toLowerCase() === key || c.name.toLowerCase() === key)
      state.charPick = hit ? hit.trigger : raw
    }
    state.outfitStyle = String(pick('outfit_style') ?? state.outfitStyle)
    state.breastSize = String(pick('breast_size') ?? state.breastSize)
    state.rolePick = pick('role_pick') !== false
    state.scenePick = pick('scene_pick') === true
    state.appearanceFollow = pick('appearance_follow') !== false
    state.extraBody = String(pick('extra_body') ?? '')
    const weightsRaw = pick('weights_json')
    if (typeof weightsRaw === 'string' && weightsRaw.trim() !== '') {
      try {
        const parsed = JSON.parse(weightsRaw)
        const weights = lenient(parsed)
        if (countWeights(weights) > 0) state.panelWeights = weights
      } catch { /* 忽略非法 JSON */ }
    }
  }
  return state
}

/* --------------------------------------------------------- workflow assembling ---- */

let templateCache = { at: 0, data: null, file: '' }
let fieldsCache = { at: 0, data: null, file: '' }

async function loadTemplate(cfg) {
  const file = cfg.templateFile && cfg.templateFile.trim() !== ''
    ? cfg.templateFile
    : path.join(HERE, 'templates', 'anima_api.json')
  if (templateCache.data !== null && templateCache.file === file && Date.now() - templateCache.at < 10000) {
    return templateCache.data
  }
  const data = await readJsonFile(file)
  templateCache = { at: Date.now(), data, file }
  return data
}

async function loadFields(cfg) {
  const file = cfg.fieldsFile && cfg.fieldsFile.trim() !== ''
    ? cfg.fieldsFile
    : path.join(HERE, 'templates', 'fields.json')
  if (fieldsCache.data !== null && fieldsCache.file === file && Date.now() - fieldsCache.at < 10000) {
    return fieldsCache.data
  }
  const data = await readJsonFile(file)
  fieldsCache = { at: Date.now(), data, file }
  return data
}

/**
 * 角色库：作品 IP 列表 + 每个作品下的角色。
 *
 * 数据来自 AnimaWardrobe 的 presets/anima_v4_characters.json
 * （V5：284 作品 / 2390 角色；V6：287 作品 / 2432 角色）。字段结构两版一致。
 * 只取面板需要的字段，避免把 1.1MB 原文件整个发给浏览器。
 * 一个角色的「已选角色」写 trigger（`hakurei reimu, touhou`），
 * 一个作品的「限定作品IP」写 work 的英文名 —— 两者都被节点直接接受。
 */
let rosterCache = { at: 0, data: null, file: '' }

/** 未显式配置时依次尝试的默认位置（V6 优先，再 V5）。 */
const ROSTER_FALLBACKS = [
  'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\custom_nodes\\Comfyui-Anima-Wardrobe-V6\\presets\\anima_v4_characters.json',
  'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\custom_nodes\\Comfyui-Anima-Wardrobe-V5\\presets\\anima_v4_characters.json',
]

async function loadRoster(cfg, log) {
  const configured = cfg.charactersFile && cfg.charactersFile.trim() !== '' ? cfg.charactersFile : ''
  const candidates = configured !== '' ? [configured, ...ROSTER_FALLBACKS] : [...ROSTER_FALLBACKS]
  const cacheKey = candidates.join('|')
  if (rosterCache.data !== null && rosterCache.file === cacheKey && Date.now() - rosterCache.at < 60000) {
    return rosterCache.data
  }
  const empty = { works: [], characters: [], error: '' }
  let file = ''
  let raw = null
  let lastError = null
  for (const candidate of candidates) {
    try {
      raw = JSON.parse(await fsp.readFile(candidate, 'utf8'))
      file = candidate
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') lastError = error
    }
  }
  if (raw === null) {
    const reason = lastError?.message ?? '找不到 anima_v4_characters.json（V6 / V5 位置都没有）'
    log?.('warn', `读取角色库失败：${reason}`)
    const failed = { ...empty, error: `读取角色库失败：${reason}` }
    rosterCache = { at: Date.now(), data: failed, file: cacheKey }
    return failed
  }
  log?.('debug', `角色库：${file}`)
  const works = (Array.isArray(raw?.works) ? raw.works : [])
    .map((w) => ({
      id: String(w?.id ?? ''),
      en: String(w?.en ?? ''),
      zh: String(w?.zh ?? ''),
      count: Number(w?.count ?? 0),
      target: w?.target === true,
    }))
    .filter((w) => w.en !== '' || w.id !== '')
  // 4 个重点作品置顶，其余按角色数从多到少。
  works.sort((a, b) => Number(b.target) - Number(a.target) || b.count - a.count || a.en.localeCompare(b.en))
  // 作品英文名里可能有分隔符（`steins;gate`），所以对节点提交 slug（id），
  // 同时给每个角色带上所属作品的 slug，客户端按下拉值过滤才不会错位。
  const workIdByName = new Map()
  for (const w of works) if (w.en) workIdByName.set(w.en.toLowerCase(), w.id)
  const characters = (Array.isArray(raw?.characters) ? raw.characters : [])
    .map((c) => {
      const work = String(c?.work ?? '')
      return {
        tag: String(c?.tag ?? ''),
        name: String(c?.name ?? ''),
        zh: String(c?.zh ?? ''),
        work,
        workId: workIdByName.get(work.toLowerCase()) ?? '',
        trigger: String(c?.trigger ?? ''),
        tags: Array.isArray(c?.tags) ? c.tags.map((t) => String(t ?? '').trim().toLowerCase()) : [],
      }
    })
    .filter((c) => c.trigger !== '' || c.name !== '')
  const data = { works, characters, error: '' }
  rosterCache = { at: Date.now(), data, file: cacheKey }
  return data
}

/**
 * 角色特征补全：V5 引擎自己只对齐发色 / 瞳色（appearance_for → hair/eyes/figure），
 * 角色库 tags 里的种族特征（`fox ears` / `multiple tails` / `two-tone hair` …）
 * 在单角色模式下**从不写进提示词**，于是「选了铃兰却没有耳朵尾巴」。
 * 这里把它们补成一段 tag 串，由调用方拼在 extra_body 之前。
 */
const ROLE_FEATURE_SKIP = new Set([
  '1girl', '1boy', 'solo', 'multiple girls', 'multiple boys', '2girls', '2boys',
  'no humans', 'censored', 'commentary', 'translation request', 'absurdres',
])
const ROLE_FEATURE_LIMIT = 16

function featureTagsOf(character) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(character?.tags) ? character.tags : []) {
    const t = String(raw ?? '').trim().toLowerCase()
    if (t === '' || t.length > 40) continue
    if (ROLE_FEATURE_SKIP.has(t) || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= ROLE_FEATURE_LIMIT) break
  }
  return out
}

async function roleFeaturePrefix(cfg, log, charPick) {
  const key = String(charPick ?? '').trim().toLowerCase()
  if (key === '') return ''
  try {
    const roster = await loadRoster(cfg, log)
    const hit = (roster.characters ?? []).find((c) => (
      String(c.trigger ?? '').toLowerCase() === key
      || String(c.tag ?? '').toLowerCase() === key
      || normalizeRoleToken(c.tag ?? '').toLowerCase() === key
    ))
    return hit ? featureTagsOf(hit).join(', ') : ''
  } catch {
    return ''
  }
}

/** 出图前把角色特征拼到 extra_body 前面（roleFeature 关掉时原样返回）。 */
async function withRoleFeatures(cfg, log, settings) {
  const body = typeof settings.extraBody === 'string' ? settings.extraBody : ''
  if (settings.roleFeature === false) return body
  if (settings.roleMode === 'work') return body
  const trigger = String(settings.charPick ?? '').trim()
  if (trigger === '') return body
  const head = await roleFeaturePrefix(cfg, log, trigger)
  return head === '' ? body : [head, body].filter((x) => x !== '').join(', ')
}

/**
 * danbooru 角色 tag → 节点偏好的 trigger 写法：
 *   ellen_joe_(zenless_zone_zero) → `ellen joe, zenless zone zero`
 *   hakurei_reimu                 → `hakurei reimu`
 * 与 anima_v4_rules._normalize_role_token 保持一致；`|` 分隔的多个角色逐段处理。
 */
function normalizeRoleToken(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return ''
  return raw.split('|').map((chunk) => {
    const t = chunk.trim()
    if (t === '') return ''
    if (t.includes(',')) return t
    const m = /^(.+?)_\(([^()]+)\)$/u.exec(t)
    if (m) {
      const name = m[1].replace(/_/gu, ' ').trim()
      const work = m[2].replace(/_/gu, ' ').trim()
      return name !== '' && work !== '' ? `${name}, ${work}` : name
    }
    return t.replace(/_/gu, ' ').trim()
  }).filter((x) => x !== '').join('|')
}

function loraEntries(loras) {  return (Array.isArray(loras) ? loras : [])
    .filter((l) => l && typeof l.name === 'string' && l.name !== '' && l.active !== false)
    .map((l) => {
      const strength = Number.isFinite(Number(l.strength)) ? Number(l.strength) : 1
      const clipStrength = Number.isFinite(Number(l.clipStrength)) ? Number(l.clipStrength) : strength
      return {
        name: l.name.replace(/\.safetensors$/iu, ''),
        strength: String(strength),
        active: true,
        expanded: false,
        clipStrength: String(clipStrength),
        selected: false,
        locked: false,
      }
    })
}

function loraText(entries) {
  return entries.map((l) => `<lora:${l.name}:${l.strength}>`).join(' ')
}

function weightsJsonFor(node, weights, forcedScene) {
  let ui = {}
  const raw = node?.inputs?.weights_json
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed._ui && typeof parsed._ui === 'object') ui = { _ui: parsed._ui }
    } catch { /* 忽略 */ }
  }
  const compact = compactWeights(weights)
  // V6 的 forced 段：按场景 id 定点锁定（n_canon 是场景字段的 key）。
  // 老版本 V5 的 parse_weights 只读 sections/fields/options，多出来的键会被忽略。
  const scene = typeof forcedScene === 'string' ? forcedScene.trim() : ''
  if (scene !== '') compact.forced = { n_canon: scene }
  return Object.keys(compact).length === 0 && Object.keys(ui).length === 0
    ? ''
    : JSON.stringify({ ...ui, ...compact }, null, 1)
}

/**
 * 深拷贝模板并写入参数。返回 { workflow, seed, weights }。
 */
function buildWorkflow(template, options) {
  const workflow = JSON.parse(JSON.stringify(template))
  const set = (id, key, value) => {
    const node = workflow[id]
    if (!node) return
    if (value === undefined) return
    node.inputs[key] = value
  }
  const seed = Number.isSafeInteger(options.seed) && options.seed >= 0
    ? options.seed
    : Math.floor(Math.random() * 2 ** 31)

  set(NID.clip, 'clip_name', options.clip?.name)
  set(NID.clip, 'type', options.clip?.type)
  set(NID.clip, 'device', options.clip?.device || 'default')
  set(NID.vae, 'vae_name', options.vae)
  set(NID.unet, 'unet_name', options.unet)
  set(NID.quality, 'string_a', options.quality)
  set(NID.negative, 'text', options.negative)
  set(NID.params, 'aspect_ratio', options.aspectRatio)
  set(NID.params, 'width', options.width)
  set(NID.params, 'height', options.height)
  set(NID.params, 'batch_size', options.batchSize)
  set(NID.sampler, 'seed', seed)
  set(NID.sampler, 'steps', options.steps)
  set(NID.sampler, 'cfg', options.guidance)
  if (typeof options.sampler === 'string' && options.sampler !== '') set(NID.sampler, 'sampler_name', options.sampler)
  if (typeof options.scheduler === 'string' && options.scheduler !== '') set(NID.sampler, 'scheduler', options.scheduler)

  // 采样偏移（AuraFlow shift）：关掉时把该节点整个从提交里删掉，让 SageAttention 直接接 UNET。
  if (options.useAuraFlow === true) {
    set(NID.auraFlow, 'shift', clampShift(options.auraFlowShift))
    set(NID.auraFlow, 'sampling', 'flow')
    set(NID.auraFlow, 'model', [NID.unet, 0])
    set(NID.sage, 'model', [NID.auraFlow, 0])
  } else {
    delete workflow[NID.auraFlow]
    if (workflow[NID.sage]?.inputs) workflow[NID.sage].inputs.model = [NID.unet, 0]
  }

  // VAE 解码：分块 / 整块二选一，另一个从提交里删掉，SaveImage 指向留存的那个。
  const useTiled = options.useTiledVae === true
  const decodeId = useTiled ? NID.decode : NID.decodePlain
  const spareId = useTiled ? NID.decodePlain : NID.decode
  delete workflow[spareId]
  if (workflow[NID.save]?.inputs) workflow[NID.save].inputs.images = [decodeId, 0]
  set(NID.seed, 'seed', seed)

  const anima = workflow[NID.anima]
  const autoRolePick = { applied: false, appearanceKeys: [] }
  if (anima) {
    const inputs = anima.inputs
    if (typeof options.nsfwLevel === 'string' && NSFW_LEVELS.includes(options.nsfwLevel)) inputs.nsfw_level = options.nsfwLevel
    inputs.seed = seed
    if (typeof options.extraBody === 'string') inputs.extra_body = options.extraBody
    if (typeof options.mainTagCap === 'string' && options.mainTagCap !== '') inputs.tag_cap = options.mainTagCap
    if (Number.isFinite(options.baseProb)) inputs.base_prob = options.baseProb
    // 角色控制二选一：作品 IP（role_works，每次从该作品里随机抽人）
    //              或指定角色（selected_roles，抽人概率 100%）。
    // 另一个必须显式清空 —— 否则工作流模板里原有的值会继续生效，两个都设还会互相打架。
    if (options.roleMode === 'work') {
      // work 模式下永远不写 selected_roles：模板里原有值会继续生效，必须显式清空。
      inputs.role_works = String(options.workPick ?? '').trim()
      inputs.selected_roles = ''
    } else {
      // 只认 charPick：为空就写空，避免把工作流模板里的旧角色再带回来。
      inputs.selected_roles = normalizeRoleToken(options.charPick || '')
      inputs.role_works = ''
    }
    if (typeof options.outfitStyle === 'string' && options.outfitStyle !== '') inputs.outfit_style = options.outfitStyle
    if (typeof options.breastSize === 'string' && options.breastSize !== '') inputs.breast_size = options.breastSize
    // role_pick 自动推断（bug 报告 B1）：
    // 引擎只要 role_pick=true 就会清空「人物特征」字段的必现池（rules.py:3890），
    // 而「没指定角色、从全库随机抽一个」也走这个分支 → 用户点的发色/瞳色被静默忽略。
    // 所以：没指定角色 + 权重里动了这些字段 → 主动置 false，这一张走「纯词库人物」。
    // 工具显式传 rolePick（rolePickExplicit=true）时不干预，尊重调用方。
    const effectiveRole = options.roleMode === 'work'
      ? String(options.workPick ?? '').trim()
      : normalizeRoleToken(options.charPick || '')
    if (options.rolePickExplicit !== true && effectiveRole === '') {
      const appearanceKeys = appearanceWeightKeys(options.weights ?? {})
      if (appearanceKeys.length > 0) {
        autoRolePick.applied = true
        autoRolePick.appearanceKeys = appearanceKeys
      }
    }
    if (autoRolePick.applied) inputs.role_pick = false
    else if (typeof options.rolePick === 'boolean') inputs.role_pick = options.rolePick
    if (typeof options.scenePick === 'boolean') inputs.scene_pick = options.scenePick
    // 外观跟随：抽到角色时让角色的发色 / 瞳色 / 体型等特征盖过其它字段（含权重里指定的发色）。
    if (typeof options.appearanceFollow === 'boolean') inputs.appearance_follow = options.appearanceFollow
    // AnimaWardrobe V6 才有这两个输入；在 V5 节点上会被 ComfyUI 判为未知输入，
    // 所以面板默认值与节点默认值保持一致（关 / 开），升级到 V6 后才有实际差别。
    if (typeof options.drySkinFilter === 'boolean') inputs.dry_skin_filter = options.drySkinFilter
    if (typeof options.duoRoleFill === 'boolean') inputs.duo_role_fill = options.duoRoleFill
    inputs.weights_json = weightsJsonFor(anima, options.weights ?? {}, options.forcedScene)
  }

  const loraNode = workflow[NID.lora]
  if (loraNode && options.loras !== undefined) {
    const entries = loraEntries(options.loras)
    // ComfyUI 用长度 2 的数组表示「节点连线」，所以列表型 widget 必须包成 __value__。
    loraNode.inputs.loras = { __value__: entries }
    loraNode.inputs.text = loraText(entries)
    loraNode.inputs.__lm_autocomplete_meta_text = ''
  }

  const save = workflow[NID.save]
  if (save && typeof save.inputs.filename_prefix === 'string') {
    save.inputs.filename_prefix = expandDateTokens(save.inputs.filename_prefix)
  }
  return { workflow, seed, autoRolePick }
}

function imageAbsolutePath(cfg, image) {
  const sub = String(image.subfolder ?? '').replace(/^[/\\]+/u, '')
  return path.join(cfg.outputRoot, sub, String(image.filename ?? ''))
}

function imageRelPath(cfg, absolute) {
  const rel = path.relative(cfg.outputRoot, absolute)
  return rel.split(path.sep).join('/')
}

/* ---------------------------------------------------------------- generation ---- */

async function generateOnce(cfg, log, settings, overrides = {}, signal) {
  const template = await loadTemplate(cfg)
  const merged = { ...settings, ...overrides }
  merged.extraBody = await withRoleFeatures(cfg, log, merged)
  const { workflow, seed, autoRolePick } = buildWorkflow(template, merged)
  log?.('info', `提交任务 seed=${seed} ${merged.width}x${merged.height} weights=${countWeights(merged.weights ?? {})}`)
  const started = Date.now()
  let promptId
  try {
    promptId = await submitPrompt(cfg, workflow)
  } catch (error) {
    // 老版本 ComfyUI 没有 PreviewAny 节点：去掉回传节点重试一次，退化成没有 report。
    if (workflow[NID.report] && /PreviewAny|1151/u.test(String(error?.message ?? ''))) {
      delete workflow[NID.report]
      log?.('warn', 'PreviewAny 不可用，本次不带 report 回传重试')
      promptId = await submitPrompt(cfg, workflow)
    } else {
      throw error
    }
  }
  const { images, report } = await waitForResult(cfg, promptId, { timeoutMs: cfg.timeoutMs, signal })
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1))

  await fsp.mkdir(cfg.outputRoot, { recursive: true })
  const files = []
  for (const image of images.slice(0, Math.max(1, Number(merged.batchSize) || 1))) {
    const target = imageAbsolutePath(cfg, image)
    try {
      await fsp.access(target)
    } catch {
      const bytes = await fetchImageBytes(cfg, image)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, bytes)
    }
    files.push(target)
  }
  if (files.length === 0) throw new Error('ComfyUI 报告成功，但没有找到图片文件')
  return { files, seed, seconds, promptId, workflow, report, autoRolePick }
}

/* ---------------------------------------------------------------- HTTP routes ---- */

function isLocalRequest(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const remote = String(req?.socket?.remoteAddress ?? '')
  const hostOk = host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host)
  const remoteOk = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  return hostOk && remoteOk
}

function respondJson(res, body, code = 200) {
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify(body))
  } catch { /* 连接已关闭 */ }
}

function requestUrl(req) {
  try {
    return new URL(req?.url ?? '/', 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

function pickList(info, className, inputName) {
  const def = info?.[className]?.input?.required?.[inputName]
  const list = Array.isArray(def?.[0]) ? def[0] : null
  return Array.isArray(list) ? list.map((x) => String(x)) : []
}

async function buildOptions(cfg) {
  // ComfyUI 离线时不能让整个接口失败：面板还要能显示、能点「启动 ComfyUI」。
  // 离线就退回上一次缓存的可选项（没有缓存就是空列表）。
  const online = await probeComfy(cfg)
  let info = infoCache.data ?? {}
  let warn = ''
  if (online) {
    try {
      info = await getObjectInfo(cfg)
    } catch (error) {
      warn = `读取 ComfyUI 节点定义失败，用的是上一次的缓存：${error?.message ?? error}`
    }
  } else if (infoCache.data === null) {
    warn = 'ComfyUI 未启动，模型下拉暂时为空。'
  }
  const fields = await loadFields(cfg)
  const roster = await loadRoster(cfg)
  const loras = pickList(info, 'LoraLoader', 'lora_name')
  const loraSource = loras.length > 0 ? loras : pickList(info, 'LoraLoaderModelOnly', 'lora_name')
  return {
    ok: true,
    online,
    warn,
    clip: pickList(info, 'CLIPLoader', 'clip_name'),
    clipType: pickList(info, 'CLIPLoader', 'type'),
    clipDevice: pickList(info, 'CLIPLoader', 'device'),
    vae: pickList(info, 'VAELoader', 'vae_name'),
    unet: pickList(info, 'UNETLoader', 'unet_name'),
    loras: loraSource,
    aspectRatio: pickList(info, 'XB_ImageParamsMaster', 'aspect_ratio'),
    samplers: pickList(info, 'KSampler', 'sampler_name').length > 0
      ? pickList(info, 'KSampler', 'sampler_name')
      : pickList(info, 'KSamplerSelect', 'sampler_name'),
    schedulers: pickList(info, 'KSampler', 'scheduler'),
    nsfwLevel: NSFW_LEVELS,
    outfitStyle: pickList(info, 'AnimaV5RandomPrompt', 'outfit_style'),
    breastSize: pickList(info, 'AnimaV5RandomPrompt', 'breast_size'),
    tagCap: pickList(info, 'AnimaV5RandomPrompt', 'tag_cap'),
    samplers: pickList(info, 'XB_KSampler', 'sampler_name'),
    schedulers: pickList(info, 'XB_KSampler', 'scheduler'),
    sections: fields.sections.map((s) => ({
      id: s.id,
      title: s.title,
      fields: s.fields.map((f) => ({ key: f.key, lab: f.lab })),
    })),
    fieldOptions: Object.fromEntries(fields.sections.flatMap((s) => s.fields.map((f) => [f.key, f.opts ?? []]))),
    works: roster.works,
    characters: roster.characters,
    rosterError: roster.error,
    limits: { weightMin: 0, weightMax: 3, timeouts: cfg.timeoutMs },
  }
}

/** 递归列出出图（按修改时间倒序）。 */
async function listImages(cfg, limit = 400) {
  const root = path.join(cfg.outputRoot, cfg.imageRelDir)
  const acc = []
  const walk = async (dir, depth) => {
    if (depth > 6 || acc.length >= limit * 2) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (/\.(png|webp|jpg|jpeg)$/iu.test(entry.name)) {
        try {
          const stat = await fsp.stat(full)
          acc.push({ abs: full, mtime: stat.mtimeMs, size: stat.size })
        } catch { /* 跳过 */ }
      }
    }
  }
  await walk(root, 0)
  acc.sort((a, b) => b.mtime - a.mtime)
  return acc.slice(0, limit).map((item) => ({
    rel: imageRelPath(cfg, item.abs),
    name: path.basename(item.abs),
    mtime: item.mtime,
    size: item.size,
    url: `/anima-wardrobe/image.png?rel=${encodeURIComponent(imageRelPath(cfg, item.abs))}`,
  }))
}

async function serveImage(cfg, res, rel) {
  const normalized = String(rel ?? '').replace(/\\/gu, '/')
  const absolute = path.resolve(cfg.outputRoot, normalized)
  const rootAbs = path.resolve(cfg.outputRoot)
  if (!absolute.startsWith(rootAbs + path.sep)) {
    respondJson(res, { ok: false, reason: '路径越界' }, 400)
    return
  }
  let bytes
  try {
    bytes = await fsp.readFile(absolute)
  } catch (error) {
    respondJson(res, { ok: false, reason: `读取失败：${error?.message ?? error}` }, 404)
    return
  }
  const ext = path.extname(absolute).toLowerCase()
  const type = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream'
  try {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
    })
    res.end(bytes)
  } catch { /* 连接已关闭 */ }
}

/* ----------------------------------------------------------------- write back ---- */

async function writeBackWorkflow(cfg, settings, log) {
  const ui = await loadUiWorkflow(cfg)
  let info = null
  try {
    info = await getObjectInfo(cfg)
  } catch { /* 没网也能写部分 */ }
  const indexOf = (node) => (info ? deriveWidgetIndex(info, node?.type)?.index : null)
  const changed = []
  const apply = (node, values) => {
    if (!node) return
    const idx = indexOf(node)
    if (!idx) return
    const wv = Array.isArray(node.widgets_values) ? node.widgets_values : []
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined || !Number.isInteger(idx[name])) continue
      wv[idx[name]] = value
      changed.push(`${node.id}.${name}`)
    }
    node.widgets_values = wv
  }

  const clipNode = findNode(ui.byId, NID.clip, 'CLIPLoader', 'CLIP')
  apply(clipNode, {
    clip_name: settings.clip?.name,
    type: settings.clip?.type,
    device: settings.clip?.device,
  })
  apply(findNode(ui.byId, NID.vae, 'VAELoader', 'VAE'), { vae_name: settings.vae })
  apply(findNode(ui.byId, NID.unet, 'UNETLoader', ''), { unet_name: settings.unet })
  apply(findNode(ui.byId, NID.quality, 'StringConcatenate', '质量词'), { string_a: settings.quality })
  apply(findNode(ui.byId, NID.negative, 'CLIPTextEncode', '负向'), { text: settings.negative })
  apply(findNode(ui.byId, NID.params, 'XB_ImageParamsMaster', ''), {
    aspect_ratio: settings.aspectRatio,
    width: settings.width,
    height: settings.height,
    batch_size: settings.batchSize,
  })
  apply(findNode(ui.byId, NID.sampler, 'XB_KSampler', ''), {
    steps: settings.steps,
    cfg: settings.guidance,
    sampler_name: settings.sampler,
    scheduler: settings.scheduler,
  })
  const loraNode = findNode(ui.byId, NID.lora, 'Lora Loader (LoraManager)', 'LoRA')
  if (loraNode) {
    const idx = indexOf(loraNode)
    const entries = loraEntries(settings.loras)
    const existing = Array.isArray(loraNode.widgets_values?.[LORA_WIDGET_SLOTS.loras])
      ? loraNode.widgets_values[LORA_WIDGET_SLOTS.loras]
      : []
    // 面板里的 lora 列表为空时（还没读到 / 用户清空），不要清掉工作流里已有的 lora。
    if (entries.length > 0 || existing.length === 0) {
      if (idx) {
        const wv = Array.isArray(loraNode.widgets_values) ? loraNode.widgets_values : []
        if (Number.isInteger(idx.loras)) {
          wv[idx.loras] = entries.map((l) => ({
            name: l.name,
            strength: l.strength,
            active: true,
            expanded: false,
            clipStrength: l.clipStrength,
            selected: false,
            locked: false,
          }))
          changed.push(`${loraNode.id}.loras`)
        }
        if (Number.isInteger(idx.text)) {
          wv[idx.text] = loraText(entries)
          changed.push(`${loraNode.id}.text`)
        }
        if (Number.isInteger(idx.__lm_autocomplete_meta_text)) {
          // 搜索框文本：留空或写当前列表都行，写当前列表能顺手修好被旧版本写坏的槽位。
          wv[idx.__lm_autocomplete_meta_text] = loraText(entries)
          changed.push(`${loraNode.id}.meta`)
        }
        loraNode.widgets_values = wv
      }
    }
  }
  const animaNode = findNode(ui.byId, NID.anima, 'AnimaV5RandomPrompt', '')
  if (animaNode) {
    const idx = indexOf(animaNode)
    const wv = Array.isArray(animaNode.widgets_values) ? animaNode.widgets_values : []
    const write = (name, value) => {
      if (value === undefined || !Number.isInteger(idx?.[name])) return
      wv[idx[name]] = value
      changed.push(`${animaNode.id}.${name}`)
    }
    write('nsfw_level', settings.nsfwLevel)
    write('tag_cap', settings.mainTagCap)
    write('base_prob', settings.baseProb)
    write('outfit_style', settings.outfitStyle)
    write('breast_size', settings.breastSize)
    write('extra_body', settings.extraBody)
    write('appearance_follow', settings.appearanceFollow !== false)
    // V6 才有这两个控件；老工作流的 widgets 里没有对应槽位，write() 会自动跳过。
    write('dry_skin_filter', settings.drySkinFilter === true)
    write('duo_role_fill', settings.duoRoleFill !== false)
    // 作品 IP / 已选角色：两者互斥，只写当前生效的那个，另一个写空。
    if (settings.roleMode === 'work') {
      write('role_works', String(settings.workPick ?? '').trim())
      write('selected_roles', '')
    } else {
      write('role_works', '')
      write('selected_roles', normalizeRoleToken(settings.charPick || ''))
    }
    if (Number.isInteger(idx?.weights_json)) {
      const current = typeof wv[idx.weights_json] === 'string' ? wv[idx.weights_json] : ''
      let uiState = {}
      try {
        const parsed = JSON.parse(current)
        if (parsed?._ui) uiState = { _ui: parsed._ui }
      } catch { /* 忽略 */ }
      const compact = compactWeights(settings.panelWeights ?? {})
      const scene = typeof settings.forcedScene === 'string' ? settings.forcedScene.trim() : ''
      if (scene !== '') compact.forced = { n_canon: scene }
      wv[idx.weights_json] = Object.keys(compact).length === 0 && Object.keys(uiState).length === 0
        ? ''
        : JSON.stringify({ ...uiState, ...compact }, null, 1)
      changed.push(`${animaNode.id}.weights_json`)
    }
    animaNode.widgets_values = wv
  }

  const target = await targetWorkflowFile(cfg)
  if (!target) throw new Error('找不到要写回的工作流文件')
  const backup = `${target}.bak-${formatDate('yyyyMMdd-HHmmss')}`
  await fsp.copyFile(target, backup)
  await fsp.writeFile(target, JSON.stringify(ui.json, null, 2), 'utf8')
  log?.('info', `写回工作流 JSON：${changed.length} 项 → ${target}（备份 ${path.basename(backup)}）`)
  return { ok: true, changed, backup, target }
}

/* -------------------------------------------------------------- HTTP dispatch ---- */

/* ------------------------------------------------------------- applied ---- */

/**
 * 「当前套用」快照。
 *
 * 分两类：
 *   · global —— ComfyUI 侧的全局状态，写在 presets 文件里，改了立刻影响所有出图（可以真停用）
 *   · node   —— ComfyUI 工作流节点内存里的值（scene_pick / forced / 勾选池），
 *               我们改文件也不会让那个工作流生效，所以只提示「去弹窗里停用」
 */
const CHAR_OUTFIT_FILE = 'character_outfits.json'
const OUTFIT_LIB_FILE = 'outfit_library.json'
const V6_PREFIX = '/anima-wardrobe-v6'

let presetDirCache = ''
let outfitLibCache = { file: '', mtime: 0, data: null }
let charOutfitCache = { file: '', mtime: 0, map: new Map() }

function presetDirCandidates(cfg) {
  const roots = [
    cfg.comfyWorkdir ? path.join(cfg.comfyWorkdir, 'ComfyUI', 'custom_nodes') : '',
    cfg.comfyWorkdir ? path.join(cfg.comfyWorkdir, 'custom_nodes') : '',
    'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\custom_nodes',
  ].filter(Boolean)
  const dirs = []
  for (const name of ['Comfyui-Anima-Wardrobe-V6', 'Comfyui-Anima-Wardrobe-V5']) {
    for (const root of roots) dirs.push(path.join(root, name, 'presets'))
  }
  return dirs
}

async function fileExists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function resolvePresetDir(cfg) {
  if (cfg.presetDir) return cfg.presetDir
  if (presetDirCache) return presetDirCache
  for (const dir of presetDirCandidates(cfg)) {
    if (await fileExists(path.join(dir, OUTFIT_LIB_FILE)) || await fileExists(path.join(dir, CHAR_OUTFIT_FILE))) {
      presetDirCache = dir
      return dir
    }
  }
  return ''
}

async function readOutfitLibrary(presetDir) {
  const file = path.join(presetDir, OUTFIT_LIB_FILE)
  const stat = await fsp.stat(file)
  if (outfitLibCache.file === file && outfitLibCache.mtime === stat.mtimeMs && outfitLibCache.data) {
    return outfitLibCache.data
  }
  const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
  const meta = raw?._meta ?? {}
  const list = Array.isArray(raw?.outfits) ? raw.outfits : []
  const activeId = String(meta?.active ?? '').trim()
  const hit = activeId ? list.find((item) => String(item?.id ?? '') === activeId) : null
  const data = {
    active: activeId ? { id: activeId, zh: String(hit?.zh ?? activeId), cat: String(hit?.cat ?? '') } : null,
    pool: {
      on: meta?.pool?.on === true,
      count: Array.isArray(meta?.pool?.ids) ? meta.pool.ids.length : 0,
      cats: Array.isArray(meta?.pool?.cats) ? meta.pool.cats.map(String) : [],
    },
    socks: String(meta?.overrides?.socks ?? '').trim(),
    shoes: String(meta?.overrides?.shoes ?? '').trim(),
    sceneOverride: meta?.scene_override === true,
    total: Number(meta?.count ?? list.length) || list.length,
  }
  outfitLibCache = { file, mtime: stat.mtimeMs, data }
  return data
}

/** 角色服装预设：只抽 enabled 那一套（文件 19 MB，不整份留在内存里）。 */
async function readCharOutfits(presetDir) {
  const file = path.join(presetDir, CHAR_OUTFIT_FILE)
  const stat = await fsp.stat(file)
  if (charOutfitCache.file === file && charOutfitCache.mtime === stat.mtimeMs) return charOutfitCache.map
  const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
  const map = new Map()
  for (const [role, rec] of Object.entries(raw?.outfits ?? {})) {
    const id = String(rec?.enabled ?? '').trim()
    if (!id) continue
    const hit = (Array.isArray(rec?.list) ? rec.list : []).find((item) => String(item?.id ?? '') === id)
    const value = { id, zh: String(hit?.zh ?? id), role }
    // 文件里的键是 danbooru tag 写法（hyacine_(honkai:_star_rail)），
    // 而节点/面板用的是 trigger 写法（hyacine, honkai: star rail），两种都建索引。
    map.set(role, value)
    const alias = String(role).replace(/^(.+?)_\(([^()]+)\)$/u, (_all, name, work) => `${name}, ${String(work).replace(/_/gu, ' ')}`)
    if (alias && alias !== role) map.set(alias, value)
  }
  charOutfitCache = { file, mtime: stat.mtimeMs, map }
  return map
}

/** 最近一次提交的工作流里，1145 节点上的三个「节点项」。 */
async function readLastNodeInputs(cfg) {
  try {
    const res = await fetch(`${cfg.comfyUrl}/history?max_items=1`)
    if (!res.ok) return null
    const body = await res.json()
    const entries = Object.values(body ?? {})
    const api = entries[0]?.prompt?.[2]
    const inputs = api?.[NID.anima]?.inputs
    if (!inputs) return null
    let forced = ''
    try {
      const parsed = JSON.parse(String(inputs.weights_json ?? '{}'))
      forced = String(parsed?.forced?.n_canon ?? '').trim()
    } catch { /* 旧格式没有 forced */ }
    return {
      scenePick: inputs.scene_pick === true,
      forcedScene: forced,
      poolMode: String(inputs.pick_pool_mode ?? '').trim(),
      poolIds: String(inputs.pick_pool_ids ?? '').trim(),
      selectedRoles: String(inputs.selected_roles ?? '').trim(),
      roleWorks: String(inputs.role_works ?? '').trim(),
      nsfwLevel: String(inputs.nsfw_level ?? '').trim(),
    }
  } catch {
    return null
  }
}

async function buildApplied(cfg, log, settings) {
  const presetDir = await resolvePresetDir(cfg)
  const global = []
  const node = []
  let warning = ''
  if (!presetDir) {
    warning = '没找到 AnimaWardrobe 的 presets 目录（可在配置里指定 presetDir）'
  } else {
    try {
      const lib = await readOutfitLibrary(presetDir)
      if (lib.active) {
        global.push({
          key: 'outfit_active',
          label: '服装库',
          detail: lib.active.cat ? `${lib.active.zh} · ${lib.active.cat}` : lib.active.zh,
          disable: { item: 'outfit_active' },
        })
      }
      if (lib.pool.on) {
        global.push({
          key: 'outfit_pool',
          label: '池化随机',
          detail: `开启 · ${lib.pool.cats.join(' / ') || '全部'}${lib.pool.count ? `（${lib.pool.count} 套）` : ''}`,
          disable: { item: 'outfit_pool' },
        })
      }
      if (lib.socks) global.push({ key: 'outfit_socks', label: '袜子覆盖', detail: lib.socks, disable: { item: 'outfit_socks' } })
      if (lib.shoes) global.push({ key: 'outfit_shoes', label: '鞋子覆盖', detail: lib.shoes, disable: { item: 'outfit_shoes' } })
      if (lib.sceneOverride) {
        global.push({
          key: 'outfit_scene_override',
          label: '场景服装',
          detail: '服装库会覆盖场景推荐服装',
          disable: { item: 'outfit_scene_override' },
        })
      }
    } catch (error) {
      log?.('warn', `读 outfit_library.json 失败：${error?.message ?? error}`)
    }
    try {
      const map = await readCharOutfits(presetDir)
      // 只有「当前明确指定的角色」才可能用到角色服装预设；没选角色（全库随机）时不提示，
      // 否则会把这条当成正在生效的全局项误导用户。
      const wanted = String(settings?.charPick || settings?.selectedRoles || '').trim()
      const roleKey = wanted ? normalizeRoleToken(wanted).toLowerCase() : ''
      const hit = roleKey ? map.get(roleKey) : null
      if (hit) {
        global.push({
          key: 'char_outfit',
          label: '角色服装预设',
          detail: `当前角色「${roleKey}」启用：${hit.zh || hit.id}`,
          roles: [hit.role ?? hit.roleKey ?? roleKey],
          disable: { item: 'char_outfit', roles: [hit.role ?? hit.roleKey ?? roleKey] },
        })
      }
    } catch (error) {
      log?.('warn', `读 character_outfits.json 失败：${error?.message ?? error}`)
    }
  }
  const last = await readLastNodeInputs(cfg)
  if (last) {
    if (last.scenePick) {
      node.push({ key: 'scene_pick', label: '场景搭配', detail: '整库按档位随机', hint: '去弹窗里停用' })
    }
    if (last.forcedScene) {
      node.push({ key: 'forced_scene', label: '定点锁定', detail: last.forcedScene, hint: '去弹窗里停用' })
    }
    if (last.poolMode || last.poolIds) {
      node.push({
        key: 'pick_pool',
        label: '勾选池',
        detail: `${last.poolMode || 'pool'}${last.poolIds ? ` · ${last.poolIds.slice(0, 40)}` : ''}`,
        hint: '去弹窗里停用',
      })
    }
  }
  return { presetDir, global, node, last, warning }
}

async function v6Post(cfg, suffix, body) {
  const res = await fetch(`${cfg.comfyUrl}${V6_PREFIX}${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    throw new Error(json?.error ?? json?.message ?? `AnimaWardrobe 返回 HTTP ${res.status}`)
  }
  return json ?? {}
}

const DISABLE_ALL_ITEMS = ['outfit_active', 'outfit_pool', 'outfit_socks', 'outfit_shoes', 'outfit_scene_override', 'char_outfit']

async function disableApplied(cfg, log, item, roles) {
  if (item === 'all') {
    const done = []
    for (const each of DISABLE_ALL_ITEMS) {
      try {
        await disableApplied(cfg, log, each)
        done.push(each)
      } catch (error) {
        log?.('warn', `停用 ${each} 失败：${error?.message ?? error}`)
      }
    }
    return { disabled: done }
  }
  switch (item) {
    case 'outfit_active':
      await v6Post(cfg, '/outfit-library/enable', { id: '' })
      break
    case 'outfit_pool':
      await v6Post(cfg, '/outfit-library/pool', { on: false })
      break
    case 'outfit_socks':
      await v6Post(cfg, '/outfit-library/override', { field: 'socks', value: '' })
      break
    case 'outfit_shoes':
      await v6Post(cfg, '/outfit-library/override', { field: 'shoes', value: '' })
      break
    case 'outfit_scene_override':
      await v6Post(cfg, '/outfit-library/scene-override', { enabled: false })
      break
    case 'char_outfit': {
      const presetDir = await resolvePresetDir(cfg)
      if (!presetDir) throw new Error('没找到 presets 目录')
      const map = await readCharOutfits(presetDir)
      const targets = Array.isArray(roles) && roles.length ? roles.filter((role) => typeof role === 'string') : [...map.keys()]
      for (const role of targets) await v6Post(cfg, '/outfits/enable', { role, id: '' })
      charOutfitCache = { file: '', mtime: 0, map: new Map() }
      break
    }
    default:
      throw new Error(`未知的套用项：${item}`)
  }
  // 让下一次读取绕过缓存（V6 写完会 clear_cache，我们这边也要重读文件）
  outfitLibCache = { file: '', mtime: 0, data: null }
  return { disabled: [item] }
}

async function handleRequest(cfg, log, req, res, getSettings, setSettings) {
  if (!isLocalRequest(req)) {
    respondJson(res, { ok: false, reason: 'local requests only' }, 403)
    return
  }
  const url = requestUrl(req)
  const pathname = url.pathname
  const method = String(req.method ?? 'GET').toUpperCase()
  try {
    if (pathname.endsWith('/options.json') || pathname.endsWith('/refresh.json')) {
      respondJson(res, await buildOptions(cfg))
      return
    }
    if (pathname.endsWith('/state.json')) {
      if (method === 'POST') {
        const body = await readBody(req)
        const current = await getSettings()
        const next = normalizeState({ ...current, ...(body.settings ?? body), updatedAt: nowIso() })
        await setSettings(next)
        respondJson(res, { ok: true, state: next })
        return
      }
      respondJson(res, { ok: true, state: await getSettings() })
      return
    }
    if (pathname.endsWith('/images.json')) {
      const limit = Number(url.searchParams.get('limit') ?? 400)
      respondJson(res, { ok: true, images: await listImages(cfg, Number.isFinite(limit) ? limit : 400) })
      return
    }
    if (pathname.endsWith('/image.png') || pathname.endsWith('/image.jpg')) {
      await serveImage(cfg, res, url.searchParams.get('rel') ?? '')
      return
    }
    if (pathname.endsWith('/generate.json')) {
      const body = await readBody(req)
      const settings = await getSettings()
      const overrides = body.settings ?? body
      const weights = body.weights !== undefined
        ? mergeWeights(settings.panelWeights, body.weights)
        : settings.panelWeights
      const merged = normalizeState({
        ...settings,
        ...overrides,
        panelWeights: weights,
        weights,
      })
      const result = await generateOnce(cfg, log, { ...merged, weights })
      const rel = imageRelPath(cfg, result.files[0])
      await setSettings(normalizeState({ ...merged, weights }))
      respondJson(res, {
        ok: true,
        files: result.files,
        rel,
        url: `/anima-wardrobe/image.png?rel=${encodeURIComponent(rel)}`,
        seed: result.seed,
        seconds: result.seconds,
      })
      return
    }
    if (pathname.endsWith('/diag.json')) {
      if (method === 'POST') {
        let body = {}
        try {
          body = await readBody(req)
        } catch (error) {
          body = { raw: String(error?.message ?? error) }
        }
        const line = `${nowIso()} ${JSON.stringify(body)}\n`
        try {
          await fsp.appendFile(cfg.diagPath, line, 'utf8')
        } catch (error) {
          log?.('warn', `写诊断日志失败：${error?.message ?? error}`)
        }
        respondJson(res, { ok: true })
        return
      }
      let text = ''
      try {
        text = await fsp.readFile(cfg.diagPath, 'utf8')
      } catch { /* 还没写过 */ }
      respondJson(res, { ok: true, path: cfg.diagPath, log: text })
      return
    }
    if (pathname.endsWith('/sync-from-comfy.json')) {
      if (method !== 'POST') {
        respondJson(res, { ok: false, reason: '只支持 POST' }, 405)
        return
      }
      const current = await getSettings()
      let fresh
      try {
        fresh = await seedStateFromWorkflow(cfg, log)
      } catch (error) {
        respondJson(res, { ok: false, reason: `读取工作流失败：${error?.message ?? error}` })
        return
      }
      const merged = { ...fresh }
      const keep = ['modelProfiles', 'loraPresets', 'panelWeights', 'followPanel', 'useTiledVae', 'roleFeature', 'comfyCors', 'presetDir', 'diagPath', 'drySkinFilter', 'duoRoleFill', 'forcedScene']
      for (const key of keep) {
        if (current && current[key] !== undefined) merged[key] = current[key]
      }
      const next = normalizeState(merged)
      await setSettings(next)
      const source = await targetWorkflowFile(cfg)
      log?.('info', `从 ComfyUI 工作流同步：${source}`)
      respondJson(res, { ok: true, state: next, source })
      return
    }
    if (pathname.endsWith('/writeback.json')) {
      const settings = await getSettings()
      respondJson(res, await writeBackWorkflow(cfg, settings, log))
      return
    }
    if (pathname.endsWith('/applied.json')) {
      const appliedSettings = await getSettings()
      const snapshot = await buildApplied(cfg, log, appliedSettings)
      respondJson(res, {
        ok: true,
        online: await probeComfy(cfg),
        presetDir: snapshot.presetDir,
        warning: snapshot.warning,
        global: snapshot.global,
        node: snapshot.node,
        last: snapshot.last,
      })
      return
    }
    if (pathname.endsWith('/disable.json')) {
      if (method !== 'POST') {
        respondJson(res, { ok: false, reason: 'method not allowed' }, 405)
        return
      }
      const body = await readBody(req)
      const item = String(body.item ?? '').trim()
      if (!item) {
        respondJson(res, { ok: false, reason: '缺少 item' })
        return
      }
      const result = await disableApplied(cfg, log, item, body.roles)
      const disabledSettings = await getSettings()
      const snapshot = await buildApplied(cfg, log, disabledSettings)
      respondJson(res, {
        ok: true,
        ...result,
        global: snapshot.global,
        node: snapshot.node,
        warning: snapshot.warning,
      })
      return
    }
    if (pathname.endsWith('/comfy-url.json')) {
      respondJson(res, {
        ok: true,
        online: await probeComfy(cfg),
        url: cfg.comfyUrl,
        panelUrl: (() => { const wf = normalizeWorkflowName(cfg.workflowFile); return `${cfg.comfyUrl}/?dshPanel=1${wf ? `&dshWorkflow=${encodeURIComponent(wf)}` : ''}` })(),
      })
      return
    }
    if (pathname.endsWith('/status.json')) {
      respondJson(res, { ok: true, ...(await comfyStatus(cfg)) })
      return
    }
    if (pathname.endsWith('/launch.json')) {
      if (method !== 'POST') {
        respondJson(res, { ok: false, reason: 'method not allowed' }, 405)
        return
      }
      respondJson(res, { ok: true, ...(await startComfy(cfg, log)) })
      return
    }
    if (pathname.endsWith('/stop.json')) {
      if (method !== 'POST') {
        respondJson(res, { ok: false, reason: 'method not allowed' }, 405)
        return
      }
      respondJson(res, { ok: true, ...(await stopComfy(cfg, log)) })
      return
    }
    respondJson(res, { ok: false, reason: 'not found' }, 404)
  } catch (error) {
    diagnostics.lastError = String(error?.message ?? error)
    log?.('warn', `请求处理失败：${diagnostics.lastError}`)
    respondJson(res, { ok: false, reason: diagnostics.lastError })
  }
}

/* ---------------------------------------------------------------------- tool ---- */

function toolParameters() {
  return {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '追加到正向提示词末尾的自然语言补充（写进 Anima 的 extra_body，例如「雨中的天台，湿透的制服」）。只调权重时可省略。',
      },
      weights: {
        type: 'object',
        description:
          '三层提示词权重：{ sections?: {段id: 权重}, fields?: {字段key: 权重}, options?: {字段key: {英文tag: 权重}} }。'
          + '权重 0=关闭、1=默认、3=必现（上限 3）。段 id 例如 hair/cloth_sfw/pose_nsfw；字段 key 例如 hair_len/outfit。',
        properties: {
          sections: { type: 'object', additionalProperties: { type: 'number' } },
          fields: { type: 'object', additionalProperties: { type: 'number' } },
          options: {
            type: 'object',
            additionalProperties: { type: 'object', additionalProperties: { type: 'number' } },
          },
        },
        additionalProperties: false,
      },
      followPanel: {
        type: 'boolean',
        description: '本次是否让面板里配置的三层权重参与（默认按面板上的「模型参考页面配置」开关）。true 时以页面权重为底、weights 参数再覆盖；false 时只用 weights 参数。',
      },
      nsfwLevel: { type: 'string', enum: NSFW_LEVELS, description: '内容档位，默认沿用面板设置。' },
      seed: { type: 'integer', description: '随机种子；不传则随机。' },
      width: { type: 'integer', description: '宽度（像素），与 height 一起可覆盖画幅。' },
      height: { type: 'integer', description: '高度（像素）。' },
      batchSize: { type: 'integer', description: '张数，默认 1。' },
      steps: { type: 'integer', description: '采样步数，默认沿用面板。' },
      guidance: { type: 'number', description: 'CFG，默认沿用面板。' },
      sampler: { type: 'string', description: '采样器，例如 er_sde / euler / dpmpp_2m；默认沿用面板。' },
      scheduler: { type: 'string', description: '调度器，例如 beta / simple / karras；默认沿用面板。' },
      role: {
        type: 'string',
        description: '指定角色（写进 Anima 的 selected_roles），例如 hakurei reimu 或 robin_(honkai:_star_rail)；会归一成 trigger 写法。与 work 互斥，给了它以角色为准。',
      },
      work: {
        type: 'string',
        description: '限定作品 IP（写进 Anima 的 role_works），例如 honkai: star rail / 崩坏：星穹铁道；每次从该作品里随机抽角色。只有没给 role 时生效。',
      },
      rolePick: {
        type: 'boolean',
        description:
          '这一张要不要抽 IP 角色（写进 role_pick）。不传时插件自动判断：'
          + 'weights 里指定了发色/瞳色/发型/体型等「人物特征」字段 → 自动关掉抽角色（否则这些权重会被引擎静默忽略）；'
          + '否则沿用面板。想强制「随机抽角色但外观仍听权重」是做不到的，只能二选一。',
      },
      outfitStyle: { type: 'string', description: '服装风格，例如 日常、泳装、女仆。' },
      breastSize: { type: 'string', description: '胸部档位：不指定/平胸/小胸/中等/大胸/巨乳/爆乳。' },
      drySkinFilter: {
        type: 'boolean',
        description:
          '（AnimaWardrobe V6）禁止汗 / 湿润类标签，写进 dry_skin_filter。默认沿用面板（面板默认关）。'
          + '想要「干爽无汗」的画面就设 true；V5 节点没有这个输入，传了不生效。',
      },
      duoRoleFill: {
        type: 'boolean',
        description:
          '（AnimaWardrobe V6）双女自动补位，写进 duo_role_fill。默认沿用面板（面板默认开）。'
          + '只选了 1 位角色但画面是多人时，自动补同作品另一位女性，避免把同一个人画两遍；'
          + '设 false = 完全不介入、不消耗随机数。',
      },
      forcedScene: {
        type: 'string',
        description:
          '（AnimaWardrobe V6）按场景 id 定点锁定，写进 weights_json 的 forced.n_canon，'
          + '例如 sc_cafe_window_rain / sc_night_rooftop。优先级高于整库随机与权重池；'
          + '传空串 = 不锁定。场景 id 见面板/场景库文件名（presets/scene_thumbs 的名字去掉 sc_ 前缀前的写法请以库内 id 为准）。',
      },
      clip: { type: 'string', description: '覆盖全局 CLIP 模型文件名。' },
      vae: { type: 'string', description: '覆盖全局 VAE 文件名。' },
      unet: { type: 'string', description: '覆盖 UNet 模型文件名。' },
      loras: {
        type: 'array',
        description: '覆盖 LoRA 列表；不传则沿用面板。',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            strength: { type: 'number' },
          },
          required: ['name'],
        },
      },
      negative: { type: 'string', description: '覆盖负向词。' },
      quality: { type: 'string', description: '覆盖质量词（正向拼接的固定前缀）。' },
    },
    required: [],
  }
}

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '第一张图的绝对路径。' },
      files: { type: 'array', items: { type: 'string' }, description: '本次产出的全部图片路径。' },
      width: { type: 'number' },
      height: { type: 'number' },
      seed: { type: 'number' },
      seconds: { type: 'number' },
      weightCount: { type: 'number', description: '实际生效的权重条目数。' },
      usedWeights: { type: 'object', description: '实际生效的三层权重。' },
      diagnostics: {
        type: 'object',
        description: '引擎回传的诊断摘要：哪些权重真的生效、哪些被跳过、角色是否被自动关掉。',
        properties: {
          rolePickAuto: { type: 'boolean' },
          appearanceKeys: { type: 'array', items: { type: 'string' } },
          weightLine: { type: 'string' },
          forced: { type: 'array', items: { type: 'string' } },
          weighted: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
          backgroundSuppressed: { type: 'boolean' },
          appliedGlobal: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    required: ['path', 'files'],
  },
  render: (_args, value) => {
    const lines = [`已出图：${value.path}（${value.width}x${value.height}，seed ${value.seed}，用时 ${value.seconds}s，权重 ${value.weightCount} 项）`]
    const d = value.diagnostics ?? {}
    if (d.rolePickAuto === true) {
      lines.push(`· 自动关闭了「随机 IP 角色」（权重里指定了 ${(d.appearanceKeys ?? []).join('、')}），本张按纯词库人物出图`)
    }
    if (d.weightLine) lines.push(`· 引擎：${d.weightLine}`)
    if ((d.forced ?? []).length > 0) lines.push(`· 强制出现：${d.forced.join('、')}`)
    if ((d.weighted ?? []).length > 0) lines.push(`· 权重命中：${d.weighted.slice(0, 8).join('；')}`)
    if ((d.warnings ?? []).length > 0) lines.push(`· ⚠ ${d.warnings.slice(0, 6).join('；')}`)
    if ((d.notes ?? []).length > 0) lines.push(`· ${d.notes.slice(0, 3).join('；')}`)
    if ((d.appliedGlobal ?? []).length > 0) {
      lines.push(`· ⚠ 全局套用正在接管本图：${d.appliedGlobal.slice(0, 3).join('；')}（面板「当前套用」里可停用）`)
    }
    if (d.backgroundSuppressed === true) {
      lines.push('· 注意：默认负向词里有 simple background，会压制「纯色/干净背景」的诉求')
    }
    return [{ type: 'text', text: lines.join('\n') }]
  },
  presentationMeta: (_args, value) => ({ path: value.path }),
}

function makeTool(cfg, log, readSettings, writeSettings, onProduced) {
  return {
    name: 'anima_draw',
    description:
      '用本机 ComfyUI + AnimaWardrobe V5 工作流出图。模型、负向词、质量词、LoRA、画幅默认来自侧边栏「Anima 工坊」面板，'
      + '也可以用参数覆盖。核心能力是用 weights 控制「Anima 提示词随机生成」里各段/字段/选项的权重（0=关闭，1=默认，3=必现），'
      + '按角色或画面需要调整随机提示词的倾向。图片保存到本机，返回绝对路径用于回复里内联展示。纯本地运行。',
    parameters: toolParameters(),
    timeoutMs: cfg.timeoutMs + 60000,
    output: TOOL_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const signal = exec?.signal
      const settings = await readSettings()
      const followPanel = typeof args?.followPanel === 'boolean' ? args.followPanel : settings.followPanel !== false
      const base = followPanel ? settings.panelWeights : { sections: {}, fields: {}, options: {} }
      const weights = mergeWeights(base, args?.weights ?? {})
      const loras = Array.isArray(args?.loras)
        ? args.loras.map((l) => ({
          name: String(l?.name ?? ''),
          strength: Number.isFinite(Number(l?.strength)) ? Number(l.strength) : 1,
          clipStrength: Number.isFinite(Number(l?.strength)) ? Number(l.strength) : 1,
          active: true,
        })).filter((l) => l.name !== '')
        : settings.loras

      const extraBody = typeof args?.prompt === 'string' && args.prompt.trim() !== ''
        ? [settings.extraBody, args.prompt.trim()].filter((x) => x !== '').join('\n')
        : settings.extraBody

      const overridesForRun = {
        width: Number.isInteger(args?.width) && args.width > 0 ? args.width : settings.width,
        height: Number.isInteger(args?.height) && args.height > 0 ? args.height : settings.height,
        batchSize: Number.isInteger(args?.batchSize) && args.batchSize > 0 ? args.batchSize : 1,
        steps: Number.isInteger(args?.steps) && args.steps > 0 ? args.steps : settings.steps,
        guidance: Number.isFinite(Number(args?.guidance)) ? Number(args.guidance) : settings.guidance,
        sampler: typeof args?.sampler === 'string' && args.sampler !== '' ? args.sampler : settings.sampler,
        scheduler: typeof args?.scheduler === 'string' && args.scheduler !== '' ? args.scheduler : settings.scheduler,
        // 采样偏移跟随面板 / 档案（工具不单独暴露这个参数）。
        useAuraFlow: typeof args?.useAuraFlow === 'boolean' ? args.useAuraFlow : settings.useAuraFlow === true,
        auraFlowShift: Number.isFinite(Number(args?.auraFlowShift)) ? Number(args.auraFlowShift) : settings.auraFlowShift,
        useTiledVae: typeof args?.useTiledVae === 'boolean' ? args.useTiledVae : settings.useTiledVae === true,
        seed: Number.isSafeInteger(args?.seed) && args.seed >= 0 ? args.seed : -1,
        negative: typeof args?.negative === 'string' && args.negative.trim() !== '' ? args.negative : settings.negative,
        quality: typeof args?.quality === 'string' && args.quality.trim() !== '' ? args.quality : settings.quality,
        clip: typeof args?.clip === 'string' && args.clip !== '' ? { ...settings.clip, name: args.clip } : settings.clip,
        vae: typeof args?.vae === 'string' && args.vae !== '' ? args.vae : settings.vae,
        unet: typeof args?.unet === 'string' && args.unet !== '' ? args.unet : settings.unet,
        clipOverride: undefined,
        nsfwLevel: typeof args?.nsfwLevel === 'string' && NSFW_LEVELS.includes(args.nsfwLevel)
          ? args.nsfwLevel : settings.nsfwLevel,
        // 角色只认面板/工具传来的 charPick：不再兜底 settings.selectedRoles，
        // 否则用户清空选择后，工作流里读到的旧值会被重新写回去。
        selectedRoles: typeof args?.role === 'string' && args.role.trim() !== ''
          ? args.role.trim()
          : '',
        roleMode: typeof args?.role === 'string' && args.role.trim() !== ''
          ? 'role'
          : (typeof args?.work === 'string' && args.work.trim() !== '' ? 'work' : settings.roleMode),
        charPick: typeof args?.role === 'string' && args.role.trim() !== ''
          ? args.role.trim()
          : settings.charPick,
        workPick: typeof args?.work === 'string' && args.work.trim() !== ''
          ? args.work.trim()
          : settings.workPick,
        outfitStyle: typeof args?.outfitStyle === 'string' && args.outfitStyle !== '' ? args.outfitStyle : settings.outfitStyle,
        breastSize: typeof args?.breastSize === 'string' && args.breastSize !== '' ? args.breastSize : settings.breastSize,
        mainTagCap: settings.mainTagCap,
        baseProb: settings.baseProb,
        rolePick: typeof args?.rolePick === 'boolean' ? args.rolePick : settings.rolePick,
        rolePickExplicit: typeof args?.rolePick === 'boolean',
        scenePick: settings.scenePick,
        appearanceFollow: settings.appearanceFollow,
        drySkinFilter: typeof args?.drySkinFilter === 'boolean' ? args.drySkinFilter : settings.drySkinFilter === true,
        duoRoleFill: typeof args?.duoRoleFill === 'boolean' ? args.duoRoleFill : settings.duoRoleFill !== false,
        forcedScene: typeof args?.forcedScene === 'string' ? args.forcedScene.trim() : (settings.forcedScene ?? ''),
        extraBody,
        loras,
        aspectRatio: settings.aspectRatio,
        weights,
      }
      // 画幅与宽高：给了宽高就按宽高；只给 aspectRatio 时用预设比例计算
      const aspectMap = {
        '1:1 (Square)': [1, 1],
        '2:3 (Portrait Photo)': [2, 3],
        '3:2 (Photo)': [3, 2],
        '3:4 (Portrait Standard)': [3, 4],
        '4:3 (Standard)': [4, 3],
        '9:16 (Portrait Widescreen)': [9, 16],
        '16:9 (Widescreen)': [16, 9],
        '21:9 (Ultrawide)': [21, 9],
      }
      if (!Number.isInteger(args?.width) && !Number.isInteger(args?.height)) {
        const ratio = aspectMap[settings.aspectRatio]
        if (Array.isArray(ratio)) {
          const longer = Math.max(settings.width, settings.height)
          const rw = ratio[0] / ratio[1]
          overridesForRun.width = Math.round(Math.round((rw >= 1 ? longer : longer * rw) / 16) * 16)
          overridesForRun.height = Math.round(Math.round((rw >= 1 ? longer / rw : longer) / 16) * 16)
        }
      }

      let weightWarnings = []
      try {
        weightWarnings = validateWeights(weights, await loadFields(cfg))
      } catch (error) {
        log('warn', `权重校验失败：${error?.message ?? error}`)
      }

      const result = await generateOnce(cfg, log, overridesForRun, {}, signal)
      const diag = summarizeReport(result.report)
      // 全局套用（服装库 / 角色服装预设）会绕过节点参数接管画面，回执里明确点出来。
      let appliedGlobal = []
      try {
        const snapshot = await buildApplied(cfg, log, settings)
        appliedGlobal = (snapshot.global ?? []).map((item) => `${item.label}「${item.detail}」`)
      } catch (error) {
        log('warn', `读取套用快照失败：${error?.message ?? error}`)
      }
      // 「纯色/干净背景」这类诉求会被默认负向词里的 simple background 对冲，命中时提示一句。
      const wantsPlainBg = /simple background|plain background|clean background|纯色|干净背景|plain bg/iu.test(extraBody)
      const value = {
        path: result.files[0],
        files: result.files,
        width: overridesForRun.width,
        height: overridesForRun.height,
        seed: result.seed,
        seconds: result.seconds,
        weightCount: countWeights(weights),
        usedWeights: compactWeights(weights),
        diagnostics: {
          rolePickAuto: result.autoRolePick?.applied === true,
          appearanceKeys: result.autoRolePick?.appearanceKeys ?? [],
          weightLine: diag.weightLine,
          forced: diag.forced,
          weighted: diag.weighted,
          warnings: [...weightWarnings, ...diag.warnings],
          notes: diag.notes,
          backgroundSuppressed: wantsPlainBg && /simple background/iu.test(overridesForRun.negative ?? ''),
          appliedGlobal,
        },
      }
      try {
        onProduced?.(exec, value)
      } catch (error) {
        log('warn', `登记交付物失败：${error?.message ?? error}`)
      }
      return value
    },
  }
}

/* --------------------------------------------------------------------- entry ---- */

export function apply(root, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = makeLog(root)
  if (typeof root.inject !== 'function') {
    log('warn', '宿主没有 root.inject，面板与出图工具都没有注册')
    return
  }

  const readSettings = async () => readState(cfg, log)
  const writeSettings = async (state) => writeState(cfg, normalizeState(state), log)

  root.inject(['tools', 'sessionProjections'], (ctx) => {
    const pending = new WeakMap()
    const onProduced = (exec, value) => {
      const session = exec?.agent?.session
      if (session === undefined) return
      let turn
      try {
        const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
        turn = boundary?.lastTurn
      } catch {
        turn = undefined
      }
      if (!Number.isSafeInteger(turn)) return
      pending.set(exec, {
        session,
        turn,
        files: value.files.map((file) => ({ path: file, description: 'Anima 出图' })),
      })
    }

    try {
      ctx.tools.register(makeTool(cfg, log, readSettings, writeSettings, onProduced))
      log('info', `已注册工具 anima_draw（ComfyUI=${cfg.comfyUrl}，输出=${cfg.outputRoot}）`)
    } catch (error) {
      log('warn', `注册 anima_draw 失败：${error?.message ?? error}`)
    }

    ctx.on('tools/result', (exec, result) => {
      const delivery = pending.get(exec)
      pending.delete(exec)
      if (delivery === undefined || result?.isError) return
      try {
        delivery.session.append('deliverables/presented', {
          turn: delivery.turn,
          callId: exec.callId,
          files: delivery.files,
        })
        diagnostics.lastDelivery = { at: Date.now(), callId: exec.callId, files: delivery.files.map((f) => f.path) }
      } catch (error) {
        log('warn', `append deliverables/presented 失败：${error?.message ?? error}`)
      }
    })

    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        systemPrompt.section({
          name: 'anima-wardrobe:inline-image',
          order: 9100,
          text:
            '用 anima_draw 出图后，必须在回复正文里用 Markdown 图片语法直接展示图片：'
            + '![画面简述](<图片的绝对路径>)。不要只给路径或链接，也不要把路径放进代码块。',
        })
        systemPrompt.section({
          name: 'anima-wardrobe:weights',
          order: 9102,
          text:
            '用户要生成图片（画个…/来张…/生成一张…）时调用 anima_draw，一次只出一张（除非明确要多张）。\n'
            + '【prompt 只放质量词与自然语言】prompt 参数只用于质量词（masterpiece, best quality…）和自然语言画面描述（「雨中的天台，湿透的制服」）。'
            + '不要把它当 danbooru 标签桶：pink hair / miniskirt 这类标准英文标签走 weights，写进 prompt 会和随机段重复甚至互相打架。\n'
            + '【用权重调倾向，不要靠关段】三层权重：sections 控整段、fields 控单个字段、options 控具体选项（键是选项的英文 tag，小写）。'
            + '0=关闭该倾向、1=默认、2=提高倾向、3=必现（上限 3）。'
            + '想要某样东西就给 2 或 3；只有确实要排除某类内容时才用 0。'
            + '不要为了「让画面听我的」把 sections 大面积设成 0 —— 关掉整段会把那类内容彻底抽空（scene 关掉就没有环境、pose_sfw 关掉就没有姿势），'
            + '画面会变空洞。一次挑 3–8 项就够，不要把所有字段都设 3。\n'
            + '【人物特征会关闭角色随机】hair_color / eyes_color / hair_len / hair_tie / hair_curl / hair_acc / figure / skin / face_shape 这 9 个属于「人物特征」。'
            + '没指定角色时，只要你在 weights 里动了它们，插件会自动把角色随机关掉（本张出纯词库人物）—— 否则引擎会静默忽略这些权重。'
            + '想抽 IP 角色，就不要给这 9 个字段权重。\n'
            + '【点名单品】要指定下装 / 鞋 / 袜时，权重给 3 并把整装 outfit 设成 0，否则整装会顶掉单品。\n'
            + '【面板打底】面板「模型参考页面配置」开关决定页面权重是否打底：开 = 页面配置为基础、weights 覆盖；关 = 只看 weights 参数。\n'
            + '【先读回执再决定要不要重出】出图回执会附：自动关角色的说明、引擎的「已调 N 项权重 / 强制出现 / 权重命中」、以及 ⚠ 警告'
            + '（点名项被联动消解剔除、词库不认的 tag、同字段互斥降级）。看到 ⚠ 就按提示改权重，不要重复同样的调用。\n'
            + '【角色与作品】指定角色用 role（如 hakurei reimu 或 robin_(honkai:_star_rail)）；只限定作品、每次换人用 work（如 honkai: star rail）；两者互斥，给 role 时以 role 为准。\n'
            + '【V6 新参数】drySkinFilter=true 禁止汗/湿润标签（要干爽画面时用）；duoRoleFill=false 关闭「双女自动补位」'
            + '（只选 1 位角色画多人时，默认会自动补同作品另一位女性，避免画成同一个人的两倍）；'
            + 'forcedScene 写场景 id（如 sc_cafe_window_rain）可定点锁定场景，优先于整库随机。这三个只在 AnimaWardrobe V6 上生效。',
        })
        log('info', '已注册 systemPrompt 段落')
      }
    } catch (error) {
      log('warn', `注册 systemPrompt 段落失败：${error?.message ?? error}`)
    }
  })

  root.inject(['webServer'], (ctx) => {
    const paths = [
      '/api/anima-wardrobe/options.json',
      '/api/anima-wardrobe/refresh.json',
      '/api/anima-wardrobe/state.json',
      '/api/anima-wardrobe/images.json',
      '/api/anima-wardrobe/image.png',
      '/api/anima-wardrobe/generate.json',
      '/api/anima-wardrobe/writeback.json',
  '/api/anima-wardrobe/sync-from-comfy.json',
      '/api/anima-wardrobe/diag.json',
      '/api/anima-wardrobe/status.json',
      '/api/anima-wardrobe/launch.json',
      '/api/anima-wardrobe/stop.json',
      '/api/anima-wardrobe/applied.json',
      '/api/anima-wardrobe/disable.json',
      '/api/anima-wardrobe/comfy-url.json',
      '/anima-wardrobe/options.json',
      '/anima-wardrobe/refresh.json',
      '/anima-wardrobe/state.json',
      '/anima-wardrobe/images.json',
      '/anima-wardrobe/image.png',
      '/anima-wardrobe/generate.json',
      '/anima-wardrobe/writeback.json',
  '/anima-wardrobe/sync-from-comfy.json',
      '/anima-wardrobe/diag.json',
      '/anima-wardrobe/status.json',
      '/anima-wardrobe/launch.json',
      '/anima-wardrobe/stop.json',
      '/anima-wardrobe/applied.json',
      '/anima-wardrobe/disable.json',
      '/anima-wardrobe/comfy-url.json',
    ]
    try {
      ctx.effect(() => {
        const disposers = paths.map((routePath) => ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: (req, res) => handleRequest(cfg, log, req, res, readSettings, writeSettings),
        }))
        log('info', `已注册面板接口（${paths.length} 条路径）`)
        return () => { for (const dispose of disposers) dispose() }
      }, 'anima-wardrobe:routes')
    } catch (error) {
      log('warn', `注册面板接口失败：${error?.message ?? error}`)
    }
  })
}

/** 供自测使用的内部导出。 */
export const __internal = {
  DEFAULTS,
  buildWorkflow,
  compactWeights,
  mergeWeights,
  lenient,
  countWeights,
  deriveWidgetIndex,
  expandDateTokens,
  formatDate,
  loadFields,
  loadRoster,
  roleFeaturePrefix,
  withRoleFeatures,
  appearanceWeightKeys,
  summarizeReport,
  validateWeights,
}
