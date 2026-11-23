// @vitest-environment jsdom
// 登录页的分支补齐：错误码映射（detail 优先）、重复提交守卫、
// 认证服务不可用 → 重试、none/gateway 模式入口、语言切换与网关跳转。
import { h } from 'vue'
import { vi } from 'vitest'

// 会话层换桩：reactive 的 authState 由 mock 模块自己造（vi.hoisted 里拿不到 vue），
// 用例直接从被 mock 的模块导入同一份实例。
vi.mock('@/features/auth/session', async () => {
  const { reactive } = await import('vue')
  const authState = reactive({ mode: 'unknown', initialized: true, user: null, statusLoaded: false })
  return {
    authState,
    ensureStatus: vi.fn(),
    signIn: vi.fn()
  }
})

// 脚本侧文案（mapLoginError 用 $t）；模板侧文案走 mount helper 的真词条
vi.mock('@/app/i18n/i18n.js', () => ({
  $t: key => key,
  isGlobalZh: true,
  locale: 'zh'
}))

vi.mock('@/shared/lib/language', () => ({
  isChineseLanguage: vi.fn(() => true),
  switchLanguage: vi.fn()
}))

const { messageMock } = vi.hoisted(() => ({ messageMock: { success: vi.fn() } }))
vi.mock('@/shared/lib/message', () => ({ default: messageMock }))

import { expectNoI18nMisses, flush, mountWithPlugins } from './helpers/mount'
import LoginPage from '@/pages/login/LoginPage.vue'
import appState, { updateAppState } from '@/app/state'
import { safeRedirect } from '@/features/auth/guard'
import { authState, ensureStatus, signIn } from '@/features/auth/session'
import zhAuth from '@/app/i18n/zh/auth'

const zhLogin = zhAuth.login

const REMEMBER_KEY = 'rag-studio-remembered-account'

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/login', name: 'login', component: Blank },
  { path: '/knowledge', name: 'knowledge', component: Blank },
  { path: '/chat', name: 'chat', component: Blank },
  { path: '/change-password', name: 'changePassword', component: Blank }
]

// el-popover 没有注册 popper：用透明占位件同时渲染 reference 与默认插槽
const POPOVER_STUB = {
  name: 'ElPopover',
  props: ['visible', 'placement', 'trigger', 'width', 'offset', 'popperClass'],
  emits: ['update:visible'],
  setup (_props, { slots }) {
    return () => h('div', [slots.reference?.(), slots.default?.()])
  }
}

async function mountLogin (route = '/login', overrides = {}) {
  Object.assign(authState, { mode: 'unknown', initialized: true, user: null, statusLoaded: false }, overrides.state || {})
  ensureStatus.mockReset()
  if (overrides.ensureStatus) {
    ensureStatus.mockImplementation(overrides.ensureStatus)
  } else {
    ensureStatus.mockImplementation(async () => {
      authState.statusLoaded = true
      return authState
    })
  }
  signIn.mockReset()
  const wrapper = await mountWithPlugins(LoginPage, {
    route,
    routes: ROUTES,
    attachTo: document.body,
    global: { components: { ElPopover: POPOVER_STUB } }
  })
  await flush()
  return wrapper
}

