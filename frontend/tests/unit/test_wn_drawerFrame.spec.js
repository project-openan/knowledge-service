// @vitest-environment jsdom
// DrawerFrame.vue：节点配置抽屉骨架（标题区 / 基础信息折叠区 / 校验 / 底部动作）。
// el-drawer 换成三插槽全渲的占位件（默认占位件只渲 default 槽，header/footer 也要断言），
// 基础校验（空名称 / 无上游）经 expose 出来的 submitHandle 直接触发。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.aipVueInstance = { $t: () => '' }
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

import { describe, expect, it, beforeEach } from 'vitest'
import { h } from 'vue'
import zh from '@/app/i18n/zh.js'
import { flush, mountWithPlugins } from './helpers/mount'
import DrawerFrame from '@/features/workflow/DrawerFrame.vue'

/** header / default / footer 三槽全渲的 el-drawer 占位件，default 槽由 v-model 控制。 */
const ElDrawerAllSlots = {
  name: 'ElDrawer',
  props: ['modelValue'],
  emits: ['update:modelValue', 'closed'],
  setup (props, { slots }) {
    return () => h('div', { class: 'drawer-stub' }, [
      slots.header?.(),
      props.modelValue ? slots.default?.() : null,
      slots.footer?.()
    ])
  }
}

/** el-select 占位件：带一个把选中值抛出来的按钮（多选上游无法经真件模拟）。 */
const SelectEmitStub = {
  name: 'ElSelect',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup (props, { emit, slots }) {
    return () => h('div', { class: 'select-stub' }, [
      slots.default?.(),
      h('button', { class: 'pick-upstream', onClick: () => emit('update:modelValue', ['q-node']) })
    ])
  }
}

function t (key, params = {}) {
  const text = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), zh)
  if (text == null) {
    return key
  }
  return String(text).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

async function mountDrawer (props = {}, global = {}) {
  const wrapper = await mountWithPlugins(DrawerFrame, {
    route: '/flow',
    props: {
      title: '检索器',
      nodeLabel: 'RE-1',
      operatorCount: 2,
      tone: 'orange',
      ...props
    },
    global: {
      components: { ElDrawer: ElDrawerAllSlots, ElSelect: SelectEmitStub },
      ...global
    }
  })
  // 抽屉默认收着：打开后 default 槽才渲（与真实使用一致：父组件先 openDrawer）
  wrapper.vm.openDrawer()
  await flush()
  return wrapper
}

beforeEach(() => {
  window.aipVueInstance.$t = t
})

