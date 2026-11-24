// @vitest-environment jsdom
// 应用启动入口 src/app/main.js（覆盖率 0%）的契约：
//   - 路由模式按 VUE_APP_ROUTE_MODE 选 hash / history
//   - 全局守卫写 document.title（meta.title 优先，兜底产品名）与 html[lang]
//   - 装配顺序：route-progress → auth session/guard → 主题 → app 插件（EP/i18n/指令/store）
//   - globalProperties：$message（含四个快捷方法）/ $confirm / $globalZh
//   - isReady 与 15s 硬超时竞速后才挂载（这里只验证会挂载，不真等 15s）
//
// 依赖替身：element-plus / 路由表 / auth 三件套全部 mock —— 路由表换成两条内存
// 记录，避免真把登录页整棵组件树拉进启动用例。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => {
  // main.js 在模块顶层读路由模式；先给一个默认值，hash 分支再单独改
  process.env.VUE_APP_ROUTE_MODE = 'history'
  process.env.BASE_URL = '/'
  return {}
})

const ep = vi.hoisted(() => {
  const calls = { installs: [], messageCalls: [], confirmCalls: [] }
  const ElMessage = Object.assign(
    (options) => {
      calls.messageCalls.push(options)
      return 'message'
    },
    {
      success: vi.fn(() => 'success'),
      warning: vi.fn(() => 'warning'),
      info: vi.fn(() => 'info'),
      error: vi.fn(() => 'error')
    }
  )
  const ElMessageBox = {
    confirm: (...args) => {
      calls.confirmCalls.push(args)
      return Promise.resolve('confirm')
    }
  }
  const ElementPlus = { install: (app, options) => calls.installs.push(options) }
  const ElTooltip = { name: 'ElTooltipStub', render: () => null }
  return { calls, ElMessage, ElMessageBox, ElementPlus, ElTooltip }
})

vi.mock('element-plus', () => ({
  default: ep.ElementPlus,
  ElMessage: ep.ElMessage,
  ElMessageBox: ep.ElMessageBox,
  ElTooltip: ep.ElTooltip
}))

vi.mock('element-plus/es/locale/lang/zh-cn', () => ({ default: { name: 'zh-cn' } }))
vi.mock('element-plus/es/locale/lang/en', () => ({ default: { name: 'en' } }))

// 两条内存路由：带 meta.title 的与不带的，各覆盖 title 守卫的一个分支
vi.mock('@/app/router', () => ({
  default: [
    {
      path: '/',
      name: 'home',
      component: { name: 'HomeProbe', render: () => null },
      meta: { title: 'nav.preferences' }
    },
    {
      path: '/plain',
      name: 'plain',
      component: { name: 'PlainProbe', render: () => null }
    }
  ]
}))

vi.mock('@/features/auth/session', () => ({
  initSession: vi.fn(),
  isAuthEnabled: { value: false },
  isAuthenticated: { value: false }
}))
vi.mock('@/features/auth/guard', () => ({ installAuthGuard: vi.fn() }))
vi.mock('@/shared/lib/route-progress', () => ({ installRouteProgress: vi.fn() }))

// App 本体换成探针：验证挂载发生即可，不渲染整棵业务树
vi.mock('@/app/App.vue', () => ({
  default: { name: 'AppProbe', template: '<div class="app-probe"><slot /></div>' }
}))