async function submitForm (wrapper) {
  await wrapper.find('form.login-form').trigger('submit')
  await flush()
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('language-option', JSON.stringify('zh-CN'))
  messageMock.success.mockClear()
  appState.loginUrl = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('mapLoginError：错误码 → 提示（detail 优先）', () => {
  const CASES = [
    ['invalid_credentials', '密码错误详情', '#login-password-error', '密码错误详情'],
    ['invalid_credentials', '', '#login-password-error', 'modules.auth.login.invalidCredentials'],
    ['account_disabled', '', '.login-form-error', 'modules.auth.login.accountDisabled'],
    ['login_rate_limited', '', '.login-form-error', 'modules.auth.login.rateLimited'],
    ['rate_limited', '', '.login-form-error', 'modules.auth.login.rateLimited'],
    ['auth_not_initialized', '', '.login-form-error', 'modules.auth.login.serviceUnavailable'],
    ['service_unavailable', '', '.login-form-error', 'modules.auth.login.serviceUnavailable'],
    ['auth_not_enabled', '', '.login-form-error', 'modules.auth.login.notEnabled'],
    ['unknown_code', '', '.login-form-error', 'public.networkError'],
    ['unknown_code', '网关 502', '.login-form-error', '网关 502']
  ]

  it.each(CASES)('%s（detail=%s）→ %s 显示 %s', async (code, detail, selector, expected) => {
    const wrapper = await mountLogin('/login', { state: { mode: 'local', initialized: true } })
    signIn.mockRejectedValue({ code, detail })
    await wrapper.find('#login-account').setValue('alice')
    await wrapper.find('#login-password').setValue('secret123')
    await submitForm(wrapper)

    expect(wrapper.find(selector).text()).toBe(expected)
    expect(wrapper.router.currentRoute.value.name).toBe('login')
  })

  it('密码错误时聚焦密码框（focus 走到 focusField）', async () => {
    const wrapper = await mountLogin('/login', { state: { mode: 'local', initialized: true } })
    const focusSpy = vi.fn()
    wrapper.find('#login-password').element.focus = focusSpy
    signIn.mockRejectedValue({ code: 'invalid_credentials' })
    await wrapper.find('#login-account').setValue('alice')
    await wrapper.find('#login-password').setValue('secret123')
    await submitForm(wrapper)
    expect(focusSpy).toHaveBeenCalled()
  })
})

describe('submitLogin：守卫与成功路径', () => {
  it('表单未启用（未初始化）时提交直接返回，不发请求', async () => {
    const wrapper = await mountLogin('/login', { state: { mode: 'local', initialized: false } })
    await wrapper.find('#login-account').setValue('alice')
    await wrapper.find('#login-password').setValue('secret123')
    await submitForm(wrapper)
    expect(signIn).not.toHaveBeenCalled()
    expect(wrapper.find('.login-mode-note').exists()).toBe(true)
  })

  it('submitting 期间重复提交被忽略', async () => {
    const wrapper = await mountLogin('/login', { state: { mode: 'local', initialized: true } })
    let resolveSignIn
    signIn.mockReturnValue(new Promise(resolve => {
      resolveSignIn = resolve
    }))
    await wrapper.find('#login-account').setValue('alice')
    await wrapper.find('#login-password').setValue('secret123')
    const form = wrapper.find('form.login-form')
    await form.trigger('submit')
    await form.trigger('submit') // 上一次还没落地
    resolveSignIn({ username: 'alice' })
    await flush()

    expect(signIn).toHaveBeenCalledTimes(1)
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge')
  })

  it('mustChangePassword + redirect：带 redirect 去改密页', async () => {
    const wrapper = await mountLogin('/login?redirect=%2Fchat', { state: { mode: 'local', initialized: true } })
    signIn.mockResolvedValue({ username: 'a', mustChangePassword: true })
    await wrapper.find('#login-account').setValue('a')
    await wrapper.find('#login-password').setValue('p')
    await submitForm(wrapper)
    expect(wrapper.router.currentRoute.value.name).toBe('changePassword')
    expect(wrapper.router.currentRoute.value.query.redirect).toBe('/chat')
  })

  it('登录成功后 message.success 走 shared/lib/message', async () => {
    const wrapper = await mountLogin('/login', { state: { mode: 'local', initialized: true } })
    signIn.mockResolvedValue({ username: 'a', mustChangePassword: false })
    await wrapper.find('#login-account').setValue('a')
    await wrapper.find('#login-password').setValue('p')
    await submitForm(wrapper)
    expect(messageMock.success).toHaveBeenCalledWith('modules.auth.login.success')
  })

  it('取消记住账号：登录后从 localStorage 删除', async () => {
    localStorage.setItem(REMEMBER_KEY, 'bob')
    const wrapper = await mountLogin('/login', { state: { mode: 'local', initialized: true } })
    signIn.mockResolvedValue({ username: 'bob', mustChangePassword: false })
    await wrapper.find('#login-account').setValue('bob')
    await wrapper.find('#login-password').setValue('p')
    // rememberAccount 初始为 true（savedAccount 存在），取消勾选
    await wrapper.find('.remember-account input').setValue(false)
    await submitForm(wrapper)
    expect(localStorage.getItem(REMEMBER_KEY)).toBeNull()
  })
})

describe('认证服务不可用 → 重试', () => {
  it('ensureStatus 失败：显示不可用卡片与重试按钮；重试成功后回到表单', async () => {
    const wrapper = await mountLogin('/login', { state: { mode: 'local', initialized: true } })
    expect(wrapper.find('.login-unavailable').exists()).toBe(false)

    // 第二次挂载：探针失败 → 不可用态
    const failed = await mountLogin('/login', {
      state: { mode: 'local', initialized: true },
      ensureStatus: () => Promise.reject(new Error('down'))
    })
    expect(failed.find('.login-unavailable').exists()).toBe(true)
    expect(failed.find('.login-form').exists()).toBe(false)

    // 重试：强制重新探针，成功后恢复表单
    ensureStatus.mockImplementation(async () => {
      authState.statusLoaded = true
      return authState
    })
    await failed.find('.login-demo-button').trigger('click')
    await flush()
    expect(ensureStatus).toHaveBeenCalledWith({ force: true })
    expect(failed.find('.login-unavailable').exists()).toBe(false)
    expect(wrapper).toBeTruthy()
    expectNoI18nMisses(failed)
  })
})

describe('none / gateway 模式入口', () => {
  it('none 模式：显示未启用提示与「进入工作台」；点击进入 /knowledge', async () => {
    const wrapper = await mountLogin('/login', { state: { mode: 'none' } })
    expect(wrapper.find('.login-mode-note').text()).toBe(zhLogin.notEnabled)
    expect(wrapper.find('.login-demo-note').exists()).toBe(true)

    await wrapper.find('.login-demo-button').trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge')
  })

  it('gateway 模式：有 loginUrl 时给「去统一身份认证」入口', async () => {
    appState.loginUrl = 'https://uac.example.com'
    expect(appState.loginUrl).toBe('https://uac.example.com')
    const wrapper = await mountLogin('/login', { state: { mode: 'gateway', initialized: true } })
    expect(wrapper.text()).toContain(zhLogin.gatewayNotice)

    const buttons = wrapper.findAll('.login-demo-button')
    // goGateway 需要 loginUrl：这里替换 window.location 捕获 assign
    const assign = vi.fn()
    const originalLocation = window.location
    try {
      delete window.location
      window.location = { assign }
      await buttons[buttons.length - 1].trigger('click')
      expect(assign).toHaveBeenCalledWith('https://uac.example.com')
    } finally {
      window.location = originalLocation
    }
  })

  it('gateway 模式没有 loginUrl：不渲染跳转入口（按钮守卫分支）', async () => {
    const wrapper = await mountLogin('/login', { state: { mode: 'gateway', initialized: true } })
    expect(wrapper.text()).not.toContain(zhLogin.goGateway)
  })
})

describe('帮助弹窗（联系管理员）', () => {
  /** StudioDialog 之外的普通 el-dialog：透传默认插槽与 footer，才能点里面的按钮。 */
  const DIALOG_PASSTHROUGH = {
    name: 'ElDialog',
    props: ['modelValue', 'title', 'width', 'alignCenter'],
    setup (props, { slots }) {
      return () => (props.modelValue
        ? h('div', { class: 'help-dialog-pass' }, [
            slots.default ? slots.default() : null,
            slots.footer ? slots.footer() : null
          ])
        : null)
    }
  }

  async function mountWithHelpDialog (state) {
    await mountLogin('/login', { state })
    Object.assign(authState, { mode: 'unknown', initialized: true, user: null, statusLoaded: false }, state || {})
    ensureStatus.mockReset().mockImplementation(async () => {
      authState.statusLoaded = true
      return authState
    })
    const wrapper2 = await mountWithPlugins(LoginPage, {
      route: '/login',
      routes: ROUTES,
      global: { components: { ElDialog: DIALOG_PASSTHROUGH, ElPopover: POPOVER_STUB } }
    })
    await flush()
    return wrapper2
  }

  it('忘记密码 / 联系管理员：打开帮助弹窗；none 模式弹窗里给「进入工作台」', async () => {
    const wrapper = await mountWithHelpDialog({ mode: 'none', initialized: true })
    expect(wrapper.find('.help-dialog-pass').exists()).toBe(false)

    await wrapper.findAll('.login-text-button')[0].trigger('click')
    await flush()
    expect(wrapper.find('.help-dialog-pass').exists()).toBe(true)

    // none 模式：footer 有「确认」+「进入工作台」两个按钮
    const buttons = wrapper.findAll('.help-dialog-pass button')
    expect(buttons.map(node => node.text().trim())).toEqual(['确定', '免登录体验'])
    await buttons[1].trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge')

    // 确认按钮关闭弹窗
    const wrapper3 = await mountWithHelpDialog({ mode: 'local', initialized: true })
    await wrapper3.findAll('.login-text-button')[0].trigger('click')
    await flush()
    const buttons3 = wrapper3.findAll('.help-dialog-pass button')
    await buttons3[0].trigger('click')
    await flush()
    expect(wrapper3.find('.help-dialog-pass').exists()).toBe(false)
  })
})

describe('语言切换', () => {
  it('点语言选项：switchLanguage 收到目标语言并收起弹层', async () => {
    const { switchLanguage } = await import('@/shared/lib/language')
    const wrapper = await mountLogin('/login', { state: { mode: 'local', initialized: true } })
    const options = wrapper.findAll('.login-language-option')
    expect(options).toHaveLength(2)
    await options[1].trigger('click')
    expect(switchLanguage).toHaveBeenCalledWith('en-US')
  })
})

describe('safeRedirect（登录回跳地址的白名单）', () => {
  it('只放行站内绝对路径；登录/改密页与外链一律拒绝', () => {
    expect(safeRedirect('/chat')).toBe('/chat')
    expect(safeRedirect('/chat?tab=1#x')).toBe('/chat?tab=1#x')
    expect(safeRedirect('//evil.com')).toBeNull()
    expect(safeRedirect('http://evil.com')).toBeNull()
    expect(safeRedirect('/login')).toBeNull()
    expect(safeRedirect('/login/xxx')).toBeNull()
    expect(safeRedirect('/change-password')).toBeNull()
    expect(safeRedirect(123)).toBeNull()
    expect(safeRedirect(null)).toBeNull()
  })
})
