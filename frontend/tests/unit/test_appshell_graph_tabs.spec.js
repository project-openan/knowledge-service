// @vitest-environment jsdom
// GraphTabs（图谱知识库容器）的残余分支（既有 knowledgeGraphtab.spec 已钉住
// 「默认图谱列表 / 深链模版列表」两个初值；这里补交互与路由同步）：
//   - 深链 ?subTab=knowledgeGraphTemplate 初值 + 顶部返回链接
//   - goGraphList 点击 → router.push 回列表
//   - 路由 query 变化（watch，含 immediate 与 50/100/300ms 兜底）驱动两个方向的切换
import { describe, expect, it, vi } from 'vitest'
import { mountWithPlugins, flush, textOf } from './helpers/mount'

// 两个子列表换探针桩：真列表会拉十几条接口，与本 spec 断言无关
vi.mock('@/features/graph/GraphList.vue', async () => {
  const { h, inject } = await import('vue')
  return {
    default: {
      name: 'KnowledgeGraphProbe',
      setup () {
        const tab = inject('activeTabName', null)
        return () => h('div', { class: 'probe-graph-list' }, tab ? String(tab.value) : '')
      }
    }
  }
})
vi.mock('@/features/graph/GraphTemplateList.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'KnowledgeGraphTemplateProbe',
      setup () {
        return () => h('div', { class: 'probe-template-list' }, 'template')
      }
    }
  }
})

import GraphTabs from '@/features/graph/GraphTabs.vue'

/** 组件内的 subTab 同步有 50/100/300ms 三重延迟兜底，等它跑完。 */
async function settleRoute () {
  await new Promise(resolve => setTimeout(resolve, 400))
  await flush()
}

const TAB_ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } }
]

describe('GraphTabs（页签切换与路由同步）', () => {
  it('深链 ?subTab=knowledgeGraphTemplate：初值就是模版列表 + 顶部返回链接', async () => {
    const wrapper = await mountWithPlugins(GraphTabs, {
      routes: TAB_ROUTES,
      route: '/graph?subTab=knowledgeGraphTemplate'
    })
    await settleRoute()

    expect(wrapper.find('.probe-template-list').exists()).toBe(true)
    expect(wrapper.find('.probe-graph-list').exists()).toBe(false)

    const back = wrapper.find('.kg-template-back')
    expect(back.exists()).toBe(true)
    expect(textOf(back)).toContain('知识图谱')
  })

  it('点返回链接：push /graph?subTab=knowledgeGraph 并切回图谱列表', async () => {
    const wrapper = await mountWithPlugins(GraphTabs, {
      routes: TAB_ROUTES,
      route: '/graph?subTab=knowledgeGraphTemplate'
    })
    await settleRoute()
    const pushSpy = vi.spyOn(wrapper.router, 'push')

    // Act
    await wrapper.find('.kg-template-back button').trigger('click')
    await flush()

    // Assert：push 的是带 subTab 的 location
    expect(pushSpy).toHaveBeenCalled()
    const pushed = pushSpy.mock.calls[0][0]
    expect(pushed.path).toBe('/graph')
    expect(pushed.query.subTab).toBe('knowledgeGraph')

    await settleRoute()
    expect(wrapper.find('.probe-graph-list').exists()).toBe(true)
    expect(wrapper.find('.probe-template-list').exists()).toBe(false)
  })

  it('路由 query 切到模版（watch 驱动）：图谱列表 → 模版列表', async () => {
    const wrapper = await mountWithPlugins(GraphTabs, {
      routes: TAB_ROUTES,
      route: '/graph'
    })
    await settleRoute()
    expect(wrapper.find('.probe-graph-list').exists()).toBe(true)

    // Act：模版设计器保存/返回时写入的 query
    await wrapper.router.push({ path: '/graph', query: { subTab: 'knowledgeGraphTemplate' } })
    await settleRoute()

    expect(wrapper.find('.probe-template-list').exists()).toBe(true)
    expect(wrapper.find('.kg-template-back').exists()).toBe(true)
  })

  it('路由 query 切回 knowledgeGraph：模版列表 → 图谱列表', async () => {
    const wrapper = await mountWithPlugins(GraphTabs, {
      routes: TAB_ROUTES,
      route: '/graph?subTab=knowledgeGraphTemplate'
    })
    await settleRoute()

    // Act
    await wrapper.router.push({ path: '/graph', query: { subTab: 'knowledgeGraph' } })
    await settleRoute()

    expect(wrapper.find('.probe-graph-list').exists()).toBe(true)
    expect(wrapper.find('.kg-template-back').exists()).toBe(false)
    // provide 的页签名同步给了子组件（自动刷新的可见性闸门靠它）
    expect(textOf(wrapper.find('.probe-graph-list'))).toBe('knowledgeGraph')
  })

  it('query 带其他参数变化（subTab 缺失）时保持当前页签不抖动', async () => {
    const wrapper = await mountWithPlugins(GraphTabs, {
      routes: TAB_ROUTES,
      route: '/graph?subTab=knowledgeGraphTemplate'
    })
    await settleRoute()
    expect(wrapper.find('.probe-template-list').exists()).toBe(true)

    // Act：别的参数变了（subTab 不在）→ 不满足任一分支，维持模版列表
    await wrapper.router.push({ path: '/graph', query: { keyword: 'x' } })
    await settleRoute()

    expect(wrapper.find('.probe-template-list').exists()).toBe(true)
    expect(wrapper.find('.probe-graph-list').exists()).toBe(false)
  })
})
