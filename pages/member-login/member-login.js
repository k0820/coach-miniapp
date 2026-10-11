const directory = require('../../utils/member-directory')
const theme = require('../../utils/member-theme')

// ⭐⭐ 新方案会员身份入口：手机号登录。
//   ⛔ 会员用微信官方手机号按钮 → 云端换取「可信手机号」 → 按手机号精确匹配唯一会员 → 登录本机。
//   ⛔ 找不到只说「没有找到你的会员资料」（让教练先录入手机号），绝不创建第二份、绝不假装成功。
//   ⛔ 微信「获取手机号」能力没开通时，resolvePhoneCode 如实报缺口，并开放手动输入兜底。
Page({
  data: {
    themeStyle: theme.cssVars(),
    available: false,
    busy: false,
    phone: '',
    note: '',
    fallback: false
  },
  onLoad() {
    const available = directory.available()
    this.setData({ available })
    if (!available) this.setData({ note: directory.SANDBOX_ONLY_NOTE || '该功能尚在安全测试中' })
  },
  // ⛔ 微信官方手机号按钮：拿到的只是可信凭证 code，再交云端换真实手机号（绝不手填冒充）。
  // ⭐ 真机血案（2026-10-10 1.3.53）：个人主体小程序根本拿不到授权 code（平台不弹窗），
  //    原代码只在「云端换取失败」时开放手动输入兜底 ⇒ 用户被卡死在登录页。
  //    修复：凡是按钮没拿到 code（拒绝/平台不支持/异常），一律同时开放手动输入兜底。
  async onPhone(e) {
    const detail = (e && e.detail) || {}
    if (!detail.code) {
      if (detail.errMsg && detail.errMsg.indexOf('deny') >= 0) {
        return this.setData({ note: '你拒绝了手机号授权，可改用下方手动输入登录。', fallback: true })
      }
      return this.setData({ note: '这台手机暂时拿不到微信手机号授权，请用下方手动输入登录。', fallback: true })
    }
    this.setData({ busy: true, note: '' })
    try {
      const resolved = await directory.resolvePhoneCode(detail.code)
      if (!resolved || !resolved.ok) {
        // ⛔ 拿不到可信手机号（能力未开通等）⇒ 如实报缺口，并开放手动输入兜底。
        this.setData({ fallback: true, note: (resolved && resolved.message) || directory.TEXTS.PHONE_API_UNAVAILABLE })
        return
      }
      await this.doLogin(resolved.phone)
    } catch (error) {
      this.setData({ note: '网络没连上，请稍后再试一次。' })
    } finally {
      this.setData({ busy: false })
    }
  },
  onPhoneInput(e) {
    this.setData({ phone: String((e && e.detail && e.detail.value) || '').trim() })
  },
  async onManualLogin() {
    const phone = this.data.phone.trim()
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确的手机号', icon: 'none' })
    this.setData({ busy: true, note: '' })
    try {
      await this.doLogin(phone)
    } catch (error) {
      this.setData({ note: '网络没连上，请稍后再试一次。' })
    } finally {
      this.setData({ busy: false })
    }
  },
  async doLogin(phone) {
    const r = await directory.loginByPhone(phone)
    // ⛔ 只认服务端确认的唯一会员；找不到如实说「没找到」，绝不创建第二份、绝不假装成功。
    if (!r || !r.ok) return this.setData({ note: (r && r.message) || directory.TEXTS.PHONE_NOT_FOUND })
    wx.showToast({ title: '登录成功', icon: 'none' })
    setTimeout(() => wx.redirectTo({ url: '/pages/member-home/member-home' }), 500)
  }
})