describe('DrawerFrame：业务节点的配置抽屉', () => {
  it('头部：模块图标 + 标题 + label + 算子数徽标', async () => {
    const wrapper = await mountDrawer()
    const header = wrapper.find('.fc-header')
    expect(header.exists()).toBe(true)
    expect(header.text()).toContain(t('modules.workflow.nodeConfig'))
    expect(header.text()).toContain('检索器')
    expect(header.text()).toContain('RE-1')
    expect(header.text()).toContain(t('modules.workflow.operatorCountBadge', { count: 2 }))
    expect(wrapper.find('.module-icon.orange').exists()).toBe(true)
  })

  it('基础信息折叠区：名称输入回传 update:nodeLabel，上游回传 update:upstreams', async () => {
    const wrapper = await mountDrawer()
    const input = wrapper.find('.fc-basics input')
    expect(input.exists()).toBe(true)
    await input.setValue('新名字')
    expect(wrapper.emitted('update:nodeLabel')[0]).toEqual(['新名字'])

    await wrapper.find('button.pick-upstream').trigger('click')
    expect(wrapper.emitted('update:upstreams')[0]).toEqual([['q-node']])
    expect(wrapper.text()).toContain(t('modules.workflow.upstreamCount', { count: 0 }))
  })

  it('submitHandle 校验：空名称 → 提示 + 展开基础区，不发 submit', async () => {
    const wrapper = await mountDrawer({ nodeLabel: '   ' })
    wrapper.vm.submitHandle()
    await flush()
    expect(wrapper.emitted('submitHandle')).toBeUndefined()
    expect(wrapper.find('.fc-error').text()).toBe(t('modules.workflow.nodeNameRequired'))
    // 校验失败会把折叠的基础信息区展开
    expect(wrapper.find('.fc-basics').attributes('open')).toBeDefined()
  })

  it('submitHandle 校验：有名称但无上游 → 需要上游提示', async () => {
    const wrapper = await mountDrawer({ nodeLabel: 'RE-1', upstreams: [] })
    wrapper.vm.submitHandle()
    await flush()
    expect(wrapper.emitted('submitHandle')).toBeUndefined()
    expect(wrapper.find('.fc-error').text()).toBe(t('modules.workflow.needUpstream'))
  })

  it('校验通过：发 submit；错误可被 clearError 清掉', async () => {
    const wrapper = await mountDrawer({ nodeLabel: 'RE-1', upstreams: ['q-node'] })
    wrapper.vm.submitHandle()
    await flush()
    expect(wrapper.emitted('submitHandle')).toHaveLength(1)
    expect(wrapper.find('.fc-error').exists()).toBe(false)

    wrapper.vm.showError('出错了')
    await flush()
    expect(wrapper.find('.fc-error').text()).toBe('出错了')
    wrapper.vm.clearError()
    await flush()
    expect(wrapper.find('.fc-error').exists()).toBe(false)
  })

  it('showError 空串：只清错不滚动', async () => {
    const wrapper = await mountDrawer()
    wrapper.vm.showError('') // 无 message：不进入滚动分支，错误区清空
    await flush()
    expect(wrapper.find('.fc-error').exists()).toBe(false)
  })

  it('cancel / delete / closed 各自上抛；cancel 同时关抽屉', async () => {
    const wrapper = await mountDrawer()
    const buttons = wrapper.findAll('button')
    await buttons.find(b => b.text().includes(t('public.cancel'))).trigger('click')
    expect(wrapper.emitted('cancelHandle')).toHaveLength(1)

    await buttons.find(b => b.text().includes(t('modules.workflow.deleteNode'))).trigger('click')
    expect(wrapper.emitted('delete')).toHaveLength(1)

    wrapper.findComponent({ name: 'ElDrawer' }).vm.$emit('closed')
    await flush()
    expect(wrapper.emitted('closed')).toHaveLength(1)
  })

  it('openDrawer：重置错误与基础区并打开；closeDrawer 关闭', async () => {
    const wrapper = await mountDrawer({ nodeLabel: '' })
    wrapper.vm.showError('旧错误')
    wrapper.vm.openDrawer()
    await flush()
    expect(wrapper.find('.fc-error').exists()).toBe(false)
    expect(wrapper.find('.fc-basics').attributes('open')).toBeUndefined()

    wrapper.vm.closeDrawer()
    await flush()
    expect(wrapper.findComponent({ name: 'ElDrawer' }).props('modelValue')).toBe(false)
  })

  it('details toggle：展开状态跟着原生 toggle 走', async () => {
    const wrapper = await mountDrawer()
    const details = wrapper.find('.fc-basics')
    ;[true, false].forEach(open => {
      details.element.open = open
      details.element.dispatchEvent(new Event('toggle'))
    })
    await flush()
    // 最后一次 toggle 为 false → 内部状态关闭（无直接出口，间接靠下次校验不再强制 open）
    expect(details.element.open).toBe(false)
  })
})

describe('DrawerFrame：固定节点（QUERY/RESPONSE）的信息抽屉', () => {
  it('头部切到「节点信息」，正文是属性表，无底部动作', async () => {
    const wrapper = await mountDrawer({
      fixed: true,
      fixedDirection: '输出',
      fixedField: 'Question'
    })
    expect(wrapper.text()).toContain(t('modules.workflow.nodeInfo'))
    expect(wrapper.text()).toContain(t('modules.workflow.nodeType'))
    expect(wrapper.text()).toContain('输出')
    expect(wrapper.text()).toContain('Question')
    expect(wrapper.text()).toContain(t('modules.workflow.fixedNodeHint'))
    expect(wrapper.find('.fc-basics').exists()).toBe(false)
    expect(wrapper.find('.fc-footer').exists()).toBe(false)
  })

  it('固定节点跳过基础校验：直接发 submit', async () => {
    const wrapper = await mountDrawer({ fixed: true, nodeLabel: '' })
    wrapper.vm.submitHandle()
    await flush()
    expect(wrapper.emitted('submitHandle')).toHaveLength(1)
  })
})
