// 本轮 UI 整理（学员名单一人一行 / 学员详情课时包横向卡 / 统计页层级整理）的**共用判据**。
//
// ⭐ 为什么是「纯函数 + 逐条返回结果」而不是直接 assert：
//    · 正式测试  tests/students-one-row-list.test.js、tests/stats-page-hierarchy.test.js
//    · 判别力反证 tests/_students-one-row-list-mutate.js、tests/_stats-page-hierarchy-mutate.js
//    两边跑的是**同一份判据**。所以"把源码改坏之后判据真的变红"这件事才有意义 ——
//    否则只是另写了一套"我猜它会红"的断言。
//
// ⛔ 全程只读文本：不碰业务数据、不写 Storage、不加载云命令、不发起任何写入。
// ⛔ 判据一律先剥注释再匹配：注释里提到旧类名是"说明"，不是"回潮"。

const stripCss = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '')
const stripHtml = src => String(src).replace(/<!--[\s\S]*?-->/g, '')
// JS 里只剥块注释与行注释（避免把 'https://' 这种误伤：要求 // 前不是冒号）
const stripJs = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** 取某个选择器命中的全部规则体（允许规则出现在行首或紧随 } 之后，@media 内的也算） */
const ruleBodies = (wxss, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(?:^|[\\s}])' + escaped + '\\s*\\{([^}]*)\\}', 'g')
  const bodies = []
  let match
  while ((match = re.exec(wxss))) bodies.push(match[1])
  return bodies
}

/** 某个选择器上某个属性的 rpx 数值（取最后一条声明，等价于 CSS 层叠结果）；找不到返回 null */
const declRpx = (wxss, selector, prop) => {
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*(-?[\\d.]+)rpx')
  const bodies = ruleBodies(wxss, selector)
  for (let i = bodies.length - 1; i >= 0; i--) {
    const match = re.exec(bodies[i])
    if (match) return Number(match[1])
  }
  return null
}

/** padding 简写换算（优先取显式 padding-<side>）；side ∈ top/right/bottom/left */
const paddingRpx = (wxss, selector, side) => {
  const index = { top: 0, right: 1, bottom: 2, left: 3 }[side]
  const explicit = declRpx(wxss, selector, 'padding-' + side)
  if (explicit !== null) return explicit
  const bodies = ruleBodies(wxss, selector)
  for (let i = bodies.length - 1; i >= 0; i--) {
    const match = /(?:^|;)\s*padding\s*:\s*([^;}]+)/.exec(bodies[i])
    if (!match) continue
    // ⛔ 无单位数字只有 `0` 合法（CSS 里 `padding:10` 是无效声明）。
    //    曾经这里只认 `[\d.]+rpx` ⇒ `padding:30rpx 54rpx 0 24rpx` 整条被判为"解析不出"（返回 null），
    //    于是"页面顶部内边距"这种常识性数值静默丢失、依赖它的判据跟着假绿。
    const parts = match[1].trim().split(/\s+/).map(value => {
      const hit = /^(-?[\d.]+)(rpx)?$/.exec(value)
      if (!hit) return null
      if (!hit[2] && Number(hit[1]) !== 0) return null
      return Number(hit[1])
    })
    if (parts.some(value => value === null) || parts.length === 0) continue
    if (parts.length === 1) return parts[0]
    if (parts.length === 2) return parts[index === 0 || index === 2 ? 0 : 1]
    if (parts.length === 3) return index === 1 ? 1 : index === 3 ? 1 : parts[index]
    return parts[index]
  }
  return null
}

/** padding 简写换算出的 padding-bottom（保留旧名，语义同 paddingRpx(..., 'bottom')） */
const paddingBottomRpx = (wxss, selector) => paddingRpx(wxss, selector, 'bottom')

/**
 * wxml 里是否存在**这个** class。
 * ⛔ 必须带边界：早先写成 `class="[^"]*pkg-card-price`，结果 `pkg-card-price` → `pkg-card-price-x`
 *    仍然算命中 —— 反证（S20）就是这么抓出这条假绿的。类名后面只能是空格或收尾引号。
 */
const hasClass = (wxml, cls) => new RegExp('class="(?:[^"]*\\s)?' + cls.replace(/[-]/g, '\\-') + '(?=\\s|")').test(wxml)

