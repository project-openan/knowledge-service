// @vitest-environment jsdom
// app 壳层组件：AppShell（meta.hideNav 控制侧栏显隐）、AppSidebar（LeftNav 入口）、
// WorkspaceShell（面包屑 / 标题 / 三个插槽 / 专注模式按钮）、LeftNav 主题按钮
// （既有 LeftNav.spec 没点过的分支）。
import { describe, expect, it } from 'vitest'
import { mountWithPlugins, textOf, flush } from './helpers/mount'

import AppShell from '@/app/layout/AppShell.vue'
import AppSidebar from '@/app/layout/AppSidebar.vue'
import WorkspaceShell from '@/app/layout/WorkspaceShell.vue'
import LeftNav from '@/app/layout/nav/LeftNav.vue'
import { applyTheme } from '@/shared/lib/theme'

// 壳层只做布局，LeftNav 整棵换成探针桩（导航/权限逻辑已有专门 spec）
const LeftNavProbe = { name: 'LeftNavProbe', template: '<aside class="leftnav-probe" />' }
const shellStubs = { LeftNav: LeftNavProbe }

const IconProbe = { name: 'IconProbe', render: () => ['icon-probe'] }

describe('AppShell（应用外壳）', () => {
  it('默认渲染侧栏 + 主面板', async () => {
    const wrapper = await mountWithPlugins(AppShell, { route: '/', global: { stubs: shellStubs } })

    expect(wrapper.find('.app-shell').exists()).toBe(true)
    expect(wrapper.find('.leftnav-probe').exists()).toBe(true)
    expect(wrapper.find('.main-shell').exists()).toBe(true)
  })

  it('路由 meta.hideNav 为真时隐藏侧栏（深链接同样生效）', async () => {
    const wrapper = await mountWithPlugins(AppShell, {
      routes: [
        { path: '/', component: { render: () => null } },
        { path: '/bare', name: 'bare', component: { render: () => null }, meta: { hideNav: true } }
      ],
      route: '/bare',
      global: { stubs: shellStubs }
    })

    expect(wrapper.find('.app-shell').exists()).toBe(true)
    expect(wrapper.find('.leftnav-probe').exists()).toBe(false)
    expect(wrapper.find('.main-shell').exists()).toBe(true)
  })
})

describe('AppSidebar（参考项目命名的侧栏入口）', () => {
  it('只做一件事：把 LeftNav 渲染出来', async () => {
    const wrapper = await mountWithPlugins(AppSidebar, { route: '/', global: { stubs: shellStubs } })

    expect(wrapper.find('.leftnav-probe').exists()).toBe(true)
    expect(wrapper.findAll('*').length).toBeGreaterThan(0)
  })
})

describe('WorkspaceShell（工作区外壳）', () => {
  const mountShell = (props = {}, slots = {}) => mountWithPlugins(WorkspaceShell, {
    route: '/flow/detail/9',
    props,
    slots
  })

  it('渲染面包屑（返回链接 + 父级 + 当前）、图标与标题', async () => {
    const wrapper = await mountShell({
      back: '/flow',
      parent: '检索编排',
      context: '工作流 9',
      title: '编排画布',
      icon: IconProbe
    })

    const breadcrumb = wrapper.find('.workspace-breadcrumb')
    expect(breadcrumb.exists()).toBe(true)
    expect(breadcrumb.attributes('aria-label')).toBe('页面路径')
    const link = breadcrumb.find('a')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toContain('/flow')
    expect(textOf(breadcrumb)).toContain('检索编排')
    expect(textOf(breadcrumb)).toContain('工作流 9')
    // 返回路径支持 location 对象
    expect(wrapper.props('back')).toBe('/flow')

    expect(wrapper.find('.workspace-icon').text()).toContain('icon-probe')
    const heading = wrapper.find('h1')
    expect(textOf(heading)).toBe('编排画布')
    expect(heading.attributes('title')).toBe('编排画布')
    expect(wrapper.find('.workspace-title-row').exists()).toBe(true)
  })

  it('back 传路由 location 对象时 RouterLink 按对象解析', async () => {
    const wrapper = await mountShell({ back: { name: 'flow' }, parent: 'P', context: 'C', title: 'T' })

    const href = wrapper.find('.workspace-breadcrumb a').attributes('href')
    expect(href).toContain('/flow')
  })

  it('subtitle / actions 插槽与默认专注按钮', async () => {
    const wrapper = await mountShell(
      { title: '画布' },
      {
        subtitle: '<div class="sub-probe">草稿</div>',
        actions: '<button class="action-probe">保存</button>'
      }
    )

    expect(wrapper.find('.workspace-subtitle .sub-probe').exists()).toBe(true)
    expect(wrapper.find('.workspace-actions .action-probe').exists()).toBe(true)
    const focusButton = wrapper.find('.workspace-actions button.button-compact')
    expect(focusButton.exists()).toBe(true)
    expect(focusButton.attributes('aria-label')).toBe('专注模式')
    expect(focusButton.attributes('title')).toBe('专注模式')

    await focusButton.trigger('click')
    expect(wrapper.emitted('toggle-focus')).toHaveLength(1)
  })

  it('focused=true 时按钮文案换成退出专注模式', async () => {
    const wrapper = await mountShell({ focused: true, exitFocusText: '退出沉浸' })

    const focusButton = wrapper.find('.workspace-actions button.button-compact')
    expect(focusButton.attributes('aria-label')).toBe('退出沉浸')
    expect(focusButton.attributes('aria-label')).toBe(focusButton.attributes('title'))
    expect(wrapper.find('.workspace-page.is-focused').exists()).toBe(true)
  })

  it('focus-action 插槽替换默认专注按钮', async () => {
    const wrapper = await mountShell(
      { title: '图谱' },
      { 'focus-action': '<button class="focus-probe">沉浸画布</button>' }
    )

    expect(wrapper.find('.focus-probe').exists()).toBe(true)
    expect(wrapper.find('button.button-compact').exists()).toBe(false)
  })

  it('showFocusAction=false 时连默认专注按钮都不渲染（图谱页只留画布内入口）', async () => {
    const wrapper = await mountShell({ showFocusAction: false })

    expect(wrapper.find('.workspace-actions button').exists()).toBe(false)
    expect(wrapper.find('.workspace-body').exists()).toBe(true)
  })
})

describe('LeftNav 主题按钮（nav/ 残余分支）', () => {
  it('点击在明暗主题间往返，aria-pressed / 图标随主题切换', async () => {
    applyTheme('light')
    const wrapper = await mountWithPlugins(LeftNav, { route: '/knowledge' })

    const button = wrapper.find('button.theme-button')
    expect(button.exists()).toBe(true)
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(button.find('svg').exists()).toBe(true)
    expect(button.attributes('aria-label')).toContain('深色')

    await button.trigger('click')
    await flush()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.attributes('aria-label')).toContain('浅色')

    await button.trigger('click')
    await flush()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(button.attributes('aria-pressed')).toBe('false')
  })
})
