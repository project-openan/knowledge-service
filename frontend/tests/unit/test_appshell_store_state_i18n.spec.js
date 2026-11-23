// @vitest-environment jsdom
// app 壳层的全局单例三件套（覆盖率接近 0%）：
//   - store/index.js：根 state / 四个 mutation / 空 getters / kbase 模块 /
//     workflow 旧写入路径兼容桥（state.ragWorkflowType 读写转发到 reactive 单例）
//   - app/state.js：appState 默认值、非法 JSON 兜底、updateAppState 部分覆盖
//   - app/i18n/i18n.js：语言加载器分支（localStorage 原始值 / 对象值 / 对象缺
//     substring / 浏览器语言兜底），每个分支用 vi.resetModules + 动态 import 重载
import { describe, expect, it, vi } from 'vitest'

import storeConfig, { store } from '@/app/store'
import { workflowState } from '@/features/workflow/store'

describe('store/index（根 store）', () => {
  it('根 state 只有全局状态，workflow 专属状态经兼容桥转发到 reactive 单例', () => {
    expect(store.state.kb.currentName).toBe('')
    expect(store.state.authority.isSuperAdmin).toBe(false)
    expect(store.state.showAsideMenu).toBe(true)
    expect(store.state.showDetailLeft).toBe(true)
    expect(store.state.appName).toBe('')
    expect(store.state.simple.userGuideVariables).toEqual({})
    expect(store.state.ragWorkflowIsStructKnowledge).toBe(false)

    // 兼容桥：根 state 上没有这份字段的副本，读写都落在 workflowState
    store.state.ragWorkflowType = 'SequentialQueryEngine'
    expect(workflowState.ragWorkflowType).toBe('SequentialQueryEngine')
    workflowState.ragWorkflowType = ''
    expect(store.state.ragWorkflowType).toBe('')
    // 可枚举：历史代码里 `$store.state.ragWorkflowType` 的读法仍然成立
    expect(Object.keys(store.state)).toContain('ragWorkflowType')
  })

  it('四个 mutation 各改各的字段', () => {
    store.commit('updateCurrentName', 'kb-a')
    expect(store.state.kb.currentName).toBe('kb-a')
    store.commit('updateShowAsideMenu', false)
    expect(store.state.showAsideMenu).toBe(false)
    store.commit('updateShowAsideMenu', true)
    store.commit('updateDetailLeft', false)
    expect(store.state.showDetailLeft).toBe(false)
    store.commit('updateDetailLeft', true)
    store.commit('updateAppLatestSaveDate', '2026-01-01 00:00:00')
    expect(store.state.appLatestSaveDate).toBe('2026-01-01 00:00:00')
  })

  it('getters 为空（页面状态都在 feature 本地），kbase 模块已注册', () => {
    expect(storeConfig.getters).toEqual({})
    expect(storeConfig.actions).toEqual({})
    expect(store.hasModule('kbase')).toBe(true)
  })
})

describe('app/state（全局 appState 单例）', () => {
  it('默认导出：身份头缺省为空串，语言走浏览器兜底', async () => {
    vi.resetModules()
    localStorage.removeItem('language-option')
    const appState = (await import('@/app/state')).default

    expect(appState.tenantId).toBe('')
    expect(appState.user.userName).toBe('')
    expect(appState.user.authValue).toBe('')
    expect(typeof appState.langId).toBe('string')
    expect(appState.langId.length).toBeGreaterThan(0)
    // 环境变量原样透传
    expect(appState.system).toBe(process.env.VUE_APP_SYSTEM)
    expect(appState.loginUrl).toBe(process.env.VUE_APP_UAC)
  })

  it('localStorage 存了非法 JSON 时按没设过处理（try/catch 兜底）', async () => {
    vi.resetModules()
    // 手工写成裸 `en`（非法 JSON），与应用其余读法一致地忽略
    localStorage.setItem('language-option', 'en')
    const appState = (await import('@/app/state')).default
    expect(appState.langId).not.toBeNull()
  })

  it('updateAppState 只覆盖传入的字段', async () => {
    vi.resetModules()
    const mod = await import('@/app/state')
    const appState = mod.default

    mod.updateAppState({ langId: 'en-US', tenantId: 't-1' })
    expect(appState.langId).toBe('en-US')
    expect(appState.tenantId).toBe('t-1')
    expect(appState.user.userName).toBe('')

    mod.updateAppState({ user: { userName: 'op', personName: '运维' } })
    expect(appState.user.userName).toBe('op')
    expect(appState.user.personName).toBe('运维')
    // user 是整对象替换，未传的字段跟着走
    expect(appState.user.avatar).toBeUndefined()

    mod.updateAppState({})
    expect(appState.langId).toBe('en-US')
  })
})

describe('app/i18n/i18n.js 语言加载器分支', () => {
  it('localStorage 原始字符串优先，zh 开头 → isGlobalZh', async () => {
    localStorage.setItem('language-option', JSON.stringify('zh-CN'))
    vi.resetModules()
    const mod = await import('@/app/i18n/i18n.js')

    expect(mod.locale).toBe('zh-CN')
    expect(mod.isGlobalZh).toBe(true)
    expect(mod.default.global.locale.value).toBe('zh')
    // 同一模块导出的 $t/translate 走同一份实例
    expect(mod.$t).toBe(mod.translate)
  })

  it('存的是对象（qiankun 老写入形状）→ 模块在 createI18n 处先炸（现状行为钉子）', async () => {
    // i18n.js 第 9 行无条件调 `locale.substring(0,2)`，早于后面的 isObject(locale)
    // 防御分支 —— 所以「对象形状」的两个 regString 分支在现行加载路径下不可达
    // （模块加载即抛 TypeError）。钉住这个现状：哪天有人动加载器，这条会红，
    // 提醒要么修掉这行、要么补上对象形状的真实分支。
    localStorage.setItem('language-option', JSON.stringify({ value: 'zh-CN' }))
    vi.resetModules()
    await expect(import('@/app/i18n/i18n.js')).rejects.toThrow(TypeError)
  })

  it('没存过且浏览器是英文 → en；navigator.language 缺失时逐级兜底到 zh-CN', async () => {
    localStorage.removeItem('language-option')
    vi.resetModules()
    const mod = await import('@/app/i18n/i18n.js')
    expect(mod.isGlobalZh).toBe(false)

    // jsdom 的 navigator.language 是原型 getter，实例上覆盖后模块读不到
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language')
    Object.defineProperty(window.navigator, 'language', { get: () => undefined, configurable: true })
    try {
      vi.resetModules()
      const fallback = await import('@/app/i18n/i18n.js')
      expect(fallback.locale).toBe('zh-CN')
      expect(fallback.isGlobalZh).toBe(true)
      expect(fallback.default.global.locale.value).toBe('zh')
    } finally {
      delete window.navigator.language
      if (original) Object.defineProperty(Navigator.prototype, 'language', original)
    }
  })

  it('默认导出就是 createI18n 实例，translate 译文可取到', async () => {
    localStorage.setItem('language-option', JSON.stringify('zh-CN'))
    vi.resetModules()
    const mod = await import('@/app/i18n/i18n.js')
    expect(typeof mod.default.global.t).toBe('function')
    expect(mod.$t('modules.chatTest.workflowNotPublished')).toBe(
      '所选知识检索还没有已发布的版本，请先在画布上保存并发布。'
    )
  })
})