const count = (text, needle) => text.split(needle).length - 1
const item = (name, pass, detail) => ({ name, pass: !!pass, detail: detail || '' })

/**
 * 取包含 needle 的**整条标签**。
 * ⛔ 不靠属性顺序做正则：wx:key 与 class 谁在前是实现自由，
 *    早期写成 `class="..."[^>]*wx:key=...` 就会因为属性顺序不同而假红/假绿。
 */
const tagOf = (wxml, needle) => {
  const at = wxml.indexOf(needle)
  if (at < 0) return ''
  const start = wxml.lastIndexOf('<', at)
  const end = wxml.indexOf('>', at)
  if (start < 0 || end < 0) return ''
  return wxml.slice(start, end + 1)
}

// ═══════════════════════════ 学员名单 / 课时包 ═══════════════════════════

function studentsContract(source) {
  const w = stripHtml(source.wxml)
  const s = stripCss(source.wxss)
  const a = stripCss(source.appWxss)
  const j = stripJs(source.js)
  const out = []

  // ① 一人一行：外层卡片本身就等于一个学员，点它进详情
  const rowTag = tagOf(w, 'class="card student-row"')
  out.push(item('row-wrapper',
    count(w, 'class="card student-row"') === 1
    && /wx:key="id"/.test(rowTag)
    && /data-id="\{\{student\.id\}\}"/.test(rowTag)
    && /bindtap="edit"/.test(rowTag),
    '名单每一项必须是 class="card student-row"，且同一条标签上带 wx:key="id" / data-id="{{student.id}}" / bindtap="edit"，实得：' + rowTag))

  out.push(item('row-name', /\{\{student\.name\}\}/.test(w), '缺少 {{student.name}}'))
  out.push(item('row-meta-phone', /\{\{student\.phone\|\|'未填手机号'\}\}/.test(w), "手机号必须有兜底文案 '未填手机号'"))

  // ② 关键状态：有课时包 → 剩余/总量；没有 → 明说"未购课时包"（不许留空白）
  out.push(item('row-state-has',
    /wx:if="\{\{student\.rowHas\}\}"/.test(w) && /剩余 \{\{student\.rowLeft\}\} \/ \{\{student\.rowTotal\}\} 节/.test(w),
    '有课时包时必须显示「剩余 {{rowLeft}} / {{rowTotal}} 节」'))
  out.push(item('row-state-empty',
    /wx:else/.test(w) && /未购课时包/.test(w),
    '没有课时包时必须显示「未购课时包」，不能留空白'))
  out.push(item('row-warn',
    /\{\{student\.rowWarn\?'warn':''\}\}/.test(w) && /wx:if="\{\{student\.rowWarn\}\}"/.test(w) && /\{\{student\.rowWarnText\}\}/.test(w),
    '快用完的课时包必须有独立标记：warn 类名 + rowWarnText 文案'))
  out.push(item('row-arrow', /class="student-row-arrow"/.test(w), '缺少右侧箭头 student-row-arrow（"能点进去"的可供性）'))

  // ③ 旧结构不许回潮
  out.push(item('no-legacy-row',
    count(w, 'student-card') === 0 && count(w, 'student-fab') === 0 && count(s, 'student-fab') === 0,
    '旧的 .student-card（每人每包一行）与 .student-fab（圆形悬浮球）都不许回潮'))

  // ④ ⭐ 2026-10-03 · 新增入口从「右下悬浮胶囊」搬进**标题行**（真机验收：悬浮按钮必然压名单）
  //   ⛔ 判据换了形状，但保护的东西没变：**新增会员入口必须在、且不许遮挡任何一行**。
  //      现在的做法是把按钮放进流里（跟着名单滚），遮挡问题结构性消失。
  const addTag = tagOf(w, 'class="students-add"')
  out.push(item('add-entry-in-head',
    /class="students-add"[^>]*(bindtap|catchtap)="add"/.test(w) && />＋新增</.test(w)
    && w.indexOf('class="students-add"') < w.indexOf('class="students-head-right"') + 200
    && w.indexOf('class="students-add"') > w.indexOf('class="students-page-head"'),
    '「＋新增」必须住在标题行 .students-page-head 里、绑定 add，实测：' + (addTag || '找不到 .students-add')))
  // ⛔ 按钮本身不许再"浮"起来：position:fixed 一出现，它就又开始压行（这正是被否掉的形状）
  const addBody = ruleBodies(s, '.students-list-page .students-add').join(';')
  out.push(item('add-entry-not-floating',
    addBody.length > 0 && !/position\s*:\s*(fixed|absolute)/.test(addBody),
    '⛔ 「＋新增」不许用 position:fixed/absolute（浮动元素必然压住名单里的某一行），实测：' + addBody))
  // ⛔ 悬浮胶囊与安全带必须**彻底消失**（留着就是"点得到的装饰品"或"白占的底部空地"）
  out.push(item('no-floating-capsule',
    !/class="fab-capsule"/.test(w) && !/fab-plus|fab-label/.test(w),
    '⛔ 右下悬浮胶囊（.fab-capsule / .fab-plus / .fab-label）不许回潮 —— 它已被标题行的「＋新增」取代'))

  // ⑤ 密度：一个人 = 一行；行高必须"够大能点"又"够小能一屏多塞几个"
  const rowH = declRpx(s, '.students-list-page .student-row', 'height')
  const rowGap = declRpx(s, '.students-list-page .student-row', 'margin-bottom') || 0
  out.push(item('row-density',
    rowH !== null && rowH >= 88 && rowH + rowGap <= 116,
    '单人行占位 = height + margin-bottom，必须落在 88~116rpx：实测 height=' + rowH + 'rpx + ' + rowGap + 'rpx'))

  // ⑥ ⭐⭐⭐ 胶囊不许压住内容 —— **从"滚到底不挡"升级为"任何滚动位置都不挡"**（2026-10-03）
  //
  //   ⛔ 旧判据（已废弃，不要再写回来）：`listPadBottom >= 96`。
  //      它只证明「滚到底时最后一行在胶囊之上」。可是胶囊是 position:fixed、名单跟着整页滚，
  //      ⇒ 手指停在任意**中间**位置时，胶囊照样压在某一行的姓名 / 剩余节数上。
  //      一条"滚到底才不挡"的判据，保护的是一个用户明确不接受的形状（真机已复现）。
  //
  //   ⭐ 2026-10-03 **现行判据**：悬浮胶囊与安全带一起删掉 ⇒ **页面上不存在任何悬浮遮挡物**，
  //      名单吃满整个页面高度（底部那段 40rpx 只是"下拉余量配平"，不是让位）。
  //      ⇒ 判据从"安全带够不够高"换成"安全带必须不存在 + 名单高度 = 页面内容高"。
  out.push(item('no-bottom-band',
    !s.includes('.students-fab-band') && !w.includes('students-fab-band'),
    '⛔ .students-fab-band（为悬浮胶囊留的底部安全带）不许存在 —— 它已被删除，'
    + '留着就是名单白白少用掉 144rpx（真机验收否掉了这个代价）'))

  // ⭐ 名单**铺到 tabBar 上方**：页面比视口高 40rpx（原生下拉刷新余量），
  //    所以 padding-bottom 必须**正好等于那 40rpx** ⇒ 滚动区下沿恰好落在视口底。
  //    ⛔ 少了 ⇒ 最后一行被推到屏幕外 20px；多了 ⇒ 底部又出现一块空地（就是被否掉的形状）。
  const pageBodiesAll = ruleBodies(s, '.students-list-page').join(';')
  const PULLDOWN_ROOM = Number((/100vh\s*\+\s*([\d.]+)rpx/.exec(pageBodiesAll) || [, 0])[1])
  const padBottomNow = paddingRpx(s, '.students-list-page', 'bottom') || 0
  out.push(item('bottom-balanced',
    PULLDOWN_ROOM > 0 && padBottomNow === PULLDOWN_ROOM,
    '⛔ 名单下沿必须正好压在视口底（tabBar 上沿）：padding-bottom 必须**等于**页面多出来的下拉余量 '
    + PULLDOWN_ROOM + 'rpx，实测 ' + padBottomNow + 'rpx'))

  // 滚动区：flex:1 1 auto + min-height:0（少了 min-height:0 它会被内容撑破 ⇒ 又把页面顶成滚动容器）
  const scrollBody = ruleBodies(s, '.students-list-page .students-scroll').join(';')
  out.push(item('inner-scroller',
    /flex\s*:\s*1\s+1\s+auto/.test(scrollBody) && /min-height\s*:\s*0/.test(scrollBody),
    '.students-scroll 必须是 flex:1 1 auto + min-height:0（否则会被内容撑破，页面又变成滚动容器），实测：' + scrollBody))

  // 页面自身：必须是**确定高度**（不是被内容/min-height 撑出来的），且不能再用 min-height:100vh 做滚动容器
  const pageHeightRule = ruleBodies(s, '.students-list-page').find(body => /(?:^|;)\s*height\s*:/.test(body)) || ''
  const pageHeightRaw = (/(?:^|;)\s*height\s*:\s*([^;}]+)/.exec(pageHeightRule) || [, ''])[1].trim()
  const pageMinHeight = (/(?:^|;)\s*min-height\s*:\s*([^;}]+)/.exec(ruleBodies(s, '.students-list-page').join(';')) || [, ''])[1].trim()
  out.push(item('page-definite-height',
    /calc\(/.test(pageHeightRaw) && /100vh/.test(pageHeightRaw) && pageMinHeight !== '100vh',
    '.students-list-page 必须有确定高度（calc + 100vh），⛔ 不能用 min-height:100vh 让页面自己滚'
    + '（那样页面高度随内容变 ⇒ 名单在页面流里滚 ⇒ 胶囊必然压住中间位置的行）。实测 height:' + pageHeightRaw
    + ' / min-height:' + (pageMinHeight || '无')))

  out.push(item('native-pulldown-room',
    /100vh\s*\+\s*40rpx/.test(pageHeightRaw),
    '确定高度里必须留 +40rpx 原生下拉余量：微信原生下拉刷新要求页面自身有可滚动空间，'
    + '去掉它 onPullDownRefresh 永不触发（1.1.9 真机事故）。实测 height:' + pageHeightRaw))

  out.push(item('banner-height-deducted',
    /var\(--sandbox-banner-h\)/.test(ruleBodies(s, '.students-list-page.with-banner').join(';')),
    '测试环境横幅**占流**（sticky 96rpx）⇒ .students-list-page.with-banner 必须扣掉 var(--sandbox-banner-h)，'
    + '否则滚动区下沿被推进安全带（底部行被胶囊压住）'))

  // 手指落在名单上也要能下拉刷新（滚动搬到内部之后，页面级 onPullDownRefresh 覆盖不到手指落点）
  const scrollTag = tagOf(w, 'class="students-scroll"')
  out.push(item('scroll-refresher',
    /scroll-y/.test(scrollTag) && /refresher-enabled="\{\{true\}\}"/.test(scrollTag)
    && /bindrefresherrefresh="onListRefresh"/.test(scrollTag) && /onListRefresh\s*\(/.test(j),
    '滚动区必须自己接上下拉刷新（scroll-y + refresher-enabled + bindrefresherrefresh="onListRefresh"），'
    + '否则手指落在名单上时下拉"什么都没发生"。实测：' + scrollTag))

  // 字母导航：页面已经不再滚动 ⇒ 必须走滚动区的 scroll-into-view，pageScrollTo 不许残留（那是死入口）
  out.push(item('scroll-into-view-nav',
    /scroll-into-view="\{\{scrollTarget\}\}"/.test(scrollTag)
    && /scrollTarget/.test(j) && !/pageScrollTo/.test(j) && !/createSelectorQuery/.test(j),
    '字母导航必须改成滚动区的 scroll-into-view（受控属性 ⇒ 同一字母连点还要"先清空再设"），'
    + '⛔ 页面级 pageScrollTo / createSelectorQuery 不许残留：页面已经不在滚，那是点了没反应的死入口'))

  // ⛔ 旧的 `no-page-padding-clearance`（padding-bottom <= 4）**已作废**：
  //    它是"让位由安全带提供"那个形状的配套判据。安全带没了之后，padding-bottom 的唯一合法值
  //    就是"下拉余量配平"（见 bottom-balanced）—— 判据已经换到那儿，这里只钉"不许再叠加让位"。
  out.push(item('no-extra-clearance',
    padBottomNow <= PULLDOWN_ROOM,
    '⛔ padding-bottom 不许超过下拉余量（多出来的一律是"给某个悬浮物让位"，正是被否掉的形状）。'
    + '实测 padding-bottom:' + padBottomNow + 'rpx / 下拉余量 ' + PULLDOWN_ROOM + 'rpx'))

  // ⑦ 课时包横向紧凑卡
  const pkgParts = ['pkg-card-icon', 'pkg-card-name', 'pkg-card-facts', 'pkg-card-left', 'pkg-card-left-num', 'pkg-card-bar', 'pkg-card-bar-fill', 'pkg-card-price', 'pkg-card-manage']
  const missing = pkgParts.filter(cls => !hasClass(w, cls))
  out.push(item('pkg-card-shape', count(w, 'class="pkg-card"') === 1 && missing.length === 0,
    '横向课时包卡必须一行内放下图标/名称/剩余/进度/单价/管理入口，缺：' + (missing.join('、') || '无')))
  out.push(item('pkg-card-facts',
    /<text class="pkg-card-left"><text class="pkg-card-left-num">\{\{item\.remaining\}\}<\/text> \/ \{\{item\.total\}\} 节/.test(w)
    && /item\.type==='赠送课程'\?'赠送':\(item\.price\?\('¥'\+item\.price\+'\/节'\):'未定价'\)/.test(w),
    '默认态必须给出「剩余 N / 总量 节」与「赠送 / ¥单价/节 / 未定价」'))
  out.push(item('pkg-manage-branches',
    /class="pkg-card-manage"[^>]*(bindtap|catchtap)="openSaleEditor"/.test(w)
    && /class="pkg-card-manage"[^>]*(bindtap|catchtap)="togglePackageEdit"/.test(w),
    '课时包入口的两条分支（openSaleEditor / togglePackageEdit）一个都不许丢'))
  // ⭐ 2026-10-03：「管理」这个文案废掉；没有唯一销售关联的历史包只能「查看」，不许伪装成可编辑。
  // ⛔ 匹配要带 `>` 前缀：「授权管理 ›」「查看与管理谁能…」里的"管理"是别的入口，**不算**课时包那个含混文案。
  out.push(item('pkg-view-copy',
    !/>管理/.test(w) && /class="pkg-card-manage is-view"[^>]*(bindtap|catchtap)="togglePackageEdit"[^>]*>查看/.test(w),
    '⛔ 课时包入口不许再叫「管理」；查不到唯一销售关联的历史包必须显示「查看」（带 .is-view），实测含 ">管理"：' + />管理/.test(w)))
  // ⭐ 整张卡片可点：分流函数只做"进哪个入口"，自己不写业务数据。
  out.push(item('pkg-card-tappable',
    /class="pkg-card"[^>]*(bindtap|catchtap)="packageCardTap"/.test(w) && /packageCardTap\(e\)\s*\{/.test(j),
    '整张课时包卡片必须可点（bindtap="packageCardTap"），且 students.js 里真有 packageCardTap 的实现'))
  const pctBody = (/packageCardTap\(e\)\s*\{([\s\S]*?)\n {2}\}/.exec(j) || [, ''])[1]
  out.push(item('pkg-card-dispatch-only',
    pctBody.length > 0 && /openSaleEditor|togglePackageEdit/.test(pctBody)
    && !/setData|setStorage|writeDB|callFunction|getDB\(/.test(pctBody),
    'packageCardTap 只做分流（openSaleEditor / togglePackageEdit），不许自己写任何业务数据，实测：' + pctBody))
  out.push(item('pkg-head-conditional',
    /wx:if="\{\{item\.isNew \|\| packageEditing\[index\]\}\}" class="package-detail-head"/.test(w),
    'package-detail-head 只在新增/编辑态出现（默认态不许再顶着标题重复一遍名称）'))
  out.push(item('no-legacy-package-display',
    count(w, 'class="package-display"') === 0,
    '旧的竖排 .package-display 默认态不许回潮'))

  // ⑧ 分子分母同源：本地会员与授权会员共用同一个纯视图函数，且传的是同一个 visiblePackages
  out.push(item('summary-single-source',
    /function rowSummaryOf\(visiblePackages\)/.test(j) && count(j, '...rowSummaryOf(visiblePackages)') === 2,
    'rowSummaryOf 必须只定义一次，并在本地会员与授权会员两处都以 visiblePackages 为唯一入参调用'))
  const fnBody = (/function rowSummaryOf\(visiblePackages\)\{([\s\S]*?)\n\}/.exec(j) || [, ''])[1]
  out.push(item('summary-pure',
    fnBody.length > 0 && !/setData|setStorage|writeDB|cloud|callFunction|getDB/.test(fnBody),
    'rowSummaryOf 必须是纯视图函数（不许 setData / 写库 / 调云端）'))

  return out
}

// ═══════════════════════════ 统计页 ═══════════════════════════

function statsContract(source) {
  const w = stripHtml(source.wxml)
  const s = stripCss(source.wxss)
  const j = stripJs(source.js)
  const out = []

  // ① 月份切换搬到页首，且在数据卡之前
  const headAt = w.indexOf('class="stats-head"')
  const cardAt = w.indexOf('class="card overview-section"')
  out.push(item('head-first',
    headAt > 0 && cardAt > 0 && headAt < cardAt,
    '页首 .stats-head 必须存在且排在 .overview-section 之前（月份是这一页的第一层信息）'))
  out.push(item('head-month', /\{\{monthTitle\}\}/.test(w), '页首必须显示 {{monthTitle}}'))
  out.push(item('head-sub', w.includes('本月数据 · 完课收入与销售业绩独立计算'), '页首副标题缺失'))

  // ② 统一入口：月份切换与「按日期查询」共用同一个 .stats-head-entry（同一套尺寸与层级）
  const entryCount = count(w, 'class="stats-head-entry"')
  out.push(item('entry-unified',
    entryCount === 2
    && /class="stats-head-entry"[^>]*bindtap="openHistory"/.test(w)
    && /class="stats-head-entry"[^>]*bindtap="openAttendanceHistory"/.test(w),
    '两个入口必须共用 .stats-head-entry：月份切换→openHistory、按日期查询→openAttendanceHistory，实测 ' + entryCount + ' 处'))
  out.push(item('head-entry-copy',
    /class="stats-head-entry"[^>]*>按月查看 ›</.test(w) && /class="stats-head-entry"[^>]*>按日期查询 ›</.test(w),
    '入口文案必须是「按月查看 ›」与「按日期查询 ›」'))
  out.push(item('head-entry-feedback',
    count(w, 'hover-class="stats-head-entry-on"') === 2 && /\.stats-head-entry-on\s*\{/.test(s),
    '两个入口都要有按压反馈（hover-class + .stats-head-entry-on 规则）'))

  // ③ 可点性：沿用 1.1.9 真机反馈的标准（字体 >= 25rpx、可点高 >= 64rpx、左右内边距 >= 16rpx）
  const bodies = ruleBodies(s, '.stats-head-entry')
  const sizeBodies = bodies.filter(body => /font-size\s*:/.test(body))
  const sizes = sizeBodies.map(body => Number((/font-size\s*:\s*([\d.]+)rpx/.exec(body) || [])[1]))
  out.push(item('head-entry-font',
    sizes.length > 0 && sizes.every(value => Number.isFinite(value) && value >= 25),
    '入口字体必须显式写且 >= 25rpx（真机反馈"不够明显"），实测 ' + JSON.stringify(sizes)))
  const boxBody = bodies.find(body => /line-height\s*:/.test(body) && /padding\s*:/.test(body)) || ''
  const lh = Number((/line-height\s*:\s*([\d.]+)rpx/.exec(boxBody) || [])[1])
  const pad = /padding\s*:\s*([\d.]+)rpx\s+([\d.]+)rpx/.exec(boxBody)
  const tapHeight = pad ? lh + 2 * Number(pad[1]) : NaN
  out.push(item('head-entry-tap-height',
    Number.isFinite(tapHeight) && tapHeight >= 64 && pad && Number(pad[2]) >= 16,
    '可点高度 = line-height + 上下 padding，必须 >= 64rpx 且左右 padding >= 16rpx，实测 ' + tapHeight + 'rpx'))
  const merged = bodies.join(';')
  out.push(item('head-entry-light',
    /background\s*:\s*(?:#e8f0ff|var\(--soft\)|#eef4ff)/.test(merged) && !/background\s*:\s*var\(--accent\)(?![0-9a-zA-Z-])/.test(merged),
    '入口是浅色胶囊（次级），不得改成实心主按钮'))

  // ④ 紧凑数据卡：四格，值与口径必须还是原来那四个
  out.push(item('mini-row', count(w, 'class="stat-mini"') === 4 && count(w, 'class="stat-mini-row"') === 1,
    '必须恰好一个 .stat-mini-row 且内含 4 个 .stat-mini，实测 ' + count(w, 'class="stat-mini"') + ' 个'))
  const labels = ['完成课时', '上课会员', '本月目标', '目标进度']
  const labelHit = labels.every((label, index) => w.includes('class="stat-mini"><b>' + ['{{monthSessions}}', '{{ranking.length}}', '{{monthlyGoalSessions}}', '{{monthSessions}}/{{monthlyGoalSessions}}'][index] + '</b><text>' + label + '</text>'))
  out.push(item('mini-values', labelHit,
    '四格的 (值, 标签) 必须精确是 (monthSessions,完成课时) (ranking.length,上课会员) (monthlyGoalSessions,本月目标) (monthSessions/monthlyGoalSessions,目标进度)'))

  // ⑤ 被替换掉的旧结构：wxml 与 wxss 都不许留下
  const deadWxml = ['attendance-summary', 'goal-line', 'ranking-title'].filter(name => w.includes(name))
  out.push(item('no-legacy-structure', deadWxml.length === 0, '旧的 wxml 结构残留：' + (deadWxml.join('、') || '无')))
  const deadWxss = ['attendance-summary', 'goal-line', 'ranking-title', 'head-actions', 'history-button', 'mini-add', 'inline-entry', 'eyebrow'].filter(name => s.includes(name))
  out.push(item('no-legacy-css', deadWxss.length === 0, '已删结构的死样式残留：' + (deadWxss.join('、') || '无')))
  out.push(item('ranking-empty-state', /暂无完课数据/.test(w), '排行空态文案必须保留'))

  // ⑥ 弱化设置入口
  out.push(item('ghost-settings',
    /class="card settings-entry ghost-entry"/.test(w)
    && /\.settings-entry\.ghost-entry\s*\{[^}]*background\s*:\s*transparent[^}]*\}/.test(s)
    && /\.settings-entry\.ghost-entry\s*\{[^}]*border\s*:\s*1rpx dashed[^}]*\}/.test(s)
    && /\.settings-entry\.ghost-entry\s*\{[^}]*box-shadow\s*:\s*none[^}]*\}/.test(s),
    '设置入口必须是虚线透明弱化样式（background:transparent + border:1rpx dashed + box-shadow:none）'))
  const ghostTitle = declRpx(s, '.settings-entry.ghost-entry .title', 'font-size')
  const monthSize = declRpx(s, '.stats-month', 'font-size')
  out.push(item('ghost-weaker',
    ghostTitle !== null && monthSize !== null && ghostTitle < monthSize,
    '弱化后设置标题必须明显小于页首月份标题，实测 ' + ghostTitle + 'rpx < ' + monthSize + 'rpx'))

  // ⑦ 功能入口与弹层一个都不能少（只改外观，不许改功能）
  const entries = ['openHistory', 'openAttendanceHistory', 'openSettings', 'openSalesDetail', 'openSale']
  const lostEntries = entries.filter(name => !new RegExp('bindtap="' + name + '"').test(w))
  out.push(item('entries-intact', lostEntries.length === 0, '丢失的入口：' + (lostEntries.join('、') || '无')))
  const modals = ['historyModal', 'salesDetailModal', 'settingsModal', 'saleModal']
  const lostModals = modals.filter(name => !new RegExp('wx:if="\\{\\{' + name + '\\}\\}"').test(w))
  out.push(item('modals-intact', lostModals.length === 0, '丢失的弹层：' + (lostModals.join('、') || '无')))

  // ⑧ 月份标题是纯视图字段，由 render 从当前月份派生（不新增数据源、不硬编码）
  out.push(item('month-title-source',
    /monthTitle:''/.test(j) && /monthTitle:`\$\{beijingDate\.year\}年\$\{beijingDate\.month\}月`/.test(j)
    && /const db=getDB\(\),beijingDate=dateParts\(todayKey\(\)\)/.test(j),
    'monthTitle 必须是 render 里由 beijingDate（todayKey/dateParts，北京时区）现算的纯视图字段'))

  return out
}

module.exports = { studentsContract, statsContract, ruleBodies, declRpx, paddingRpx, paddingBottomRpx, stripCss, stripHtml, stripJs, tagOf }
