// @vitest-environment jsdom
// 算子分区与外壳：OperatorSection（单算子分区：换型下拉 / 上下移 / 删除确认 / 折叠）
// + OperatorDrawerShell（外壳循环：插槽分发、JSON 编辑器分支、暗色主题、新增下拉）。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { deletionMock, themeModule } = vi.hoisted(() => ({
  deletionMock: { requestDeletion: vi.fn() },
  themeModule: { theme: 'light' }
}))

vi.mock('@/shared/composables/deletion', () => ({
  requestDeletion: (...args) => deletionMock.requestDeletion(...args)
}))

// theme 是模块级 ref；模板里 `theme === 'dark'` 经自动解包比较，桩成可写的同形对象
vi.mock('@/shared/lib/theme', () => ({
  get theme () { return themeModule.theme }
}))

// json-editor-vue 是重型编辑器：外壳只用它的 v-model 与 class
vi.mock('json-editor-vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'JsonEditorVueStub',
      props: ['modelValue', 'mode', 'stringified', 'mainMenuBar'],
      emits: ['update:modelValue'],
      setup (props, { emit }) {
        return () => h('div', {
          class: 'json-editor-stub',
          'data-mode': props.mode,
          onClick: () => emit('update:modelValue', { edited: true })
        })
      }
    }
  }
})

import { describe, expect, it, beforeEach } from 'vitest'
import { h } from 'vue'
import zh from '@/app/i18n/zh.js'
import { flush, mountWithPlugins } from './helpers/mount'
import OperatorSection from '@/features/workflow/OperatorSection.vue'
import OperatorDrawerShell from '@/features/workflow/modules/shared/OperatorDrawerShell.vue'

/** el-dropdown 占位件：可主动发 command（默认占位件不透传事件）。 */
const CommandDropdown = {
  name: 'ElDropdown',
  props: ['trigger'],
  emits: ['command'],
  setup (_props, { emit, slots }) {
    return () => h('div', { class: 'dropdown-stub' }, [
      slots.default?.(),
      h('button', { class: 'fire-command', onClick: () => emit('command', 'KeywordRetriever') }),
      slots.dropdown?.()
    ])
  }
}

const DROPDOWN_PARTS = {
  ElDropdown: CommandDropdown,
  ElDropdownMenu: { name: 'ElDropdownMenu', setup: (_p, { slots }) => () => slots.default?.() },
  ElDropdownItem: { name: 'ElDropdownItem', setup: (_p, { slots }) => () => slots.default?.() },
  ElTooltip: { name: 'ElTooltip', setup: (_p, { slots }) => () => slots.default?.() }
}

function t (key, params = {}) {
  const text = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), zh)
  if (text == null) {
    return key
  }
  return String(text).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

const VECTOR_OP = { id: 'node-1_abc', operator: 'VectorRetriever', kwargs: {} }
const OPTIONS = [
  { id: 'VectorRetriever', label: '向量检索' },
  { id: 'KeywordRetriever', name: '关键词检索' }
]

beforeEach(() => {
  deletionMock.requestDeletion.mockReset()
  themeModule.theme = 'light'
})

// ─────────────────────────────────────────────────────────────────────────────
// OperatorSection
// ─────────────────────────────────────────────────────────────────────────────

