// @vitest-environment jsdom
// 认证域补齐：api.js 的动词、session 的并发缓存/改密分支、guard 的 mustChange 兜底、
// UserMenu（退出入口）、ChangePasswordForm 的错误码映射、ChangePasswordPage 的回跳。
// 只 mock axios 客户端，session/guard/组件全部走真实现（与 changePassword.spec 同法）。
import { vi } from 'vitest'

// i18n.js 在导入期读 localStorage：先把语言钉成中文（与 Login.spec 同法）
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { client } = vi.hoisted(() => ({
  client: {
    get: vi.fn(() => Promise.resolve({})),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve({}))
  }
}))

vi.mock('@/shared/api/client', () => ({ default: client }))

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { flush, mountWithPlugins } from './helpers/mount'

import {
  changePassword as apiChangePassword,
  fetchAuthStatus,
  fetchMe,
  login,
  logout
} from '@/features/auth/api'
import {
  authState,
  changePassword,
  ensureStatus,
  resetSessionState
} from '@/features/auth/session'
import { installAuthGuard, safeRedirect } from '@/features/auth/guard'
import UserMenu from '@/features/auth/components/UserMenu.vue'
import ChangePasswordForm from '@/features/auth/components/ChangePasswordForm.vue'
import ChangePasswordPage from '@/pages/login/ChangePasswordPage.vue'
import zhAuth from '@/app/i18n/zh/auth'

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/login', name: 'login', component: Blank },
  { path: '/knowledge', name: 'knowledge', component: Blank },
  { path: '/chat', name: 'chat', component: Blank },
  { path: '/change-password', name: 'changePassword', component: Blank }
]

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('language-option', JSON.stringify('zh-CN'))
  client.get.mockReset().mockResolvedValue({})
  client.post.mockReset().mockResolvedValue({})
  client.put.mockReset().mockResolvedValue({})
  client.delete.mockReset().mockResolvedValue({})
  resetSessionState()
})

afterEach(() => {
  resetSessionState()
  document.body.innerHTML = ''
})

describe('features/auth/api：动词与 skipErrorHandler', () => {
  it('status / login / logout / me / password 五个端点', async () => {
    await fetchAuthStatus()
    await login('alice', 'secret')
    await logout()
    await fetchMe()
    await apiChangePassword('old-pass', 'new-pass')

    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/auth/status'), expect.objectContaining({ skipErrorHandler: true }))
    expect(client.post).toHaveBeenCalledWith(expect.stringContaining('/auth/login'), { username: 'alice', password: 'secret' }, expect.objectContaining({ skipErrorHandler: true }))
    expect(client.post).toHaveBeenCalledWith(expect.stringContaining('/auth/logout'), null, expect.anything())
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), expect.anything())
    expect(client.post).toHaveBeenCalledWith(
      expect.stringContaining('/auth/password'),
      { currentPassword: 'old-pass', newPassword: 'new-pass' },
      expect.anything()
    )
  })
})

describe('features/auth/session：并发缓存与改密分支', () => {
  it('并发 ensureStatus 共享同一个在飞请求（不重复打 /auth/status）', async () => {
    let resolveProbe
    client.get.mockImplementation(() => new Promise(resolve => {
      resolveProbe = resolve
    }))
    const first = ensureStatus()
    const second = ensureStatus()
    resolveProbe({ mode: 'none' })
    await Promise.all([first, second])
    expect(client.get).toHaveBeenCalledTimes(1)
    expect(authState.statusLoaded).toBe(true)
  })

  it('changePassword：已登录时把 mustChangePassword 清掉；未登录只调接口不抛错', async () => {
    authState.user = { username: 'a', mustChangePassword: true }
    await changePassword('old', 'new')
    expect(client.post).toHaveBeenCalledWith(
      expect.stringContaining('/auth/password'),
      { currentPassword: 'old', newPassword: 'new' },
      expect.anything()
    )
    expect(authState.user.mustChangePassword).toBe(false)

    // 未登录（user 为 null）：改密成功但不碰用户对象
    authState.user = null
    await expect(changePassword('old', 'new')).resolves.toBeUndefined()
  })
})

