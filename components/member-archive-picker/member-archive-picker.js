// 「当前使用档案」选择器（2026-10-03 新增）
//
// ⭐ 为什么单独做成组件：用户需求 A.2 要求"在会员端提供清晰的当前使用档案选择器"，
//    而首页、我的、课时页、约课页、我的预约、训练记录**每一处都要能看到当前用的是哪一份**。
//    ⇒ 绝不能每页各写一遍（一定会出现"这页写 A、那页写 B"的不一致）。
//
// ⛔ 四条纪律（判据在 tests/member-archive-switch.test.js 与 tests/member-archive-ui.test.js）：
//   ① 多档案且用户没选过 ⇒ **必须显示"请选择当前使用档案"** 并打开选择层，
//      ⛔ 绝不悄悄替他选第一份/最新一份（猜错 = 整屏数据都错，而且用户看不出来）。
//   ② 单档案可以自动选中，但**照样要显示**"当前使用：某某"（否则用户不知道自己看的是哪份）。
//   ③ ⭐ 2026-10-05：归档功能已整体撤回 ⇒ 档案上不再有「已结束服务」这个状态，
//      认领了哪几份就展示哪几份，全部可选、一个都不隐藏。
//   ④ 本组件**只发事件、不自己改数据**：真正的写入走 `member-archive-state.switchTo`，
//      由页面统一调用（清可约时段缓存 + 重新读云端），组件无权决定。
Component({
  options: { multipleSlots: true },
  properties: {
    archives: { type: Array, value: [] },
    currentId: { type: String, value: '' },
    // 'none' | 'single' | 'chosen' | 'need-choice'（由 member-archive-state.decide 给出）
    mode: { type: String, value: 'none' },
    autoSelected: { type: Boolean, value: false },
    themeStyle: { type: String, value: '' }
  },
  data: { open: false, currentName: '', currentCoach: '' },
  observers: {
    // ⛔ WXML 里不能写表达式取"当前档案的名字/教练" ⇒ 在这里算好再给模板用。
    //   ⛔ 认不出（archives 为空或 id 对不上）时**一律显示空**，绝不回退到"第一份"的名字 ——
    //   那会让用户以为看到的是自己选的那份。
    'archives, currentId': function (archives, currentId) {
      const list = Array.isArray(archives) ? archives : []
      const hit = list.filter(row => row && String(row.archiveId || '') === String(currentId || ''))[0] || null
      this.setData({
        currentName: hit ? String(hit.name || '') : '',
        currentCoach: hit ? String(hit.coachName || '') : ''
      })
    }
  },
  methods: {
    openPicker() { this.setData({ open: true }); this.triggerEvent('open') },
    closePicker() { this.setData({ open: false }); this.triggerEvent('close') },
    noop() {},
    pick(e) {
      const archiveId = String((e.currentTarget && e.currentTarget.dataset.id) || '')
      if (!archiveId) return
      this.setData({ open: false })
      // ⛔ 只把意图抛出去，页面负责真正切换（清缓存 + 重读）。
      this.triggerEvent('change', { archiveId })
    }
  }
})
