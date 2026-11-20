/**
 * dsh-spend-meter —— Host 半端
 * ============================================================================
 * 算三件事，用一条本机 HTTP 路由（/api/dsh-spend-meter/snapshot）交给 Client 半端：
 *   1. 余额：DeepSeek 账号服务（ctx.get('deepseekAccount')）里的充值 + 赠送钱包。
 *   2. 当日消耗：把「今天」的 assistant/message 事件里的 token 用量按官方价目折成钱；
 *      高峰/空闲按每条消息发生的那一刻判定，所以跨时段的会话也能拆准。
 *   3. 闲忙时：北京时间周一至周五 09:00-12:00、14:00-18:00 为高峰，其余为空闲（半价）。
 *
 * 数据口径（重要）：
 *   - 进程里第一次被请求时才扫描（避免拖慢宿主启动）；
 *   - 扫描候选 = 今天改动过的会话日志（按持久化快照的 mtime）+ 当前活着的会话；
 *   - 之后靠 'session/event' 增量记账，用 sessionId:seq 去重；
 *   - 每 5 分钟补扫一次，跨北京时间零点自动清账；
 *   - 只统计 provider 名字里带 deepseek 的调用；别的模型只计次不折钱（unpricedCalls）。
 *
 * 可选 config（写在 profile 的 cordis.patch.yml 这条行上）：
 *   holidays: string[]  —— 额外的法定节假日（北京日期 YYYY-MM-DD），当天按空闲计
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'spend-meter'
export const inject = ['webServer']

const VERSION = '1.0.0'
const ROUTE_PREFIX = '/api/dsh-spend-meter'
const SNAPSHOT_PATH = '/api/dsh-spend-meter/snapshot'
const DETAIL_PATH = '/api/dsh-spend-meter/detail'
const BUDGET_PATH = '/api/dsh-spend-meter/budget'
/** 北京时间固定 UTC+8（无夏令时），直接做偏移比 Intl 便宜也更稳。 */
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** 高峰窗口（北京时间分钟数，左闭右开）：09:00-12:00、14:00-18:00。 */
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
/** 余额缓存：别把平台接口打成靶子。 */
const BALANCE_TTL_MS = 90_000
/** 补扫间隔：兜住增量记账可能漏掉的边角。 */
const RESCAN_MS = 5 * 60_000

/**
 * 官方价目（每百万 tokens）的「高峰价」，空闲时段按一半计。
 * 来源：DeepSeek 官方「模型 & 价格」页，2026-11-18 版。
 */
const PRICES = {
  CNY: {
    'deepseek-flash': { hit: 0.04, miss: 2, out: 8 },
    'deepseek-v4-pro': { hit: 0.3, miss: 9, out: 27 },
  },
  USD: {
    'deepseek-flash': { hit: 0.006, miss: 0.3, out: 1.2 },
    'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96 },
  },
}

const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' }

/** 预算默认值：默认关闭，日上限 20 元，用到 90% 开始提示。 */
const BUDGET_DEFAULT = Object.freeze({ enabled: false, limit: 20, threshold: 0.9 })

/** 预算配置落在 DSH 家目录下，跟 profile 的 patch 分开存，读写都不碰用户的配置层。 */
function budgetFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'spend-meter', 'budget.json')
}

/** 把外部读进来的值收敛成合法预算，坏数据一律回落到默认值。 */
function normalizeBudget(value) {
  const rawLimit = Number(value?.limit)
  const rawThreshold = Number(value?.threshold)
  return {
    enabled: value?.enabled === true,
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100_000) : BUDGET_DEFAULT.limit,
    threshold: Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold < 1
      ? rawThreshold
      : BUDGET_DEFAULT.threshold,
  }
}

/** 读预算；文件不存在或损坏都返回默认值，不抛。 */
function readBudgetFile() {
  try {
    return normalizeBudget(JSON.parse(readFileSync(budgetFilePath(), 'utf8')))
  } catch {
    return { ...BUDGET_DEFAULT }
  }
}

/** 原子写预算（临时文件 + rename），失败只记日志。 */
function writeBudgetFile(next) {
  try {
    const path = budgetFilePath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2))
    renameSync(tmp, path)
    return true
  } catch (error) {
    console.warn('[spend-meter] 保存预算失败：', error?.message ?? error)
    return false
  }
}