describe('features/auth/guard：mustChange 无 redirect 的兜底', () => {
  function fakeRouter () {
    const guards = []
    return {
      guards,
      beforeEach: fn => guards.push(fn)
    }
  }

  async function runGuard (to) {
    const router = fakeRouter()
    installAuthGuard(router)
    expect(router.guards).toHaveLength(1)
    return router.guards[0](to)
  }

  it('已登录访问 /login 且必须改密、redirect 缺失/非法 → 裸改密页', async () => {
    client.get.mockResolvedValue({ mode: 'local', initialized: true, user: { username: 'a', mustChangePassword: true } })
    authState.mode = 'local'

    const noRedirect = await runGuard({ name: 'login', query: {}, fullPath: '/login' })
    expect(noRedirect).toEqual({ name: 'changePassword' })
    const badRedirect = await runGuard({ name: 'login', query: { redirect: '//evil' }, fullPath: '/login' })
    expect(badRedirect).toEqual({ name: 'changePassword' })

    // 对照：合法 redirect 时带上它
    const withRedirect = await runGuard({ name: 'login', query: { redirect: '/chat' }, fullPath: '/login' })
    expect(withRedirect).toEqual({ name: 'changePassword', query: { redirect: '/chat' } })

    authState.user = null
  })

  it('已登录的业务页 + mustChange：fullPath 合法带 target、非法回裸改密页', async () => {
    client.get.mockResolvedValue({ mode: 'local', initialized: true, user: { username: 'a', mustChangePassword: true } })
    authState.mode = 'local'

    const legal = await runGuard({ name: 'knowledge', fullPath: '/knowledge' })
    expect(legal).toEqual({ name: 'changePassword', query: { redirect: '/knowledge' } })
    const illegal = await runGuard({ name: 'knowledge', fullPath: '/login' })
    expect(illegal).toEqual({ name: 'changePassword' })

    authState.user = null
  })
})

describe('UserMenu：改密入口与退出', () => {
  const POPOVER_RENDER = {
    name: 'ElPopover',
    props: ['visible', 'placement', 'trigger', 'width', 'offset', 'popperClass'],
    emits: ['update:visible'],
    setup (_props, { slots }) {
      return () => [slots.reference?.(), slots.default?.()]
    }
  }

  async function mountMenu (user) {
    authState.user = user
    const wrapper = await mountWithPlugins(UserMenu, {
      route: '/knowledge',
      routes: ROUTES,
      global: { components: { ElPopover: POPOVER_RENDER } }
    })
    await flush()
    return wrapper
  }

  it('显示用户名与首字母，两个菜单项齐全', async () => {
    const wrapper = await mountMenu({ username: 'alice', displayName: 'Alice Z.' })
    expect(wrapper.find('.user-trigger').attributes('aria-label')).toBe('Alice Z.')
    expect(wrapper.find('.user-avatar').text()).toBe('A')
    expect(wrapper.findAll('.user-item')).toHaveLength(2)
  })

  it('没有 displayName 时回退账号名；无用户显示 ?', async () => {
    const fallback = await mountMenu({ username: 'bob', displayName: '' })
    expect(fallback.find('.user-trigger').attributes('aria-label')).toBe('bob')
    expect(fallback.find('.user-avatar').text()).toBe('B')

    const anonymous = await mountMenu(null)
    // aria-label 取 displayName（空）；头像里的首字母回落 '?'
    expect(anonymous.find('.user-trigger').attributes('aria-label')).toBe('')
    expect(anonymous.find('.user-avatar').text()).toBe('?')
  })

  it('logout：调登出接口、清用户并回登录页', async () => {
    const wrapper = await mountMenu({ username: 'bob' })
    await wrapper.findAll('.user-item')[1].trigger('click')
    await flush()
    expect(client.post).toHaveBeenCalledWith(expect.stringContaining('/logout'), null, expect.anything())
    expect(wrapper.router.currentRoute.value.name).toBe('login')
    expect(authState.user).toBeNull()
  })
})