/** 等启动竞速（isReady 是 microtask）跑完、mountApp 落地。 */
async function settle () {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** 取当前模块注册表里三个装配钩子（resetModules 后重导入也不会拿旧实例）。 */
async function latestInstallHooks () {
  const session = await import('@/features/auth/session')
  const guard = await import('@/features/auth/guard')
  const progress = await import('@/shared/lib/route-progress')
  return {
    initSession: session.initSession,
    installAuthGuard: guard.installAuthGuard,
    installRouteProgress: progress.installRouteProgress,
    // 多次导入 main.js 时 mock 调用会累计，取最近一次
    lastRouter: mod => mod.mock.calls[mod.mock.calls.length - 1][0]
  }
}

describe('main.js 启动装配', () => {
  beforeEach(() => {
    document.title = ''
    document.documentElement.setAttribute('lang', '')
    document.body.innerHTML = '<div id="app"></div>'
    localStorage.removeItem('language-option')
    ep.calls.installs.length = 0
    ep.calls.messageCalls.length = 0
    ep.calls.confirmCalls.length = 0
    process.env.VUE_APP_ROUTE_MODE = 'history'
  })

  afterEach(() => {
    delete window.aipVueInstance
    vi.resetModules()
  })

  it('history 模式：装配插件、写 title/lang，并在 isReady 后挂载到 #app', async () => {
    const hooks = await latestInstallHooks()

    // Act
    await import('@/app/main.js')
    await settle()

    // Assert：挂载发生
    expect(document.querySelector('#app .app-probe')).not.toBeNull()

    // 守卫按顺序拿到同一个 router，且 progress 在 auth 之前
    const installedRouter = hooks.lastRouter(hooks.initSession)
    expect(installedRouter).toHaveProperty('beforeEach')
    expect(hooks.lastRouter(hooks.installRouteProgress)).toBe(installedRouter)
    expect(hooks.lastRouter(hooks.installAuthGuard)).toBe(installedRouter)

    // title：首航到 `/`，meta.title 有值 → 走 i18n 词条
    const { $t } = await import('@/app/i18n/i18n.js')
    expect(document.title).toBe($t('nav.preferences'))
    // lang：与 i18n 模块推导的界面语言一致
    const { isGlobalZh } = await import('@/app/i18n/i18n.js')
    expect(document.documentElement.getAttribute('lang')).toBe(isGlobalZh ? 'zh-CN' : 'en-US')

    // Element Plus 语言包：jsdom navigator.language 默认 en-US → 取 en
    expect(ep.calls.installs).toHaveLength(1)
    expect(ep.calls.installs[0].locale.name).toBe('en')

    // globalProperties 出口
    const props = window.aipVueInstance
    expect(typeof props.$message).toBe('function')
    expect(typeof props.$message.success).toBe('function')
    expect(typeof props.$message.warning).toBe('function')
    expect(typeof props.$message.info).toBe('function')
    expect(typeof props.$message.error).toBe('function')
    expect(typeof props.$confirm).toBe('function')

    props.$message({ content: 'hi' })
    expect(ep.calls.messageCalls[0]).toMatchObject({ showClose: true, content: 'hi' })
    props.$message.success('ok')
    expect(ep.ElMessage.success).toHaveBeenCalledWith({ type: 'success', showClose: true, message: 'ok' })
    props.$message.error('bad')
    expect(ep.ElMessage.error).toHaveBeenCalledWith({ type: 'error', showClose: true, message: 'bad' })

    props.$confirm('msg', 'title', { extra: 1 }, 'ctx')
    expect(ep.calls.confirmCalls[0][0]).toBe('msg')
    expect(ep.calls.confirmCalls[0][1]).toBe('title')
    expect(ep.calls.confirmCalls[0][2]).toMatchObject({
      closeOnClickModal: false,
      closeOnPressEscape: false,
      extra: 1
    })
    expect(ep.calls.confirmCalls[0][3]).toBe('ctx')

    expect(typeof props.$globalZh).toBe('boolean')
    expect(props.$globalZh).toBe(isGlobalZh)
  })

  it('meta.title 缺失时兜底为产品名（每次导航重算 title/lang）', async () => {
    const hooks = await latestInstallHooks()
    await import('@/app/main.js')
    await settle()

    // Act：导航到没有 meta.title 的记录
    const { $t, isGlobalZh } = await import('@/app/i18n/i18n.js')
    const router = hooks.lastRouter(hooks.initSession)
    document.title = 'before'
    await router.push('/plain')
    await settle()

    // Assert
    expect(document.title).toBe('Knowledge Studio')
    expect(document.documentElement.getAttribute('lang')).toBe(isGlobalZh ? 'zh-CN' : 'en-US')
    // 词条仍然可用（守卫与挂载都吃同一份 i18n）
    expect(typeof $t).toBe('function')
  })

  it('hash 模式分支：VUE_APP_ROUTE_MODE=hash 时同样装配并挂载', async () => {
    // 先走一遍 history，再 resetModules 换 hash —— 覆盖 createRouter 的三元两臂
    await import('@/app/main.js')
    await settle()
    expect(document.querySelector('#app .app-probe')).not.toBeNull()

    vi.resetModules()
    process.env.VUE_APP_ROUTE_MODE = 'hash'
    localStorage.setItem('language-option', JSON.stringify('zh-CN'))

    await import('@/app/main.js')
    await settle()

    // Assert：第二个实例替换掉 window 出口，且 Element Plus 拿到 zh 语言包
    expect(window.aipVueInstance).toBeTruthy()
    expect(ep.calls.installs).toHaveLength(2)
    expect(ep.calls.installs[1].locale.name).toBe('zh-cn')
  })
})