/** 北京时间日期键（YYYY-MM-DD），用作「今天」的账本键。 */
function bjDayKey(ms) {
  const d = new Date(ms + BJ_OFFSET_MS)
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${month}-${day}`
}

/** 北京时间当天 00:00 对应的毫秒时间戳。 */
function bjDayStart(ms) {
  const d = new Date(ms + BJ_OFFSET_MS)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BJ_OFFSET_MS
}

/** 某一刻是否处于高峰时段。 */
function isPeakAt(ms, holidays) {
  const d = new Date(ms + BJ_OFFSET_MS)
  const weekday = d.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  if (holidays.has(bjDayKey(ms))) return false
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to)
}

/** 下一次闲忙切换的时刻；未来 10 天内没有切换（极长连休）则返回 null。 */
function nextChangeAt(now, holidays) {
  const current = isPeakAt(now, holidays)
  const start = bjDayStart(now)
  const edges = []
  for (let i = 0; i < 10; i += 1) {
    for (const [from, to] of PEAK_WINDOWS) {
      edges.push(start + i * DAY_MS + from * 60_000)
      edges.push(start + i * DAY_MS + to * 60_000)
    }
  }
  edges.sort((a, b) => a - b)
  for (const at of edges) {
    if (at > now && isPeakAt(at, holidays) !== current) return at
  }
  return null
}

/** 把模型名收敛到价目表里的键；认不出返回 null。 */
function modelKeyOf(model) {
  const name = String(model ?? '').toLowerCase()
  if (name.includes('pro')) return 'deepseek-v4-pro'
  if (name.includes('flash')) return 'deepseek-flash'
  return null
}

/** 空账本 / 清账。 */
function emptyLedger(dayKey) {
  return {
    dayKey,
    /** modelKey -> { peak: {hit,miss,out}, off: {hit,miss,out} }，纯 token 数，不掺币种。 */
    buckets: new Map(),
    /** 按会话维度：sessionId -> (modelKey -> {peak,off})，用来给详情弹窗拆到会话。 */
    sessionBuckets: new Map(),
    /** `${sessionId}:${seq}`，防重算。 */
    seen: new Set(),
    sessions: new Set(),
    /** 非 DeepSeek 模型（只计次、不折钱）的消息数。 */
    unpricedCalls: 0,
  }
}

/**
 * 侧栏条目：余额 / 今日消耗 / 闲忙时段。
 * @param ctx Cordis 上下文。
 * @param rawConfig 这条插件行的 config（可选）。
 */
export function apply(ctx, rawConfig) {
  const holidays = new Set(
    Array.isArray(rawConfig?.holidays)
      ? rawConfig.holidays.filter((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
      : [],
  )

  let ledger = emptyLedger(bjDayKey(Date.now()))
  let budget = readBudgetFile()
  /** 最近一次读到的账号币种，预算闸门同步判超额时用它。 */
  let lastCurrency = 'CNY'
  /** 本次运行里被预算闸门拦下的模型请求数，给界面一个可见的反馈。 */
  let blockedCount = 0
  let scanInFlight = null
  let lastScanAt = 0
  let balanceAt = 0
  let balance = { status: 'unknown' }

  /** 跨零点时清账：账本只记得住"今天"。 */
  function rollDay(now) {
    const key = bjDayKey(now)
    if (key === ledger.dayKey) return
    ledger = emptyLedger(key)
    // 新的一天必须重扫：昨天的账本已经清空，扫描结果要重新建立。
    lastScanAt = 0
  }

  /** 取（或建）一个 { peak, off } 桶。 */
  function bucketFor(map, key) {
    let buckets = map.get(key)
    if (buckets === undefined) {
      buckets = { peak: { hit: 0, miss: 0, out: 0 }, off: { hit: 0, miss: 0, out: 0 } }
      map.set(key, buckets)
    }
    return buckets
  }

  /** 把一条用量加进某个时段的桶。 */
  function addUsage(buckets, window, hit, miss, out) {
    const target = buckets[window]
    target.hit += hit
    target.miss += miss
    target.out += out
  }

  /** 一组（modelKey -> buckets）折算成钱，供会话/总账复用。 */
  function costOf(currency, bucketsByModel, windowFilter = null, offFactor = 0.5) {
    const table = PRICES[currency] ?? PRICES.CNY
    let amount = 0
    for (const [modelKey, buckets] of bucketsByModel) {
      const price = table[modelKey]
      if (price === undefined) continue
      for (const window of ['peak', 'off']) {
        if (windowFilter !== null && window !== windowFilter) continue
        const bucket = buckets[window]
        const factor = window === 'off' ? offFactor : 1
        amount += factor * (bucket.hit * price.hit + bucket.miss * price.miss + bucket.out * price.out) / 1_000_000
      }
    }
    return amount
  }

  /** 记一条 assistant/message 的用量。 */
  function ingest(sessionId, event) {
    rollDay(Number(event?.time) || Date.now())
    const usage = event?.data?.usage
    if (!usage) return
    const key = `${sessionId}:${event.seq}`
    if (ledger.seen.has(key)) return
    ledger.seen.add(key)
    ledger.sessions.add(sessionId)
    const source = event.data?.message?.source ?? {}
    const provider = String(source.provider ?? '').toLowerCase()
    const modelKey = provider.includes('deepseek') ? modelKeyOf(source.model) : null
    if (modelKey === null) {
      ledger.unpricedCalls += 1
      return
    }
    // 缓存命中、缓存未命中（含缓存写入）、输出是三桶互不重叠的口径。
    const fineHit = Number(usage.cacheReadTokens) || 0
    const fineMiss = (Number(usage.inputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
    const fineOut = Number(usage.outputTokens) || 0
    const window = isPeakAt(Number(event.time), holidays) ? 'peak' : 'off'

    addUsage(bucketFor(ledger.buckets, modelKey), window, fineHit, fineMiss, fineOut)
    let byModel = ledger.sessionBuckets.get(sessionId)
    if (byModel === undefined) {
      byModel = new Map()
      ledger.sessionBuckets.set(sessionId, byModel)
    }
    addUsage(bucketFor(byModel, modelKey), window, fineHit, fineMiss, fineOut)
  }

  /** 今天可能要算的会话：今天动过的日志 + 活着的会话。 */
  async function candidateSessions(dayStart) {
    const ids = new Set()
    try {
      for (const agent of ctx.get('agents')?.list?.() ?? []) ids.add(String(agent.id))
    } catch { /* 活会话列表拿不到不算致命 */ }

    let listed = false
    try {
      const snapshots = await ctx.get('sessionPersistence')?.list?.()
      if (Array.isArray(snapshots)) {
        listed = true
        for (const snapshot of snapshots) {
          const path = snapshot?.location?.path
          let touchedToday = true
          if (typeof path === 'string' && path !== '') {
            try {
              touchedToday = statSync(path).mtimeMs >= dayStart
            } catch {
              // 文件没了/不可读：保守地扫一遍
              touchedToday = true
            }
          }
          if (touchedToday) ids.add(String(snapshot?.header?.id))
        }
      }
    } catch { /* 落到下面的兜底 */ }

    if (!listed) {
      // 拿不到持久化快照（别的后端）：退回全量列表，慢一点但不能漏。
      try {
        const records = await ctx.get('sessionQuery')?.listSessions?.()
        for (const record of records ?? []) ids.add(String(record?.header?.id))
      } catch { /* 实在没有就只算活会话 */ }
    }
    return [...ids]
  }

  /** 扫一遍今天的日志。 */
  async function scanToday(dayStart) {
    const query = ctx.get('sessionQuery')
    if (query === undefined || typeof query.readSession !== 'function') return
    for (const id of await candidateSessions(dayStart)) {
      let snapshot
      try {
        snapshot = await query.readSession(id)
      } catch {
        // 正在写的会话可能读不稳；增量事件会把它们补上
        continue
      }
      const inherited = Number(snapshot?.inheritedEventCount) || 0
      for (const event of snapshot?.events ?? []) {
        if (Number(event.seq) < inherited) continue
        if (event.type !== 'assistant/message') continue
        if (!(Number(event.time) >= dayStart)) continue
        ingest(id, event)
      }
    }
  }

  /**
   * 保证同一时刻只有一次扫描，且正常轮询不重复扫：
   * 增量事件已经实时记账，扫描只是兜底，所以 5 分钟内不重扫。
   */
  function ensureScan(now, force = false) {
    if (scanInFlight !== null) return scanInFlight
    if (!force && lastScanAt !== 0 && now - lastScanAt < RESCAN_MS) return Promise.resolve()
    lastScanAt = now
    const dayStart = bjDayStart(now)
    scanInFlight = scanToday(dayStart).catch((error) => {
      console.warn('[spend-meter] 扫描今日用量失败：', error?.message ?? error)
      // 失败就别把这 5 分钟锁死，下次请求还能重试。
      lastScanAt = 0
    }).finally(() => {
      scanInFlight = null
    })
    return scanInFlight
  }

  /** 余额：充值 + 赠送钱包，带缓存。 */
  async function readBalance() {
    const now = Date.now()
    if (now - balanceAt < BALANCE_TTL_MS) return balance
    const account = ctx.get('deepseekAccount')
    let next
    if (account === undefined || typeof account.getState !== 'function') {
      next = { status: 'unavailable' }
    } else {
      try {
        const view = await account.getState()
        // 账号服务同时给出平台链接：点条目就跳官方用量/账单页，不需要插件自己拼 URL。
        const usageUrl = view?.links?.usageUrl
        const links = typeof usageUrl === 'string' && usageUrl !== '' ? { usageUrl } : null
        if (view?.status !== 'credential-stored') {
          next = { status: 'signed-out', links }
        } else {
          const details = await account.getBalance({
            version: VERSION,
            locale: 'zh-CN',
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          })
          if (details?.status !== 'ready') {
            next = { status: 'error' }
          } else {
            const wallets = details.value ?? []
            const bonusWallets = details.bonusWallets ?? []
            const currency = wallets.some(wallet => wallet.currency === 'CNY') ||
              bonusWallets.some(wallet => wallet.currency === 'CNY') ? 'CNY' : 'USD'
            const sum = list => list
              .filter(wallet => wallet?.currency === currency)
              .reduce((total, wallet) => total + (Number(wallet.balance) || 0), 0)
            const recharge = sum(wallets)
            const bonus = sum(bonusWallets)
            next = {
              status: 'ready',
              currency,
              symbol: CURRENCY_SYMBOL[currency],
              total: recharge + bonus,
              recharge,
              bonus,
              links,
            }
          }
        }
      } catch (error) {
        console.warn('[spend-meter] 读余额失败：', error?.message ?? error)
        next = { status: 'error' }
      }
    }
    balance = next
    balanceAt = now
    if (next.status === 'ready') lastCurrency = next.currency
    return balance
  }

  /** 今日消耗视图：按当前币种价目折钱。 */
  function spendView(currency) {
    const totals = { hit: 0, miss: 0, out: 0 }
    for (const buckets of ledger.buckets.values()) {
      for (const window of ['peak', 'off']) {
        totals.hit += buckets[window].hit
        totals.miss += buckets[window].miss
        totals.out += buckets[window].out
      }
    }
    return {
      currency,
      symbol: CURRENCY_SYMBOL[currency],
      amount: costOf(currency, ledger.buckets),
      // 输入 = 缓存命中 + 未命中（含缓存写入），输出单独一列
      inputTokens: totals.hit + totals.miss,
      cacheHitTokens: totals.hit,
      uncachedInputTokens: totals.miss,
      outputTokens: totals.out,
      unpricedCalls: ledger.unpricedCalls,
      sessions: ledger.sessions.size,
    }
  }

  /** 会话标题缓存：标题很少变，但重命名要跟得上，所以按 5 分钟过期。 */
  const titleCache = new Map()
  const TITLE_TTL_MS = 5 * 60_000
  async function titleOf(sessionId) {
    const cached = titleCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < TITLE_TTL_MS) return cached.title
    let title = null
    try {
      const snapshot = await ctx.get('sessionQuery')?.readTitle?.(sessionId)
      if (typeof snapshot?.title === 'string' && snapshot.title !== '') title = snapshot.title
    } catch { /* 标题读不到就用短 id 兜底 */ }
    titleCache.set(sessionId, { title, at: Date.now() })
    return title
  }

  /** 详情：按闲/忙、模型、会话三个维度拆今天的消耗。 */
  async function detailView(currency, period, currentBalance) {
    const windows = {
      peak: { amount: 0, inputTokens: 0, outputTokens: 0 },
      off: { amount: 0, inputTokens: 0, outputTokens: 0 },
    }
    const models = []
    for (const [modelKey, buckets] of ledger.buckets) {
      const row = { model: modelKey, amount: 0, inputTokens: 0, outputTokens: 0 }
      for (const window of ['peak', 'off']) {
        const bucket = buckets[window]
        row.inputTokens += bucket.hit + bucket.miss
        row.outputTokens += bucket.out
        windows[window].inputTokens += bucket.hit + bucket.miss
        windows[window].outputTokens += bucket.out
      }
      row.amount = costOf(currency, new Map([[modelKey, buckets]]))
      windows.peak.amount += costOf(currency, new Map([[modelKey, buckets]]), 'peak')
      windows.off.amount += costOf(currency, new Map([[modelKey, buckets]]), 'off')
      models.push(row)
    }
    models.sort((a, b) => b.amount - a.amount)

    const rows = []
    for (const [id, byModel] of ledger.sessionBuckets) {
      let inputTokens = 0
      let outputTokens = 0
      for (const buckets of byModel.values()) {
        for (const window of ['peak', 'off']) {
          inputTokens += buckets[window].hit + buckets[window].miss
          outputTokens += buckets[window].out
        }
      }
      rows.push({
        id,
        title: null,
        amount: costOf(currency, byModel),
        peakAmount: costOf(currency, byModel, 'peak'),
        offAmount: costOf(currency, byModel, 'off'),
        inputTokens,
        outputTokens,
      })
    }
    rows.sort((a, b) => b.amount - a.amount || b.inputTokens - a.inputTokens)

    const amount = costOf(currency, ledger.buckets)
    const standardAmount = costOf(currency, ledger.buckets, null, 1)

    // 列表截断到前 40 个，但标题只给要显示的这些取。
    const kept = rows.slice(0, 40)
    await Promise.all(kept.map(async (row) => { row.title = await titleOf(row.id) }))

    return {
      ok: true,
      generatedAt: Date.now(),
      day: ledger.dayKey,
      period,
      balance: currentBalance,
      totals: { ...spendView(currency), amount, saved: Math.max(0, standardAmount - amount) },
      windows,
      models,
      sessions: kept,
      sessionTotal: rows.length,
      budget: budgetStatus(currency),
      links: currentBalance?.links ?? null,
    }
  }

  /** 当前闲忙时段 + 下一次切换时刻。 */
  function periodNow(now) {
    const period = {
      timeZone: 'Asia/Shanghai',
      kind: isPeakAt(now, holidays) ? 'peak' : 'off-peak',
    }
    const changeAt = nextChangeAt(now, holidays)
    if (changeAt !== null) {
      period.nextChangeAt = changeAt
      period.nextKind = isPeakAt(changeAt, holidays) ? 'peak' : 'off-peak'
    }
    return period
  }

  /** 预算状态：已用 / 上限 / 是否告警 / 是否已超额。 */
  function budgetStatus(currency) {
    const spent = costOf(currency, ledger.buckets)
    const ratio = budget.limit > 0 ? spent / budget.limit : 0
    return {
      enabled: budget.enabled,
      limit: budget.limit,
      threshold: budget.threshold,
      spent,
      ratio,
      currency,
      symbol: CURRENCY_SYMBOL[currency] ?? currency,
      warning: budget.enabled && ratio >= budget.threshold && ratio < 1,
      blocked: budget.enabled && ratio >= 1,
      blockedCount,
    }
  }

  /** 预算拦下请求时写进聊天错误行的那句话。 */
  function budgetFailureMessage(status) {
    const spent = `${status.symbol}${status.spent.toFixed(2)}`
    const limit = `${status.symbol}${status.limit.toFixed(2)}`
    return `今日预算已用完（${spent} / ${limit}），DeepSeek 模型调用已暂停，明天 0 点（北京时间）自动恢复。`
      + '可以在侧栏「余额与用量」里调高每日上限或关闭预算。'
  }

  /** 只有 DeepSeek 的模型会被预算闸门挡住。 */
  function isDeepSeekProvider(provider) {
    return String(provider ?? '').toLowerCase().includes('deepseek')
  }

  /** 一张快照：响应 Client 的轮询。 */
  async function buildSnapshot() {
    const now = Date.now()
    rollDay(now)
    await ensureScan(now)
    const period = periodNow(now)
    const currentBalance = await readBalance()
    const currency = currentBalance.status === 'ready' ? currentBalance.currency : 'CNY'
    return {
      ok: true,
      generatedAt: now,
      balance: currentBalance,
      spend: spendView(currency),
      period,
      budget: budgetStatus(currency),
    }
  }

  /** 读一个小 JSON 请求体；超过 64KB 直接掐断，避免占内存。 */
  function readJsonBody(req) {
    return new Promise((resolve) => {
      let data = ''
      let done = false
      const finish = (value) => { if (!done) { done = true; resolve(value) } }
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 64_000) {
          finish({})
          req.destroy()
        }
      })
      req.on('end', () => {
        try { finish(JSON.parse(data || '{}')) } catch { finish({}) }
      })
      req.on('error', () => finish({}))
    })
  }

  /** GET 读预算、POST 改预算；字段缺省就保持原值。 */
  async function handleBudget(req, res) {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, budget: budgetStatus(lastCurrency) })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    const next = normalizeBudget({
      enabled: body?.enabled === undefined ? budget.enabled : body.enabled === true,
      limit: body?.limit === undefined ? budget.limit : body.limit,
      threshold: body?.threshold === undefined ? budget.threshold : body.threshold,
    })
    budget = next
    const saved = writeBudgetFile(next)
    sendJson(res, saved ? 200 : 500, {
      ok: saved,
      budget: budgetStatus(lastCurrency),
      ...(saved ? {} : { error: 'save failed' }),
    })
  }

  /** 本机同源校验：挡掉浏览器里别的网页。 */
  function sameOrigin(req) {
    try {
      const host = String(req.headers.host ?? '')
      if (host === '') return true
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
      const source = String(req.headers.origin ?? req.headers.referer ?? '')
      if (source === '') return true
      const url = new URL(source)
      return (url.host || '').toLowerCase() === host.toLowerCase()
    } catch {
      return false
    }
  }

  /** 宿主的信任栅栏；拿不到就只靠同源这一道。 */
  function rejectUntrusted(req, res) {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') return false
    try {
      const rejection = connection.requestRejection({ headers: req.headers })
      if (rejection === undefined || rejection === null || rejection === false) return false
      res.statusCode = typeof rejection === 'number' ? rejection : 403
      res.end()
      return true
    } catch {
      return false
    }
  }

  function sendJson(res, code, value) {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }

  // 路由：Client 半端只读这一条。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (rejectUntrusted(req, res)) return
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const path = String(req.url ?? '').split('?')[0]
      try {
        if (path === BUDGET_PATH) {
          await handleBudget(req, res)
          return
        }
        if (req.method !== 'GET' || (path !== SNAPSHOT_PATH && path !== DETAIL_PATH)) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        if (path === DETAIL_PATH) {
          const now = Date.now()
          rollDay(now)
          await ensureScan(now)
          const currentBalance = await readBalance()
          const currency = currentBalance.status === 'ready' ? currentBalance.currency : 'CNY'
          sendJson(res, 200, await detailView(currency, periodNow(Date.now()), currentBalance))
        } else {
          sendJson(res, 200, await buildSnapshot())
        }
      } catch (error) {
        console.warn('[spend-meter] 生成数据失败：', error?.message ?? error)
        sendJson(res, 500, { ok: false, error: 'snapshot failed' })
      }
    },
  }), 'spend-meter: /api/dsh-spend-meter 路由')

  // 增量记账：每个提交后的事件都过一遍，assistant/message 才带用量。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    if (!(Number(event.time) >= bjDayStart(Date.now()))) return
    ingest(String(session?.id ?? ''), event)
  }), 'spend-meter: 增量记账')

  // 预算闸门：当天花费到顶后，DeepSeek 的模型请求不发出去，而是以一次「可见的失败」结束。
  //
  // 为什么不用 agent/pre-step 的 reject：那条路会把 turn 收成 blocked，界面上只显示
  // 一句「完成」，用户完全不知道被预算拦了（实测就是这个反馈）。这里改成在
  // llm/stream 这一层短路：返回一个只带 finish{kind:'error', failure} 的流，
  // 走宿主自己的失败路径 —— 聊天里会出现一行错误提示，且不会真的发起网络请求。
  // failure.code 故意用非网络错误码，llm-retry 的 retryableCodes 不含它，不会重试。
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    if (!budget.enabled) return next()
    if (!isDeepSeekProvider(options?.provider)) return next()
    const status = budgetStatus(lastCurrency)
    if (!status.blocked) return next()
    blockedCount += 1
    const message = budgetFailureMessage(status)
    return (async function* blocked() {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message, code: 'budget-exceeded' },
        },
      }
    })()
  }), 'spend-meter: 预算闸门')

  // 定期补扫 + 跨零点清账。定时器由 effect 自己回收，不依赖 timer 服务。
  ctx.effect(() => {
    const tick = () => {
      const now = Date.now()
      rollDay(now)
      void ensureScan(now, true)
    }
    const handle = setInterval(tick, RESCAN_MS)
    handle.unref?.()
    return () => clearInterval(handle)
  }, 'spend-meter: 补扫定时器')
}