describe('ChangePasswordForm：错误码映射（mapError 全分支）', () => {
  async function mountForm () {
    const wrapper = await mountWithPlugins(ChangePasswordForm, { route: '/', router: null })
    await flush()
    return wrapper
  }

  async function fillAndSubmit (wrapper, { current = 'old-pass', next = 'new-pass-123', confirm = 'new-pass-123' } = {}) {
    await wrapper.find('#cp-current').setValue(current)
    await wrapper.find('#cp-new').setValue(next)
    await wrapper.find('#cp-confirm').setValue(confirm)
    await wrapper.find('form.cp-form').trigger('submit')
    await flush()
  }

  it.each([
    ['password_policy', '太短啦', '#cp-new-error', '太短啦'],
    ['password_policy', '', '#cp-new-error', zhAuth.changePassword.policy],
    ['login_rate_limited', '', '.cp-form-error', zhAuth.login.rateLimited],
    ['rate_limited', '限流文案', '.cp-form-error', '限流文案'],
    ['other_code', '', '.cp-form-error', zhAuth.login.serviceUnavailable],
    ['other_code', '网关 502', '.cp-form-error', '网关 502']
  ])('%s（detail=%s）落到对应错误位', async (code, detail, selector, expected) => {
    const wrapper = await mountForm()
    client.post.mockRejectedValue({ code, detail })
    await fillAndSubmit(wrapper)
    // 调试
    if (!wrapper.find(selector).exists()) {
      expect(wrapper.find(selector).exists(), 'MISSING ' + selector).toBe(true)
    }
    expect(wrapper.find(selector).text()).toBe(expected)
    // 提交结束后按钮恢复可用
    expect(wrapper.find('.cp-submit').attributes('disabled')).toBeUndefined()
  })

  it('submitting 期间重复提交被忽略', async () => {
    const wrapper = await mountForm()
    let resolveChange
    client.post.mockImplementation(() => new Promise(resolve => {
      resolveChange = resolve
    }))
    await wrapper.find('#cp-current').setValue('old-pass')
    await wrapper.find('#cp-new').setValue('new-pass-123')
    await wrapper.find('#cp-confirm').setValue('new-pass-123')
    const form = wrapper.find('form.cp-form')
    await form.trigger('submit')
    await form.trigger('submit')
    resolveChange()
    await flush()
    expect(client.post).toHaveBeenCalledTimes(1)
    // 成功提示走全局 message
    expect(wrapper.emitted('success')).toBeTruthy()
  })

  it('输入时清掉对应错误', async () => {
    const wrapper = await mountForm()
    client.post.mockRejectedValue({ code: 'password_policy' })
    await fillAndSubmit(wrapper)
    expect(wrapper.find('#cp-new-error').exists()).toBe(true)
    await wrapper.find('#cp-new').setValue('another-pass-123')
    expect(wrapper.find('#cp-new-error').exists()).toBe(false)
  })
})

describe('ChangePasswordPage：强制改密态与成功回跳', () => {
  async function mountPage ({ mustChange = false, redirect = '' } = {}) {
    authState.user = { username: 'a', mustChangePassword: mustChange }
    const wrapper = await mountWithPlugins(ChangePasswordPage, {
      route: redirect ? `/change-password?redirect=${encodeURIComponent(redirect)}` : '/change-password',
      routes: ROUTES
    })
    await flush()
    return wrapper
  }

  it('强制改密：不显示「返回工作台」；非强制显示', async () => {
    const forced = await mountPage({ mustChange: true })
    expect(forced.find('.cp-back').exists()).toBe(false)

    const optional = await mountPage({ mustChange: false })
    expect(optional.find('.cp-back').exists()).toBe(true)
    expect(optional.find('#cp-title').text()).toContain('修改密码')
  })

  it('改密成功：带合法 redirect 回原地址；无/非法 redirect 回工作台', async () => {
    const withRedirect = await mountPage({ redirect: '/chat' })
    const form = withRedirect.findComponent(ChangePasswordForm)
    form.vm.$emit('success')
    await flush()
    expect(withRedirect.router.currentRoute.value.name).toBe('chat')

    const noRedirect = await mountPage({})
    noRedirect.findComponent(ChangePasswordForm).vm.$emit('success')
    await flush()
    expect(noRedirect.router.currentRoute.value.name).toBe('knowledge')

    const badRedirect = await mountPage({ redirect: '//evil.com' })
    badRedirect.findComponent(ChangePasswordForm).vm.$emit('success')
    await flush()
    expect(badRedirect.router.currentRoute.value.name).toBe('knowledge')
  })
})

describe('safeRedirect：与既有守卫用例互补的边角', () => {
  it('查询串里的 /login 不影响判断，带锚点的站内路径放行', () => {
    expect(safeRedirect('/x?next=/login')).toBe('/x?next=/login')
    expect(safeRedirect('/login?next=/x')).toBeNull()
    expect(safeRedirect('/a#frag')).toBe('/a#frag')
    expect(safeRedirect('')).toBeNull()
    expect(safeRedirect('relative')).toBeNull()
  })
})