describe('OperatorSection：单算子分区', () => {
  function mountSection (props = {}) {
    return mountWithPlugins(OperatorSection, {
      route: '/flow',
      props: {
        operator: VECTOR_OP,
        index: 0,
        options: OPTIONS,
        ...props
      },
      slots: { default: '<div class="section-body">表单</div>' }
    })
  }

  it('序号补零 + 已知算子渲换型下拉（选中当前 operator）', async () => {
    const wrapper = await mountSection()
    expect(wrapper.find('.fc-step').text()).toBe('01')
    expect(wrapper.find('.fc-operator-select').exists()).toBe(true)
    expect(wrapper.find('.fc-operator-custom').exists()).toBe(false)
    // aria 状态可判：折叠按钮默认展开
    expect(wrapper.find('button.icon-button').attributes('aria-expanded')).toBe('true')
    expect(wrapper.findComponent({ name: 'ElSelect' }).attributes('aria-label'))
      .toBe(t('modules.workflow.operatorType', { index: 1 }))
  })

  it('自定义/未知算子：不出下拉，显示 operatorName 兜底 operator', async () => {
    const custom = await mountSection({ operator: { id: 'x', operator: 'Weird', operatorName: '我的算子', custom: true } })
    expect(custom.find('.fc-operator-select').exists()).toBe(false)
    expect(custom.find('.fc-operator-custom').text()).toBe('我的算子')
    custom.unmount()

    const unknown = await mountSection({ operator: { id: 'y', operator: 'AlsoWeird' } })
    expect(unknown.find('.fc-operator-custom').text()).toBe('AlsoWeird')
  })

  it('折叠：v-show 隐藏正文，aria-expanded=false，按钮箭头切换', async () => {
    const collapsed = await mountSection({ collapsed: true })
    expect(collapsed.find('.fc-operator-body').isVisible()).toBe(false)
    expect(collapsed.find('button.icon-button').attributes('aria-expanded')).toBe('false')
    const label = collapsed.find('button.icon-button').attributes('aria-label')
    expect(label).toBe(t('modules.workflow.expandOperator', { index: 1 }))

    const expanded = await mountSection({ collapsed: false })
    expect(expanded.find('.fc-operator-body').isVisible()).toBe(true)
  })

  it('toggle / move 上抛；首位上移与末位下移禁用', async () => {
    const wrapper = await mountSection({ index: 0, last: false })
    const buttons = wrapper.findAll('button.icon-button')
    await buttons[0].trigger('click') // 折叠钮
    expect(wrapper.emitted('toggle')).toHaveLength(1)

    // index 0：上移禁用、下移可用
    expect(buttons[1].attributes('disabled')).toBeDefined()
    await buttons[2].trigger('click')
    expect(wrapper.emitted('move')[0]).toEqual([1])

    const tail = await mountSection({ index: 2, last: true })
    const tailButtons = tail.findAll('button.icon-button')
    expect(tailButtons[2].attributes('disabled')).toBeDefined()
    await tailButtons[1].trigger('click')
    expect(tail.emitted('move')[0]).toEqual([-1])
  })

  it('删除：确认弹窗通过才上抛 remove；single 时按钮禁用且不弹窗', async () => {
    deletionMock.requestDeletion.mockResolvedValue(true)
    const wrapper = await mountSection({ single: false })
    const removeButton = wrapper.findAll('button.icon-button')[3]
    await removeButton.trigger('click')
    await flush()
    expect(deletionMock.requestDeletion).toHaveBeenCalledTimes(1)
    const options = deletionMock.requestDeletion.mock.calls[0][0]
    expect(options.items[0].id).toBe('node-1_abc')
    expect(options.items[0].name).toBe('VectorRetriever')
    expect(options.verification).toBe(false)
    expect(wrapper.emitted('remove')).toHaveLength(1)
    wrapper.unmount()

    // 用户取消：不删
    deletionMock.requestDeletion.mockResolvedValue(false)
    const cancelled = await mountSection({ single: false })
    await cancelled.findAll('button.icon-button')[3].trigger('click')
    await flush()
    expect(cancelled.emitted('remove')).toBeUndefined()
    cancelled.unmount()

    // 唯一算子：按钮禁用，点了也不弹
    deletionMock.requestDeletion.mockClear()
    const single = await mountSection({ single: true })
    expect(single.findAll('button.icon-button')[3].attributes('disabled')).toBeDefined()
    await single.findAll('button.icon-button')[3].trigger('click')
    await flush()
    expect(deletionMock.requestDeletion).not.toHaveBeenCalled()
  })

  it('换型下拉回传 change 事件', async () => {
    const wrapper = await mountSection()
    const select = wrapper.findComponent({ name: 'ElSelect' })
    // el-select 占位件（默认占位只渲插槽）；换型事件经组件实例触发
    select.vm.$emit('update:modelValue', 'KeywordRetriever')
    await flush()
    expect(wrapper.emitted('change')[0]).toEqual(['KeywordRetriever'])
  })

  it('options 里没有当前 operator：也算不可换（只读展示）', async () => {
    const wrapper = await mountSection({ options: [{ id: 'SomethingElse', label: '别的' }] })
    expect(wrapper.find('.fc-operator-select').exists()).toBe(false)
    expect(wrapper.find('.fc-operator-custom').text()).toBe('VectorRetriever')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// OperatorDrawerShell：外壳循环
// ─────────────────────────────────────────────────────────────────────────────

describe('OperatorDrawerShell：外壳循环', () => {
  function fakeDrawer (overrides = {}) {
    return {
      operatorList: [
        { _key: 'op-1', _collapsed: false, operator: 'VectorRetriever', kwargs: { a: 1 } }
      ],
      builtinOperatorList: [{ id: 'KeywordRetriever', name: '关键词检索' }],
      disableAddOperator: false,
      isKnownOperator: operator => operator.operator === 'VectorRetriever',
      addOperatorWithType: vi.fn(),
      changeOperator: vi.fn(),
      move: vi.fn(),
      remove: vi.fn(),
      ...overrides
    }
  }

  function mountShell (drawer, global = {}) {
    return mountWithPlugins(OperatorDrawerShell, {
      route: '/flow',
      props: { drawer },
      global: { components: DROPDOWN_PARTS, ...global },
      slots: { default: '<div class="slot-form">已知算子表单</div>' }
    })
  }

  it('顶栏：算子数 + 新增下拉项；command 直达 drawer.addOperatorWithType', async () => {
    const drawer = fakeDrawer()
    const wrapper = await mountShell(drawer)
    expect(wrapper.text()).toContain(t('modules.workflow.operatorConfig'))
    expect(wrapper.text()).toContain('1')
    expect(wrapper.text()).toContain('关键词检索')

    await wrapper.find('button.fire-command').trigger('click')
    expect(drawer.addOperatorWithType).toHaveBeenCalledWith('KeywordRetriever')
  })

  it('disableAddOperator：不渲新增下拉，也就没有 command 入口', async () => {
    const wrapper = await mountShell(fakeDrawer({ disableAddOperator: true }))
    expect(wrapper.find('.dropdown-stub').exists()).toBe(false)
    expect(wrapper.find('button.fire-command').exists()).toBe(false)
  })

  it('已知算子走插槽表单；自定义算子走 JSON 编辑器', async () => {
    const drawer = fakeDrawer({
      operatorList: [
        { _key: 'op-1', _collapsed: false, operator: 'VectorRetriever', kwargs: {} },
        { _key: 'op-2', _collapsed: false, operator: 'TotallyUnknown', custom: true, kwargs: { a: 1 } }
      ]
    })
    const wrapper = await mountShell(drawer)
    expect(wrapper.find('.slot-form').exists()).toBe(true)
    const editor = wrapper.find('.json-editor-stub')
    expect(editor.exists()).toBe(true)
    expect(editor.attributes('data-mode')).toBe('text')

    // v-model 回写：编辑器 emit 的值落到 operator.kwargs
    await editor.trigger('click')
    expect(drawer.operatorList[1].kwargs).toEqual({ edited: true })
    // 浅色主题无暗色类
    expect(editor.classes()).not.toContain('jse-theme-dark')
  })

  it('未知但非自定义的算子也走 JSON 编辑器；暗色主题加暗色类', async () => {
    themeModule.theme = 'dark'
    const drawer = fakeDrawer({
      operatorList: [{ _key: 'op-1', _collapsed: false, operator: 'Mystery', kwargs: {} }]
    })
    const wrapper = await mountShell(drawer)
    expect(wrapper.find('.slot-form').exists()).toBe(false)
    const editor = wrapper.find('.json-editor-stub')
    expect(editor.exists()).toBe(true)
    expect(editor.classes()).toContain('jse-theme-dark')
  })

  it('分区事件直连 drawer 动作：toggle / move / remove / change', async () => {
    const drawer = fakeDrawer({
      operatorList: [
        { _key: 'op-1', _collapsed: false, operator: 'VectorRetriever', kwargs: {} },
        { _key: 'op-2', _collapsed: false, operator: 'KeywordRetriever', kwargs: {} }
      ]
    })
    const wrapper = await mountShell(drawer)
    const firstSection = wrapper.findAllComponents(OperatorSection)[0]
    const buttons = firstSection.findAll('button.icon-button')

    await buttons[0].trigger('click') // toggle
    expect(drawer.operatorList[0]._collapsed).toBe(true)
    await buttons[0].trigger('click')
    expect(drawer.operatorList[0]._collapsed).toBe(false)

    await buttons[2].trigger('click') // 下移（第二个分区存在，可用）
    expect(drawer.move).toHaveBeenCalledWith(0, 1)

    deletionMock.requestDeletion.mockResolvedValue(true)
    await buttons[3].trigger('click') // remove（经确认）
    await flush()
    expect(drawer.remove).toHaveBeenCalledWith(0)

    // 换型：任取一个分区下拉发值（change 的 operator 绑定是模板层的 v-for 变量，
    // 经 props 透出的是响应式代理，比对 _key 而不是对象身份）
    wrapper.findAllComponents({ name: 'ElSelect' })[0].vm.$emit('update:modelValue', 'KeywordRetriever')
    await flush()
    expect(drawer.changeOperator).toHaveBeenCalledTimes(1)
    const [changedOperator, changedId] = drawer.changeOperator.mock.calls[0]
    expect(changedId).toBe('KeywordRetriever')
    expect(drawer.operatorList.map(op => op._key)).toContain(changedOperator._key)
  })

  it('after 插槽渲染在算子列表之后（响应合成的提示词大编辑器挂点）', async () => {
    const wrapper = await mountWithPlugins(OperatorDrawerShell, {
      route: '/flow',
      props: { drawer: fakeDrawer() },
      global: { components: DROPDOWN_PARTS },
      slots: { after: '<div class="after-slot">附加编辑器</div>' }
    })
    expect(wrapper.find('.after-slot').exists()).toBe(true)
    expect(wrapper.find('.after-slot').exists()).toBe(true)
  })
})
