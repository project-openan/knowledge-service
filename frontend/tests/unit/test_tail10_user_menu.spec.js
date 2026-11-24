// @vitest-environment jsdom
/**
 * UserMenu.vue（应用壳右上角用户菜单）—— 全量补齐。
 *
 * 会话出口 mock 掉（signOut 发真实请求）；el-popover 用「reference + 面板都渲染」的桩，
 * el-dialog 用透传桩（修改密码表单在弹窗里，只有 modelValue 为真才渲染）。
 * 钉住：
 * - 头像缩写取 displayName 首字母（无 displayName 回退 username，再回退「?」）；
 * - 「修改密码」：先收起菜单再开弹窗，@success 后关弹窗；
 * - 「退出登录」：signOut → success toast → 跳登录页。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { h, ref } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'

const { signOutSpy, currentUserRef } = vi.hoisted(() => ({
  signOutSpy: vi.fn(async () => {}),
  currentUserRef: { value: null }
}))

vi.mock('@/features/auth/session', () => ({
  currentUser: currentUserRef,
  signOut: signOutSpy
}))

vi.mock('@/shared/lib/message', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('@/features/auth/components/ChangePasswordForm.vue', () => ({
  default: {
    name: 'ChangePasswordFormStub',
    emits: ['success'],
    setup (_, { emit }) {
      return () => h('div', { class: 'change-password-stub' }, [
        h('button', { class: 'pwd-success', onClick: () => emit('success') }, '改密成功')
      ])
    }
  }
}))

import UserMenu from '@/features/auth/components/UserMenu.vue'
import message from '@/shared/lib/message'

/** el-popover 桩：reference 与面板同层渲染，visible 变化都走 v-model。 */
const PopoverStub = {
  name: 'ElPopover',
  props: ['visible', 'placement', 'trigger', 'width', 'offset', 'popperClass'],
  emits: ['update:visible'],
  setup (props, { slots, emit }) {
    return () => h('div', { class: 'popover-stub' }, [
      h('div', { class: 'popover-reference', onClick: () => emit('update:visible', !props.visible) },
        slots.reference ? slots.reference() : []),
      props.visible ? h('div', { class: 'popover-content' }, slots.default ? slots.default() : []) : null
    ])
  }
}

/** el-dialog 桩：v-model 双向，modelValue 为真时渲染默认插槽。 */
const DialogStub = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'alignCenter'],
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => h('div', { class: 'dialog-stub' }, [
      props.modelValue ? (slots.default ? slots.default() : null) : null
    ])
  }
}

async function mountMenu () {
  const wrapper = await mountWithPlugins(UserMenu, {
    route: '/chat',
    global: { components: { ElPopover: PopoverStub, ElDialog: DialogStub } }
  })
  await flush()
  return wrapper
}

function openMenu (wrapper) {
  return wrapper.find('.user-trigger').trigger('click')
}

describe('UserMenu', () => {
  beforeEach(() => {
    signOutSpy.mockClear()
    message.success.mockClear()
    currentUserRef.value = { username: 'ops@example.com', displayName: '王小明' }
    document.body.innerHTML = ''
  })

  it('面板展示 displayName/username 与头像缩写', async () => {
    const wrapper = await mountMenu()
    expect(wrapper.find('.user-trigger').attributes('aria-expanded')).toBe('false')
    await openMenu(wrapper)
    await flush()

    expect(wrapper.find('.user-trigger').attributes('aria-expanded')).toBe('true')
    const panel = wrapper.find('.user-panel')
    expect(panel.find('b').text()).toBe('王小明')
    expect(panel.find('small').text()).toBe('ops@example.com')
    expect(panel.find('.user-avatar--lg').text()).toBe('王')
    expect(panel.text()).toContain('修改密码')
    expect(panel.text()).toContain('退出登录')
  })

  it('无 displayName 时回落 username，再回落「?」', async () => {
    currentUserRef.value = { username: 'carol' }
    const wrapper = await mountMenu()
    await openMenu(wrapper)
    await flush()
    expect(wrapper.find('.user-panel b').text()).toBe('carol')
    expect(wrapper.find('.user-panel .user-avatar--lg').text()).toBe('C')

    currentUserRef.value = null
    const anon = await mountMenu()
    expect(anon.find('.user-avatar').text()).toBe('?')
  })

  it('「修改密码」：收起菜单、打开弹窗；表单 @success 后关弹窗', async () => {
    const wrapper = await mountMenu()
    await openMenu(wrapper)
    await flush()

    await wrapper.find('.user-item:not(.user-item--danger)').trigger('click')
    await flush()

    // 菜单收起（popover 内容消失），弹窗出现
    expect(wrapper.find('.popover-content').exists()).toBe(false)
    expect(wrapper.find('.change-password-stub').exists()).toBe(true)

    await wrapper.find('.pwd-success').trigger('click')
    await flush()
    expect(wrapper.find('.change-password-stub').exists()).toBe(false)
  })

  it('「退出登录」：signOut → success toast → replace 到登录页', async () => {
    const wrapper = await mountMenu()
    await openMenu(wrapper)
    await flush()

    await wrapper.find('.user-item--danger').trigger('click')
    await flush()

    expect(signOutSpy).toHaveBeenCalledTimes(1)
    expect(message.success).toHaveBeenCalledTimes(1)
    expect(wrapper.router.currentRoute.value.name).toBe('login')
  })
})
