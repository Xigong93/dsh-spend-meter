/**
 * dsh-spend-meter —— Client 半端（侧栏底部常驻条目 + 今日消耗详情弹窗）
 * ============================================================================
 * 位置：
 *   1. `sidebar.footer.action`（侧栏底部 Settings 上方那条）—— 常驻小卡片：
 *
 *        余额                ¥8.75
 *        今日                ≈¥2.49
 *        输入 57.9M   输出 216K
 *        ● 空闲 · 8 小时 17 分后转高峰
 *
 *      收成 56px 窄栏时缩成 36px 宽的小方块（色点 + 余额 + 今日）。
 *      整块是按钮：点击/回车打开下面的详情弹窗。
 *   2. `shell.overlay`（帧级浮层）—— 详情弹窗：闲时/忙时、按会话、按模型三个维度
 *      拆今日消耗，底部给平台账单入口。样式抄宿主 stat dialog 的面板 token。
 *
 * 已知取舍：宿主内置的 Cordis 面板按钮也注册在侧栏那条 slot 上，且占满整行宽度；
 *   一旦存在 Cordis 动态包，本条目会被挤成零宽（本文件按可收缩处理，不去抢它的宽度）。
 *
 * 数据：轮询 `/api/dsh-spend-meter/snapshot`（每分钟），弹窗打开时读一次 `/detail`。
 *       样式只用宿主主题变量，字号跟随 --dsh-content-font-size。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-spend-meter',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-spend-meter'
    const ENDPOINT = '/api/dsh-spend-meter/snapshot'
    const DETAIL_ENDPOINT = '/api/dsh-spend-meter/detail'
    const BUDGET_ENDPOINT = '/api/dsh-spend-meter/budget'
    const POLL_MS = 60_000
    const TICK_MS = 20_000
    const FETCH_TIMEOUT_MS = 8_000
    /** 超过这么久没成功取到数，就标成"可能过期"，别让人把旧数字当实时。 */
    const STALE_MS = 3 * 60_000

    const DICTS = {
      zh: {
        balance: '余额',
        today: '今日',
        input: '输入',
        output: '输出',
        peak: '高峰',
        offPeak: '空闲',
        peakNote: '高峰（标准价）',
        offPeakNote: '空闲（半价）',
        countdown: '{gap}后转{next}',
        switching: '正在切换时段',
        signedOut: '未登录',
        unavailable: '不可用',
        failed: '读取失败',
        loading: '读取中',
        'gap.minutes': '{minutes} 分',
        'gap.hours': '{hours} 小时',
        'gap.hoursMinutes': '{hours} 小时 {minutes} 分',
        'gap.days': '{days} 天',
        'gap.daysHours': '{days} 天 {hours} 小时',
        'title.estimate': '今日消耗按本 Harness 记录的 token 用量与官方价目估算（北京时间）',
        'title.open': '点击查看今日消耗细节',
        'title.stale': '数据可能已过期：最后一次成功读取在 {time}',
        'title.signedOut': '未登录 DeepSeek 账号，读不到余额',
        'title.balance': '余额 {total}（充值 {recharge}，赠送 {bonus}）',
        'title.spend': '今日已用 {amount}｜输入 {input} tokens（其中缓存命中 {hit}）｜输出 {out} tokens',
        'title.unpriced': '另有 {count} 条非 DeepSeek 模型调用未折钱',
        'title.sessions': '统计范围：今天 {count} 个会话',
        'title.period': '{note}；{countdown}',
        'title.noHolidays': '未配置法定节假日（holidays），节假日当天会按高峰显示',
        'budget.title': '每日预算',
        'budget.hintOff': '未开启',
        'budget.hintOn': '已用 {percent}%',
        'budget.hintWarning': '接近上限',
        'budget.hintBlocked': '已超预算',
        'budget.enable': '开启预算控制',
        'budget.enableHint': '按今天记录的估算花费计算，超过上限就暂停 DeepSeek 模型的调用',
        'budget.limit': '每天上限',
        'budget.unit': '元',
        'budget.used': '已用 {spent} / {limit}（{percent}%）',
        'budget.warning': '已用到 {percent}%，到达上限会暂停 DeepSeek 模型',
        'budget.blocked': '已超预算：DeepSeek 模型的调用已暂停，明天 0 点（北京时间）自动恢复',
        'budget.blockedCount': '本次运行已拦截 {count} 次模型请求',
        'budget.saveFailed': '保存失败，请再试一次',
        'budget.saved': '已保存',
        'card.budgetBlocked': '预算已用完',
        'card.budgetWarn': '预算 {percent}%',
        'dialog.title': '今日消耗细节',
        'dialog.close': '关闭',
        'dialog.total': '合计',
        'dialog.input': '输入',
        'dialog.output': '输出',
        'dialog.sessionCount': '会话',
        'dialog.peak': '忙时',
        'dialog.offPeak': '闲时',
        'dialog.totalLabel': '合计消耗',
        'dialog.inputToken': '输入 Token',
        'dialog.outputToken': '输出 Token',
        'dialog.unitSession': '个',
        'dialog.saved': '较标准价节省 {amount}',
        'dialog.badgeOff': '空闲 · 半价生效中',
        'dialog.badgePeak': '高峰 · 标准价',
        'dialog.badgeHalf': '半价',
        'dialog.offPeakShare': '半价时段占 {value}%',
        'dialog.sortedHint': '按消耗排序 · {count} 个',
        'dialog.shareOfTotal': '{value}% 占比',
        'dialog.sectionWindows': '时段分布',
        'dialog.bySession': '按会话',
        'dialog.byModel': '按模型',
        'dialog.loading': '读取中…',
        'dialog.failed': '读取失败，稍后再试',
        'dialog.empty': '今天还没有消耗记录',
        'dialog.truncated': '只显示前 {shown} 个（今天共 {total} 个会话）',
        'dialog.refresh': '刷新',
        'dialog.updated': '更新于 {time}',
        'dialog.openPlatform': '在 DeepSeek 平台查看账单明细',
        'dialog.disclaimer': '按本 Harness 记录的 token 与官方价目估算，仅供对照，不等同平台账单。',
        'dialog.shareShort': '{value}%',
        'dialog.untitled': '会话 {id}',
      },
      en: {
        balance: 'Balance',
        today: 'Today',
        input: 'Input',
        output: 'Output',
        peak: 'Peak',
        offPeak: 'Off-peak',
        peakNote: 'Peak (standard)',
        offPeakNote: 'Off-peak (half price)',
        countdown: '{next} in {gap}',
        switching: 'Switching window',
        signedOut: 'Signed out',
        unavailable: 'Unavailable',
        failed: 'Unreadable',
        loading: 'Loading',
        'gap.minutes': '{minutes}m',
        'gap.hours': '{hours}h',
        'gap.hoursMinutes': '{hours}h{minutes}m',
        'gap.days': '{days}d',
        'gap.daysHours': '{days}d{hours}h',
        'title.estimate': "Today's spend is estimated from this Harness's recorded tokens at the official price list (Beijing time)",
        'title.open': 'Click for today’s spend details',
        'title.stale': 'This data may be stale; last success at {time}',
        'title.signedOut': 'Not signed in to a DeepSeek account, so the balance is unavailable',
        'title.balance': 'Balance {total} (top-up {recharge}, granted {bonus})',
        'title.spend': 'Today {amount} | input {input} tokens (cache hit {hit}) | output {out} tokens',
        'title.unpriced': '{count} non-DeepSeek calls are not priced',
        'title.sessions': 'Counted from {count} sessions today',
        'title.period': '{note}; {countdown}',
        'title.noHolidays': 'No holidays configured; a public holiday shows as peak',
        'budget.title': 'Daily budget',
        'budget.hintOff': 'Off',
        'budget.hintOn': '{percent}% used',
        'budget.hintWarning': 'Near the limit',
        'budget.hintBlocked': 'Over budget',
        'budget.enable': 'Turn on budget control',
        'budget.enableHint': "Uses today's estimated spend; past the limit, DeepSeek model calls are paused",
        'budget.limit': 'Daily limit',
        'budget.unit': 'CNY',
        'budget.used': '{spent} of {limit} used ({percent}%)',
        'budget.warning': '{percent}% used; DeepSeek models pause at the limit',
        'budget.blocked': 'Over budget: DeepSeek model calls are paused until midnight (Beijing time)',
        'budget.blockedCount': '{count} requests were blocked this session',
        'budget.saveFailed': 'Saving failed; try again',
        'budget.saved': 'Saved',
        'card.budgetBlocked': 'Budget spent',
        'card.budgetWarn': 'Budget {percent}%',
        'dialog.title': "Today's spend details",
        'dialog.close': 'Close',
        'dialog.total': 'Total',
        'dialog.input': 'Input',
        'dialog.output': 'Output',
        'dialog.sessionCount': 'Sessions',
        'dialog.peak': 'Peak',
        'dialog.offPeak': 'Off-peak',
        'dialog.totalLabel': 'Total',
        'dialog.inputToken': 'Input tokens',
        'dialog.outputToken': 'Output tokens',
        'dialog.unitSession': 'sessions',
        'dialog.saved': '{amount} saved vs. standard price',
        'dialog.badgeOff': 'Off-peak · half price',
        'dialog.badgePeak': 'Peak · standard price',
        'dialog.badgeHalf': 'Half price',
        'dialog.offPeakShare': 'Off-peak is {value}%',
        'dialog.sortedHint': 'Sorted by spend · {count}',
        'dialog.shareOfTotal': '{value}% of today',
        'dialog.sectionWindows': 'Time of day',
        'dialog.bySession': 'By session',
        'dialog.byModel': 'By model',
        'dialog.loading': 'Loading…',
        'dialog.failed': 'Could not load the details; try again',
        'dialog.empty': 'No usage recorded today yet',
        'dialog.truncated': 'Showing the first {shown} of {total} sessions today',
        'dialog.refresh': 'Refresh',
        'dialog.updated': 'Updated {time}',
        'dialog.openPlatform': 'Open billing details on the DeepSeek platform',
        'dialog.disclaimer': "Estimated from this Harness's recorded tokens at the official price list; for reference only, not the platform bill.",
        'dialog.shareShort': '{value}%',
        'dialog.untitled': 'Session {id}',
      },
    }

    /** 与宿主账号页一致的金额格式：分以下显示 <¥0.01。 */
    function money(value, symbol) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const abs = Math.abs(value)
      const sign = value < 0 ? '-' : ''
      if (abs === 0) return `${symbol}0.00`
      if (abs < 0.01) return `${sign}<${symbol}0.01`
      return `${sign}${symbol}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    }

    /** 窄栏用的紧凑金额：36px 宽里先保住"量级"。 */
    function compactMoney(value, symbol) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const abs = Math.abs(value)
      const sign = value < 0 ? '-' : ''
      if (abs === 0) return `${symbol}0`
      if (abs < 0.01) return `${sign}<${symbol}.01`
      if (abs >= 10_000) return `${sign}${symbol}${(abs / 10_000).toFixed(1).replace(/\.0$/, '')}万`
      if (abs >= 100) return `${sign}${symbol}${Math.round(abs)}`
      if (abs >= 10) return `${sign}${symbol}${abs.toFixed(1)}`
      return `${sign}${symbol}${abs.toFixed(2)}`
    }

    /** token 数：跟宿主会话统计一致，1K / 1M 缩写，≥100 就取整。 */
    function tokenText(value) {
      const count = Number(value) || 0
      const scaled = (candidate) => candidate >= 100
        ? String(Math.round(candidate))
        : String(Math.round(candidate * 10) / 10)
      if (count < 1000) return String(count)
      if (count < 1_000_000) return `${scaled(count / 1000)}K`
      return `${scaled(count / 1_000_000)}M`
    }

    /** tooltip 里用精确值（千分位）。 */
    function tokens(value) {
      return (Number(value) || 0).toLocaleString('en-US')
    }

    /** 倒计时文案交给字典，中文用"小时/分"，英文用 h/m。 */
    function gapText(ms, t) {
      const minutes = Math.max(1, Math.round(ms / 60_000))
      if (minutes >= 1440) {
        const days = Math.floor(minutes / 1440)
        const hours = Math.round((minutes % 1440) / 60)
        return hours > 0 ? t('gap.daysHours', { days, hours }) : t('gap.days', { days })
      }
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      if (hours === 0) return t('gap.minutes', { minutes: rest })
      return rest === 0 ? t('gap.hours', { hours }) : t('gap.hoursMinutes', { hours, minutes: rest })
    }

    /** 带超时的取数：避免一次挂起把轮询链拖死。 */
    async function requestJson(url, options = {}) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller?.signal,
          ...(options.body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return data
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    /** 侧栏卡片与详情弹窗共用一个"打开"状态。 */
    function createDialogStore() {
      let open = false
      const listeners = new Set()
      return {
        isOpen: () => open,
        setOpen: (next) => {
          if (next === open) return
          open = next
          for (const listener of listeners) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }
    const dialogStore = createDialogStore()

    function useDialogOpen() {
      const [open, setOpen] = React.useState(() => dialogStore.isOpen())
      React.useEffect(() => dialogStore.subscribe(() => setOpen(dialogStore.isOpen())), [])
      return open
    }

    /** 轮询快照：页面隐藏时不跑，回到页面立刻补。 */
    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [fetchedAt, setFetchedAt] = React.useState(0)

      const load = React.useCallback(async () => {
        try {
          const data = await requestJson(ENDPOINT)
          setSnapshot(data?.ok === true ? data : { ok: false })
          setFetchedAt(Date.now())
        } catch {
          // 失败保留上一份数据，靠 fetchedAt 判定是否过期。
          setSnapshot((previous) => previous ?? { ok: false })
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        let poll = null
        if (alive) void load()
        const loop = () => {
          poll = setTimeout(async () => {
            if (document.visibilityState === 'visible') await load()
            if (alive) loop()
          }, POLL_MS)
        }
        loop()
        const onVisibility = () => { if (document.visibilityState === 'visible') void load() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          if (poll !== null) clearTimeout(poll)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])

      return { snapshot, fetchedAt, reload: load }
    }

    /** 让倒计时自己走；页面隐藏时不必空转。 */
    function useNow() {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') setNow(Date.now())
        }, TICK_MS)
        return () => clearInterval(timer)
      }, [])
      return now
    }

    /** 语言切换后重渲染：字典注册不触发事件，active 切换会。 */
    function useLocaleVersion(ctx) {
      const [, bump] = React.useReducer((version) => version + 1, 0)
      React.useEffect(() => ctx.locale.subscribe(() => bump()), [ctx])
    }

    const MUTED = 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))'
    const PRIMARY = 'var(--dsw-alias-label-primary, currentColor)'
    const SECONDARY = 'var(--dsw-alias-label-secondary, currentColor)'
    /** 悬停/聚焦的高亮：token 自带透明度，macOS 侧栏的 vibrancy 不会被盖住。 */
    const HOVER_FILL = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))'
    const CARD_FILL = 'color-mix(in srgb, var(--dsw-alias-bg-layer-1, transparent) 42%, transparent)'
    const WARN = 'var(--dsw-alias-state-warn-primary, currentColor)'
    const ERROR = 'var(--dsw-alias-state-error-primary, currentColor)'
    const GREEN = 'var(--dsw-alias-state-success-primary, currentColor)'

    /** 时段色点：高峰用警示色，空闲用成功色，未知用 idle 色。 */
    function dotStyle(kind, size = 6) {
      const color = kind === 'peak'
        ? 'var(--dsw-alias-state-warn-primary, currentColor)'
        : kind === 'off-peak'
          ? 'var(--dsw-alias-state-success-primary, currentColor)'
          : 'var(--dsw-alias-state-idle-primary, currentColor)'
      return {
        width: size,
        height: size,
        borderRadius: '50%',
        flex: 'none',
        background: color,
        display: 'inline-block',
      }
    }

    /**
     * 侧栏卡片本体。
     * @param props wide：宽栏为 true、56px 窄栏为 false；t：本插件翻译函数；ctx：Client 上下文。
     */
    function SpendMeter({ wide = true, t, ctx }) {
      const { snapshot, fetchedAt, reload } = useSnapshot()
      const now = useNow()
      useLocaleVersion(ctx)
      const open = useDialogOpen()
      const [highlight, setHighlight] = React.useState(false)

      const failed = snapshot !== null && snapshot.ok !== true
      const stale = snapshot !== null && fetchedAt !== 0 && now - fetchedAt > STALE_MS
      const period = snapshot?.period ?? null
      const kind = period?.kind ?? null
      const balance = snapshot?.balance ?? null
      const spend = snapshot?.spend ?? null
      const budget = snapshot?.budget ?? null

      const balanceText = failed
        ? t('failed')
        : balance?.status === 'ready'
          ? money(balance.total, balance.symbol)
          : balance?.status === 'signed-out'
            ? t('signedOut')
            : balance?.status === 'unavailable'
              ? t('unavailable')
              : balance?.status === 'error'
                ? t('failed')
                : t('loading')
      const spendText = snapshot === null
        ? t('loading')
        : failed || spend === null
          ? t('failed')
          : money(spend.amount, spend.symbol)
      const inputText = snapshot === null || failed || spend === null ? '—' : tokenText(spend.inputTokens)
      const outputText = snapshot === null || failed || spend === null ? '—' : tokenText(spend.outputTokens)
      const balanceRail = failed
        ? '—'
        : balance?.status === 'ready'
          ? compactMoney(balance.total, balance.symbol)
          : balanceText
      const spendRail = snapshot === null ? '…' : failed || spend === null ? '—' : compactMoney(spend.amount, spend.symbol)

      // 到切换点但快照还没换：立刻补一次。
      const changeAt = period?.nextChangeAt
      const changing = kind !== null && changeAt !== undefined && now >= changeAt
      React.useEffect(() => {
        if (changing) void reload()
      }, [changing, reload])

      const countdown = kind !== null && changeAt !== undefined && !changing
        ? t('countdown', {
          gap: gapText(changeAt - now, t),
          next: period?.nextKind === 'peak' ? t('peak') : t('offPeak'),
        })
        : null
      const periodShort = kind === 'peak' ? t('peak') : kind === 'off-peak' ? t('offPeak') : t('failed')
      const periodNote = kind === 'peak' ? t('peakNote') : kind === 'off-peak' ? t('offPeakNote') : null
      const budgetSuffix = budget === null || !budget.enabled
        ? ''
        : budget.blocked
          ? ` · ${t('card.budgetBlocked')}`
          : budget.warning
            ? ` · ${t('card.budgetWarn', { percent: Math.round(budget.ratio * 100) })}`
            : ''
      const periodLine = changing
        ? t('switching')
        : countdown !== null
          ? `${periodShort} · ${countdown}`
          : snapshot === null
            ? t('loading')
            : failed
              ? t('failed')
              : periodShort

      // 原生 tooltip：完整读数 + 口径说明 + 点击去向。
      const lines = []
      if (stale && fetchedAt !== 0) {
        lines.push(t('title.stale', { time: new Date(fetchedAt).toLocaleTimeString() }))
      }
      lines.push(t('title.estimate'))
      if (balance?.status === 'ready') {
        lines.push(t('title.balance', {
          total: money(balance.total, balance.symbol),
          recharge: money(balance.recharge, balance.symbol),
          bonus: money(balance.bonus, balance.symbol),
        }))
      } else if (balance?.status === 'signed-out') {
        lines.push(t('title.signedOut'))
      }
      if (spend !== null && !failed) {
        lines.push(t('title.spend', {
          amount: money(spend.amount, spend.symbol),
          input: tokens(spend.inputTokens),
          hit: tokens(spend.cacheHitTokens),
          out: tokens(spend.outputTokens),
        }))
        if (spend.unpricedCalls > 0) lines.push(t('title.unpriced', { count: spend.unpricedCalls }))
        lines.push(t('title.sessions', { count: spend.sessions }))
      }
      if (periodNote !== null) {
        lines.push(countdown === null ? periodNote : t('title.period', { note: periodNote, countdown }))
        lines.push(t('title.noHolidays'))
      }
      if (budget !== null && budget.enabled) {
        const percent = Math.round(budget.ratio * 100)
        lines.push(budget.blocked
          ? t('budget.blocked')
          : t('budget.used', {
            spent: money(budget.spent, budget.symbol),
            limit: money(budget.limit, budget.symbol),
            percent,
          }))
      }
      lines.push(t('title.open'))
      const title = lines.join('\n')

      const openDialog = () => dialogStore.setOpen(true)
      const interaction = {
        role: 'button',
        tabIndex: 0,
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': title,
        title,
        onClick: openDialog,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openDialog()
          }
        },
        onMouseEnter: () => setHighlight(true),
        onMouseLeave: () => setHighlight(false),
        onFocus: () => setHighlight(true),
        onBlur: () => setHighlight(false),
      }

      const base = {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        // 不抢整行：与占用同一条 slot 的宿主条目共存时，宁可自己收缩。
        flex: '1 1 auto',
        fontVariantNumeric: 'tabular-nums',
        overflow: 'hidden',
        opacity: stale ? 0.62 : 1,
        color: PRIMARY,
        textDecoration: 'none',
        cursor: 'pointer',
        userSelect: 'none',
      }

      if (!wide) {
        // 窄栏（56px）：36px 宽的小方块，色点 + 余额 + 今日，字号 10px 左右。
        return h('div', {
          style: {
            ...base,
            width: 36,
            padding: '4px 2px',
            margin: '2px 0 6px',
            alignItems: 'center',
            gap: 1,
            borderRadius: 10,
            background: highlight ? HOVER_FILL : 'transparent',
            fontSize: 'calc(var(--dsh-content-font-size, 14px) - 4px)',
            lineHeight: 1.2,
          },
          ...interaction,
          'data-dsh-spend-meter': '',
        },
        h('span', { style: dotStyle(kind, 5) }),
        h('span', { style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, balanceRail),
        h('span', {
          style: {
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: MUTED,
          },
        }, `≈${spendRail}`),
        )
      }

      // 宽栏：浅色蒙层小卡片 + 两列 key/value + token 行 + 时段行。
      const labelStyle = {
        fontSize: 'calc(var(--dsh-content-font-size, 14px) - 3px)',
        lineHeight: 1.4,
        color: MUTED,
        whiteSpace: 'nowrap',
      }
      const valueStyle = {
        fontSize: 'calc(var(--dsh-content-font-size, 14px) - 1px)',
        lineHeight: 1.4,
        fontWeight: 500,
        color: PRIMARY,
        textAlign: 'right',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const tokenStyle = {
        fontSize: 'calc(var(--dsh-content-font-size, 14px) - 3px)',
        lineHeight: 1.4,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }

      return h('div', {
        style: {
          ...base,
          width: '100%',
          padding: '8px 10px 7px',
          margin: '2px 0 8px',
          gap: 4,
          borderRadius: 12,
          background: highlight ? HOVER_FILL : CARD_FILL,
        },
        ...interaction,
        'data-dsh-spend-meter': '',
      },
      h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          columnGap: 10,
          rowGap: 1,
          alignItems: 'baseline',
        },
      },
      h('span', { style: labelStyle }, t('balance')),
      h('span', { style: valueStyle }, balanceText),
      h('span', { style: labelStyle }, t('today')),
      h('span', {
        style: {
          ...valueStyle,
          color: budget?.blocked ? ERROR : budget?.warning ? WARN : valueStyle.color,
        },
      }, `≈${spendText}`),
      ),
      // 今日 token：输入 / 输出分开显示（精确值在 tooltip 与详情弹窗里）。
      h('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
          minWidth: 0,
        },
      },
      h('span', { style: tokenStyle },
        h('span', { style: { color: MUTED } }, `${t('input')} `),
        h('span', { style: { color: SECONDARY } }, inputText)),
      h('span', { style: { ...tokenStyle, textAlign: 'right' } },
        h('span', { style: { color: MUTED } }, `${t('output')} `),
        h('span', { style: { color: SECONDARY } }, outputText)),
      ),
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          fontSize: 'calc(var(--dsh-content-font-size, 14px) - 3px)',
          lineHeight: 1.4,
          color: SECONDARY,
        },
      },
      h('span', { style: dotStyle(kind) }),
      h('span', {
        style: {
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: budget?.blocked ? ERROR : budget?.warning ? WARN : SECONDARY,
        },
      }, `${periodLine}${budgetSuffix}`),
      ),
      // 开启预算时补一条细进度条：绿→琥珀→红，跟弹窗里的预算条同一套口径。
      budget !== null && budget.enabled
        ? h('div', {
          style: {
            height: 5,
            borderRadius: 3,
            overflow: 'hidden',
            marginTop: 1,
            background: 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 9%, transparent)',
          },
        },
        h('div', {
          style: {
            height: '100%',
            width: `${Math.min(100, Math.max(0, Math.round(budget.ratio * 100)))}%`,
            borderRadius: 3,
            background: budget.blocked ? ERROR : budget.warning ? WARN : GREEN,
            transition: 'width 200ms ease',
          },
        }))
        : null,
      )
    }

    /* ── 详情弹窗：按 Pen 设计稿还原（880px 稿等比收到 520px，颜色映射到主题 token） ── */

    /** 设计稿的 13 个颜色变量 → 宿主 token（深色模式自动跟着主题走）。 */
    const D = {
      ink900: 'var(--dsw-alias-label-primary, currentColor)',
      ink700: 'var(--dsw-alias-label-primary, currentColor)',
      ink600: 'var(--dsw-alias-label-secondary, currentColor)',
      ink400: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      line: 'var(--dsw-alias-border-l1, currentColor)',
      lineSoft: 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 6%, transparent)',
      surface: 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 4%, transparent)',
      surface2: 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 2%, transparent)',
      green: 'var(--dsw-alias-state-success-primary, currentColor)',
      greenSoft: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, currentColor) 14%, transparent)',
      greenInk: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, currentColor) 78%, var(--dsw-alias-label-primary, currentColor))',
      orange: 'var(--dsw-alias-state-warn-primary, currentColor)',
      error: 'var(--dsw-alias-state-error-primary, currentColor)',
      blue: 'var(--dsw-alias-state-business-primary, #2563eb)',
      onColor: 'var(--dsw-alias-label-on-color, #ffffff)',
    }

    /** 设计稿量出来的尺寸，按 520/880 ≈ 0.59 收了外边距、字号单独保可读。 */
    /** 弹窗动效：进场 220ms、退场 150ms，苹果表单常用的那条收敛曲线。 */
    const ENTER_MS = 220
    const EXIT_MS = 150
    const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

    const M = {
      panelWidth: 520,
      panelHeight: 640,
      padX: 18,
      title: 16,
      date: 11.5,
      badgeText: 11,
      summaryLabel: 11,
      summaryValue: 22,
      saved: 10,
      metricValue: 14,
      metricUnit: 10.5,
      section: 11.5,
      hint: 10.5,
      period: 12.5,
      percent: 10.5,
      price: 12.5,
      rowTitle: 13,
      rowMeta: 11,
      rowPrice: 13,
      rowShare: 10,
      index: 10.5,
      disclaimer: 10.5,
      time: 11,
      button: 12,
    }

    /** 一根描边图标（16 视图盒，1.5 描边）。 */
    function strokeIcon(children, size = 13) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { flex: 'none', display: 'block' },
      }, children)
    }

    const CloseIcon = (size) => strokeIcon([h('path', { key: 'a', d: 'M4 4l8 8' }), h('path', { key: 'b', d: 'M12 4l-8 8' })], size)
    const ClockIcon = (size) => strokeIcon([
      h('circle', { key: 'c', cx: 8, cy: 8, r: 5.5 }),
      h('path', { key: 'h', d: 'M8 4.8V8l2 1.3' }),
    ], size)
    const RefreshIcon = (size) => strokeIcon([
      h('path', { key: 'a', d: 'M13 8a5 5 0 1 1-1.7-3.8' }),
      h('path', { key: 'b', d: 'M13.4 3.2v3.2h-3.2' }),
    ], size)
    const ExternalIcon = (size) => strokeIcon([
      h('path', { key: 'a', d: 'M9.5 3.5H13v3.5' }),
      h('path', { key: 'b', d: 'M13 3.5 7.5 9' }),
      h('path', { key: 'c', d: 'M12 10v2.2a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 12.2V5.8A1.3 1.3 0 0 1 4.3 4.5H6.5' }),
    ], size)

    /** token 数拆成「数值 + 单位」，设计稿里单位是小一号的灰字。 */
    function tokenParts(value) {
      const count = Math.max(0, Number(value) || 0)
      const scaled = (candidate) => candidate >= 100
        ? String(Math.round(candidate))
        : String(Math.round(candidate * 10) / 10)
      if (count < 1000) return { value: String(count), unit: '' }
      if (count < 1_000_000) return { value: scaled(count / 1000), unit: 'K' }
      return { value: scaled(count / 1_000_000), unit: 'M' }
    }

    /** 设计稿里的状态徽标：色点 + 小字，圆角胶囊。 */
    function statusBadge(t, kind) {
      const isPeak = kind === 'peak'
      const color = isPeak ? D.orange : D.green
      const soft = isPeak
        ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, currentColor) 14%, transparent)'
        : D.greenSoft
      const ink = isPeak
        ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, currentColor) 80%, var(--dsw-alias-label-primary, currentColor))'
        : D.greenInk
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 7px',
          borderRadius: 999,
          background: soft,
          color: ink,
          fontSize: M.badgeText,
          fontWeight: 500,
          lineHeight: '15px',
          whiteSpace: 'nowrap',
        },
      },
      h('span', { style: { width: 4, height: 4, borderRadius: '50%', background: color, flex: 'none' } }),
      isPeak ? t('dialog.badgePeak') : t('dialog.badgeOff'))
    }

    /** 分节标题行：左标题、右提示。 */
    function sectionHeader(title, hint) {
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          margin: '0 0 8px',
        },
      },
      h('span', { style: { color: D.ink600, fontSize: M.section, fontWeight: 600 } }, title),
      hint === null ? null : h('span', { style: { color: D.ink600, fontSize: M.hint, whiteSpace: 'nowrap' } }, hint))
    }

    /**
     * 今日消耗详情弹窗：照设计稿的 Header / Body / Footer 三段。
     * 先各自组装成元素变量再拼装，避免深层 JSX 嵌套数不清括号。
     * @param props t：翻译函数；ctx：Client 上下文。
     */
    function SpendDialog({ t, ctx }) {
      const open = useDialogOpen()
      useLocaleVersion(ctx)
      const [detail, setDetail] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [loading, setLoading] = React.useState(false)
      const [visible, setVisible] = React.useState(false)
      const [entered, setEntered] = React.useState(false)
      const [closeHover, setCloseHover] = React.useState(false)
      const [refreshHover, setRefreshHover] = React.useState(false)
      const [limitDraft, setLimitDraft] = React.useState('')
      const [budgetBusy, setBudgetBusy] = React.useState(false)
      const [budgetError, setBudgetError] = React.useState(false)
      const [budgetSaved, setBudgetSaved] = React.useState(false)
      const panelRef = React.useRef(null)

      const load = React.useCallback(async () => {
        setLoading(true)
        setFailed(false)
        try {
          const data = await requestJson(DETAIL_ENDPOINT)
          if (data?.ok === true) setDetail(data)
          else setFailed(true)
        } catch {
          setFailed(true)
        } finally {
          setLoading(false)
        }
      }, [])

      // 进场：先把面板挂进 DOM（此时停在初始位移），下一帧再切到终态触发过渡。
      React.useEffect(() => {
        if (!open) return undefined
        setVisible(true)
        void load()
        const reduced = typeof matchMedia === 'function'
          ? matchMedia('(prefers-reduced-motion: reduce)').matches
          : false
        const frame = reduced ? null : requestAnimationFrame(() => setEntered(true))
        if (reduced) setEntered(true)
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          dialogStore.setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          if (frame !== null) cancelAnimationFrame(frame)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open, load])

      // 面板真正挂进 DOM 之后才拿得到 ref，所以焦点放在 visible 上而不是 open 上。
      React.useEffect(() => {
        if (visible) panelRef.current?.focus()
      }, [visible])

      // 退场：关闭信号来了先播退场，等过渡结束再卸载，避免"啪"地消失。
      React.useEffect(() => {
        if (open || !visible) return undefined
        setEntered(false)
        const reduced = typeof matchMedia === 'function'
          ? matchMedia('(prefers-reduced-motion: reduce)').matches
          : false
        const timer = setTimeout(() => setVisible(false), reduced ? 0 : EXIT_MS)
        return () => clearTimeout(timer)
      }, [open, visible])

      React.useEffect(() => () => dialogStore.setOpen(false), [])

      // 服务端回来的上限同步到输入框（打开弹窗、以及保存成功后）。
      React.useEffect(() => {
        const limit = detail?.budget?.limit
        if (typeof limit === 'number') setLimitDraft(String(limit))
      }, [detail?.budget?.limit])

      const saveBudget = React.useCallback(async (patch) => {
        setBudgetBusy(true)
        setBudgetError(false)
        try {
          const data = await requestJson(BUDGET_ENDPOINT, { method: 'POST', body: patch })
          if (data?.ok === true && data.budget) {
            setDetail((previous) => previous === null ? previous : { ...previous, budget: data.budget })
            setBudgetSaved(true)
            setTimeout(() => setBudgetSaved(false), 1500)
          } else {
            setBudgetError(true)
          }
        } catch {
          setBudgetError(true)
        } finally {
          setBudgetBusy(false)
        }
      }, [])

      if (!visible) return null

      const titleText = t('dialog.title')
      const totals = detail?.totals ?? null
      const symbol = totals?.symbol ?? '¥'
      const windows = detail?.windows ?? null
      const periodKind = detail?.period?.kind === 'peak'
        ? 'peak'
        : detail?.period?.kind === 'off-peak' ? 'off-peak' : null
      const sessions = detail?.sessions ?? []
      const models = detail?.models ?? []
      const usageUrl = typeof detail?.links?.usageUrl === 'string' ? detail.links.usageUrl : null
      const windowTotal = windows === null ? 0 : windows.peak.amount + windows.off.amount
      const share = (value) => windowTotal <= 0 ? 0 : Math.round((value / windowTotal) * 100)
      const offShare = windows === null || windowTotal <= 0 ? 0 : Math.round((windows.off.amount / windowTotal) * 100)
      const totalAmount = totals?.amount ?? 0
      const shareOfTotal = (value) => totalAmount <= 0 ? 0 : (value / totalAmount) * 100

      // ── 头部 ────────────────────────────────────────────────────────────
      const closeButton = h('button', {
        type: 'button',
        onClick: () => dialogStore.setOpen(false),
        onMouseEnter: () => setCloseHover(true),
        onMouseLeave: () => setCloseHover(false),
        'aria-label': t('dialog.close'),
        style: {
          flex: 'none',
          width: 26,
          height: 26,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 8,
          background: closeHover
            ? 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 10%, transparent)'
            : D.lineSoft,
          color: D.ink600,
          cursor: 'pointer',
          transition: 'background 120ms ease',
        },
      }, CloseIcon(12))

      const header = h('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          padding: `16px ${M.padX}px 0`,
          flex: 'none',
        },
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } },
        h('div', { style: { color: D.ink900, fontSize: M.title, fontWeight: 600, lineHeight: '22px' } }, titleText),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('span', { style: { color: D.ink600, fontSize: M.date, whiteSpace: 'nowrap' } }, detail?.day ?? ''),
          h('span', { style: { width: 3, height: 3, borderRadius: '50%', background: D.ink400, flex: 'none' } }),
          statusBadge(t, periodKind ?? 'off-peak'))),
      closeButton)

      // ── Body 各节 ───────────────────────────────────────────────────────
      const bodyChildren = []
      if (loading && detail === null) {
        bodyChildren.push(h('div', {
          key: 'loading',
          style: { color: D.ink600, padding: '24px 0', textAlign: 'center', fontSize: M.date },
        }, t('dialog.loading')))
      }
      if (failed && detail === null) {
        bodyChildren.push(h('div', {
          key: 'failed',
          style: { color: D.ink600, padding: '24px 0', textAlign: 'center', fontSize: M.date },
        }, t('dialog.failed')))
      }

      if (detail !== null) {
        const inputParts = tokenParts(totals.inputTokens)
        const outputParts = tokenParts(totals.outputTokens)

        const metric = (key, label, parts, unitFallback) => h('div', {
          key,
          style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
        },
        h('span', { style: { color: D.ink600, fontSize: M.summaryLabel } }, label),
        h('span', { style: { display: 'flex', alignItems: 'baseline', gap: 2, minWidth: 0 } },
          h('span', {
            style: {
              color: D.ink900,
              fontSize: M.metricValue,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, parts.value),
          h('span', { style: { color: D.ink400, fontSize: M.metricUnit } }, parts.unit || unitFallback)))

        // Summary 卡片：大号合计 + 竖分隔 + 三个指标
        const summary = h('div', {
          key: 'summary',
          style: {
            display: 'flex',
            alignItems: 'stretch',
            gap: 14,
            padding: '12px 14px',
            borderRadius: 10,
            background: D.surface,
          },
        },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 'none' } },
          h('span', { style: { color: D.ink600, fontSize: M.summaryLabel, fontWeight: 500 } }, t('dialog.totalLabel')),
          h('span', {
            style: {
              color: D.ink900,
              fontSize: M.summaryValue,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: '28px',
            },
          }, money(totalAmount, symbol)),
          h('span', {
            style: {
              color: totals.saved > 0 ? D.greenInk : 'transparent',
              fontSize: M.saved,
              whiteSpace: 'nowrap',
            },
          }, t('dialog.saved', { amount: money(totals.saved ?? 0, symbol) }))),
        h('div', { style: { width: 1, background: D.line, flex: 'none' } }),
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 12,
            flex: '1 1 auto',
            minWidth: 0,
            alignItems: 'start',
          },
        },
        metric('input', t('dialog.inputToken'), inputParts),
        metric('output', t('dialog.outputToken'), outputParts),
        metric('sessions', t('dialog.sessionCount'), { value: String(totals.sessions), unit: '' }, t('dialog.unitSession'))))

        // 时段分布
        const periodRow = (kind, label, value) => h('div', {
          key: kind,
          style: {
            display: 'grid',
            gridTemplateColumns: '6px auto auto 1fr 34px 62px',
            alignItems: 'center',
            columnGap: 8,
            minHeight: 26,
            padding: '5px 0',
            minWidth: 0,
          },
        },
        h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: kind === 'peak' ? D.orange : D.green } }),
        h('span', {
          style: { color: kind === 'peak' ? D.ink600 : D.ink900, fontSize: M.period, fontWeight: 500, whiteSpace: 'nowrap' },
        }, label),
        kind === 'peak'
          ? h('span', { style: { width: 1 } })
          : h('span', {
            style: {
              padding: '2px 5px',
              borderRadius: 999,
              background: D.greenSoft,
              color: D.greenInk,
              fontSize: M.index,
              fontWeight: 500,
              whiteSpace: 'nowrap',
            },
          }, t('dialog.badgeHalf')),
        h('span', {
          style: {
            height: 6,
            borderRadius: 3,
            overflow: 'hidden',
            background: 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 8%, transparent)',
            minWidth: 0,
          },
        },
        h('span', {
          style: {
            display: 'block',
            height: '100%',
            width: `${share(value)}%`,
            borderRadius: 3,
            background: kind === 'peak' ? D.orange : D.green,
          },
        })),
        h('span', {
          style: {
            color: kind === 'peak' ? D.ink400 : D.ink600,
            fontSize: M.percent,
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          },
        }, `${share(value)}%`),
        h('span', {
          style: {
            color: kind === 'peak' ? D.ink400 : D.ink900,
            fontSize: M.price,
            fontWeight: 600,
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          },
        }, money(value, symbol)))

        const windowsSection = windows === null ? null : h('div', { key: 'windows' },
          sectionHeader(t('dialog.sectionWindows'), t('dialog.offPeakShare', { value: offShare })),
          h('div', {
            style: {
              padding: '6px 12px',
              borderRadius: 8,
              background: D.surface2,
              border: `1px solid ${D.line}`,
            },
          },
          periodRow('off-peak', t('dialog.offPeak'), windows.off.amount),
          h('div', { style: { borderTop: `1px solid ${D.line}` } }),
          periodRow('peak', t('dialog.peak'), windows.peak.amount)))

        // 按会话
        const sessionRow = (row, index) => h('div', {
          key: row.id,
          style: {
            display: 'grid',
            gridTemplateColumns: '18px minmax(0, 1fr) auto',
            alignItems: 'start',
            columnGap: 8,
            minHeight: 48,
            padding: '7px 0',
            borderTop: index === 0 ? 'none' : `1px solid ${D.line}`,
          },
        },
        h('span', {
          style: {
            color: D.ink400,
            fontSize: M.index,
            fontWeight: 500,
            fontVariantNumeric: 'tabular-nums',
            paddingTop: 2,
          },
        }, String(index + 1).padStart(2, '0')),
        h('div', { style: { minWidth: 0 } },
          h('div', {
            style: {
              color: D.ink900,
              fontSize: M.rowTitle,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, row.title ?? t('dialog.untitled', { id: String(row.id).slice(-8) })),
          h('div', {
            style: {
              color: D.ink600,
              fontSize: M.rowMeta,
              marginTop: 2,
              fontVariantNumeric: 'tabular-nums',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, `${t('input')} ${tokenText(row.inputTokens)} · ${t('output')} ${tokenText(row.outputTokens)}`)),
        h('div', { style: { textAlign: 'right', minWidth: 0 } },
          h('div', {
            style: {
              color: D.ink900,
              fontSize: M.rowPrice,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          }, money(row.amount, symbol)),
          h('div', {
            style: {
              color: D.ink600,
              fontSize: M.rowShare,
              marginTop: 2,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          }, t('dialog.shareOfTotal', { value: shareOfTotal(row.amount).toFixed(1) }))))

        const sessionsSection = h('div', { key: 'sessions' },
          sectionHeader(t('dialog.bySession'), t('dialog.sortedHint', { count: detail.sessionTotal })),
          sessions.length === 0
            ? h('div', { style: { color: D.ink600, padding: '12px 0', fontSize: M.date } }, t('dialog.empty'))
            : h('div', null, sessions.map(sessionRow)),
          detail.sessionTotal > sessions.length
            ? h('div', { style: { color: D.ink400, fontSize: M.index, marginTop: 6 } },
              t('dialog.truncated', { shown: sessions.length, total: detail.sessionTotal }))
            : null)

        // 按模型（一个模型以上才出现）
        const modelRow = (row, index) => h('div', {
          key: row.model,
          style: { borderTop: index === 0 ? 'none' : `1px solid ${D.line}`, padding: '6px 0' },
        },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 } },
          h('span', {
            style: {
              flex: 1,
              minWidth: 0,
              color: D.ink900,
              fontSize: M.rowTitle,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, row.model),
          h('span', {
            style: {
              color: D.ink600,
              fontSize: M.rowMeta,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          }, `${t('input')} ${tokenText(row.inputTokens)} · ${t('output')} ${tokenText(row.outputTokens)}`),
          h('span', {
            style: {
              color: D.ink900,
              fontSize: M.rowPrice,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          }, money(row.amount, symbol))))

        const modelsSection = models.length > 1
          ? h('div', { key: 'models' },
            sectionHeader(t('dialog.byModel'), null),
            h('div', null, models.map(modelRow)))
          : null

        // ── 每日预算 ──────────────────────────────────────────────────
        const budgetInfo = detail.budget ?? null
        let budgetSection = null
        if (budgetInfo !== null) {
          const percent = budgetInfo.limit > 0 ? Math.round((budgetInfo.spent / budgetInfo.limit) * 100) : 0
          const hint = !budgetInfo.enabled
            ? t('budget.hintOff')
            : budgetInfo.blocked
              ? t('budget.hintBlocked')
              : budgetInfo.warning ? t('budget.hintWarning') : t('budget.hintOn', { percent })
          const barColor = budgetInfo.blocked ? D.error : budgetInfo.warning ? D.orange : D.green

          const budgetSwitch = h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': budgetInfo.enabled ? 'true' : 'false',
            'aria-label': t('budget.enable'),
            disabled: budgetBusy,
            onClick: () => { if (!budgetBusy) void saveBudget({ enabled: !budgetInfo.enabled }) },
            style: {
              flex: 'none',
              width: 38,
              height: 22,
              padding: 0,
              border: 'none',
              borderRadius: 999,
              position: 'relative',
              cursor: budgetBusy ? 'default' : 'pointer',
              background: budgetInfo.enabled
                ? 'var(--dsw-alias-state-success-primary, currentColor)'
                : 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 18%, transparent)',
              transition: 'background 140ms ease',
              opacity: budgetBusy ? 0.6 : 1,
            },
          }, h('span', {
            style: {
              position: 'absolute',
              top: 2,
              left: budgetInfo.enabled ? 18 : 2,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--dsw-alias-label-on-color, #ffffff)',
              boxShadow: '0 1px 2px rgba(16, 24, 40, 0.2)',
              transition: 'left 140ms ease',
            },
          }))

          const limitInput = h('input', {
            type: 'number',
            min: '0',
            step: '1',
            inputMode: 'decimal',
            value: limitDraft,
            disabled: !budgetInfo.enabled || budgetBusy,
            'aria-label': t('budget.limit'),
            onChange: (event) => setLimitDraft(event.target.value),
            onBlur: () => {
              const value = Number(limitDraft)
              if (!Number.isFinite(value) || value <= 0) {
                setLimitDraft(String(budgetInfo.limit))
                return
              }
              if (value !== budgetInfo.limit) void saveBudget({ limit: value })
            },
            onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
            style: {
              width: 66,
              padding: '3px 8px',
              border: `1px solid ${D.line}`,
              borderRadius: 6,
              background: 'transparent',
              color: D.ink900,
              font: 'inherit',
              fontSize: M.rowTitle,
              textAlign: 'right',
            },
          })

          const rowDivider = () => h('div', { style: { borderTop: `1px solid ${D.line}` } })

          budgetSection = h('div', { key: 'budget' },
            sectionHeader(t('budget.title'), hint),
            h('div', {
              style: {
                padding: '2px 12px',
                borderRadius: 8,
                background: D.surface2,
                border: `1px solid ${D.line}`,
              },
            },
            h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 0',
              },
            },
            h('span', { style: { color: D.ink900, fontSize: M.rowTitle } }, t('budget.enable')),
            budgetSwitch),
            rowDivider(),
            h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 0',
                opacity: budgetInfo.enabled ? 1 : 0.5,
              },
            },
            h('span', { style: { color: D.ink600, fontSize: M.rowMeta } }, t('budget.limit')),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              limitInput,
              h('span', { style: { color: D.ink400, fontSize: M.rowMeta } }, t('budget.unit')))),
            budgetInfo.enabled ? h(React.Fragment, null,
              rowDivider(),
              h('div', { style: { padding: '9px 0 10px', display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', {
                  style: {
                    height: 6,
                    borderRadius: 3,
                    overflow: 'hidden',
                    background: 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 8%, transparent)',
                  },
                },
                h('div', {
                  style: {
                    height: '100%',
                    width: `${Math.min(100, Math.max(0, percent))}%`,
                    borderRadius: 3,
                    background: barColor,
                  },
                })),
                h('div', {
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    color: D.ink600,
                    fontSize: M.rowMeta,
                    fontVariantNumeric: 'tabular-nums',
                  },
                },
                h('span', null, t('budget.used', {
                  spent: money(budgetInfo.spent, symbol),
                  limit: money(budgetInfo.limit, symbol),
                  percent,
                })),
                budgetSaved ? h('span', { style: { color: D.greenInk } }, t('budget.saved')) : null),
                budgetInfo.blocked
                  ? h('div', { style: { color: D.error, fontSize: M.rowMeta, lineHeight: '15px' } }, t('budget.blocked'))
                  : budgetInfo.warning
                    ? h('div', { style: { color: D.orange, fontSize: M.rowMeta, lineHeight: '15px' } }, t('budget.warning', { percent }))
                    : h('div', { style: { color: D.ink400, fontSize: M.rowMeta, lineHeight: '15px' } }, t('budget.enableHint')),
                budgetInfo.blocked && budgetInfo.blockedCount > 0
                  ? h('div', { style: { color: D.ink400, fontSize: M.rowMeta } }, t('budget.blockedCount', { count: budgetInfo.blockedCount }))
                  : null,
                budgetError
                  ? h('div', { style: { color: D.error, fontSize: M.rowMeta } }, t('budget.saveFailed'))
                  : null))
              : null))
        }

        bodyChildren.push(summary, windowsSection, budgetSection, sessionsSection, modelsSection)
      }

      const body = h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: `14px ${M.padX}px`,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          minHeight: 0,
          flex: '1 1 auto',
        },
      }, ...bodyChildren.filter(Boolean))

      // ── 页脚 ────────────────────────────────────────────────────────────
      const refreshButton = h('button', {
        type: 'button',
        onClick: () => { void load() },
        onMouseEnter: () => setRefreshHover(true),
        onMouseLeave: () => setRefreshHover(false),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          border: 'none',
          borderRadius: 8,
          background: refreshHover
            ? 'color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 10%, transparent)'
            : D.lineSoft,
          color: D.ink700,
          font: 'inherit',
          fontSize: M.button,
          fontWeight: 500,
          lineHeight: '18px',
          cursor: 'pointer',
          transition: 'background 120ms ease',
        },
      },
      h('span', { style: { color: D.ink600, display: 'inline-flex' } }, RefreshIcon(12)),
      t('dialog.refresh'))

      const platformLink = usageUrl === null ? null : h('a', {
        href: usageUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px',
          borderRadius: 8,
          background: D.blue,
          color: D.onColor,
          fontSize: M.button,
          fontWeight: 500,
          lineHeight: '18px',
          textDecoration: 'none',
          whiteSpace: 'nowrap',
        },
      },
      t('dialog.openPlatform'),
      h('span', { style: { display: 'inline-flex' } }, ExternalIcon(12)))

      const footer = h('div', {
        style: {
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: `10px ${M.padX}px 14px`,
        },
      },
      h('div', { style: { color: D.ink600, fontSize: M.disclaimer, lineHeight: '15px' } }, t('dialog.disclaimer')),
      h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 },
      },
      h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 5, color: D.ink600, fontSize: M.time, minWidth: 0 },
      },
      h('span', { style: { color: D.ink400, display: 'inline-flex' } }, ClockIcon(12)),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        detail === null ? '' : t('dialog.updated', { time: new Date(detail.generatedAt).toLocaleTimeString() }))),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' } },
        refreshButton,
        platformLink)))

      const panel = h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': titleText,
        tabIndex: -1,
        style: {
          boxSizing: 'border-box',
          // 尺寸写死：宽 520、高 640。内容多少都靠 Body 内部滚动，弹窗本身不随内容伸缩，
          // 否则数据一到 / 会话数变化时高度会突变。maxHeight 只兜小屏幕，不参与内容自适应。
          width: `min(${M.panelWidth}px, 100%)`,
          height: M.panelHeight,
          maxHeight: 'calc(100vh - 32px)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 14,
          background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))',
          backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))',
          WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))',
          boxShadow: 'var(--dsw-elevation-prominent, 0 18px 48px rgba(16,24,40,0.08))',
          color: D.ink600,
          outline: 'none',
          overflow: 'hidden',
          opacity: entered ? 1 : 0,
          transform: entered ? 'translateY(0) scale(1)' : 'translateY(8px) scale(0.96)',
          transition: `opacity ${entered ? ENTER_MS : EXIT_MS}ms ${EASE}, transform ${entered ? ENTER_MS : EXIT_MS}ms ${EASE}`,
          willChange: 'opacity, transform',
          '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
          '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
        },
        onClick: (event) => event.stopPropagation(),
      },
      header,
      body,
      h('div', { style: { flex: 'none', borderTop: `1px solid ${D.line}` } }),
      footer)

      return h('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 1200,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'color-mix(in srgb, #000000 40%, transparent)',
          pointerEvents: open ? 'auto' : 'none',
          opacity: entered ? 1 : 0,
          transition: `opacity ${entered ? ENTER_MS : EXIT_MS}ms ${EASE}`,
        },
        onClick: () => dialogStore.setOpen(false),
      }, panel)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 两份字典都交给宿主语言服务，切语言时条目跟着变。
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'spend-meter: 字典')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'spend-meter',
          order: 0,
        }, (props) => h(SpendMeter, { ...props, t, ctx })))
        // 弹窗放进帧级浮层：侧栏会裁切 overflow，弹窗不能挂在侧栏里。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'spend-meter.dialog',
          order: 60,
        }, (props) => h(SpendDialog, { ...props, t, ctx })))
      },
    }
  },
})
