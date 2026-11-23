// @vitest-environment jsdom
// ↑ 组件测试：挂载 GraphControls.vue，触发真实 DOM 事件与组件事件
/**
 * GraphControls.vue 的高级查询抽屉与查询下发（既有 GraphControls.spec.js 只钉条件
 * 编辑器的三处语义，本文件补齐其余主链路）：
 * - 工具条：刷新按钮（注入/未注入 refreshGraph 两条路）、搜索输入转发；
 * - 高级查询抽屉：openAdvanced 入口与 advanced-open 事件、重置（Limit 回 50）；
 * - limit 输入：change 夹取 1..1000、blur 对 null 兜底发 50；
 * - 查询下发 buildFilters：entity（含快速筛选类型合并、数值转换、in/between JSON 解析、
 *   complex_filter 的 and/or）、relation（edge_type 键）、subgraph（三段 filters + direction）；
 * - 子图模式的深度/方向、组与条件行的增删；resetToken 变化重置全部条件。
 * el-select 一律用替身（照既有 spec 的写法），真下拉在 jsdom 里要开 teleport 弹层。
 */
import { h } from 'vue'

import { ElInputNumber } from 'element-plus/es/components/input-number/index'

import { flush, mountWithPlugins } from './helpers/mount'

import GraphControls from '@/features/graph/components/GraphControls.vue'

// ── ElMessage：组件的用户可见反馈出口，拦下来直接断言 ─────────────────────────
const { warningSpy } = vi.hoisted(() => ({ warningSpy: vi.fn() }))
vi.mock('element-plus', () => ({
  ElMessage: { warning: warningSpy, success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

// ── el-select 替身（与既有 GraphControls.spec.js 同款契约） ───────────────────
const ElSelectStub = {
  name: 'ElSelect',
  props: {
    modelValue: { default: undefined },
    placeholder: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    clearable: { type: Boolean, default: false },
    size: { type: String, default: '' }
  },
  emits: ['update:modelValue', 'change', 'clear'],
  setup () {
    return () => h('div')
  }
}

// 抽屉外壳替身：渲染 header / default / footer 三个插槽（footer 里有「重置」与「应用查询」）
const ElDrawerStub = {
  name: 'ElDrawer',
  props: { modelValue: { type: Boolean, default: false } },
  emits: ['update:modelValue'],
  setup (props, { slots }) {
    return () => h('div', {
      class: 'drawer-stub',
      'data-open': String(props.modelValue)
    }, [
      slots.header ? slots.header() : null,
      slots.default ? slots.default() : null,
      slots.footer ? slots.footer() : null
    ])
  }
}

// 「条件组合」and/or 的单选组替身：只保留 v-model 契约
const ElRadioGroupStub = {
  name: 'ElRadioGroup',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue', 'change'],
  setup () {
    return () => h('div', { class: 'radio-group-stub' })
  }
}

const MOUNT_PROPS = {
  entityTypes: ['Scene', 'Resource', 'Ghost'],
  edgeTypes: ['投资', '持股'],
  entityTypeProperties: {
    Scene: [
      { name: 'level', type: 'INTEGER' },
      { name: 'name', type: 'STRING' }
    ],
    Resource: [{ name: 'tag', type: 'STRING' }]
  },
  edgeTypeProperties: {
    投资: [{ name: 'amount', type: 'DOUBLE' }]
  }
}

async function mountControls (extraProps = {}) {
  const wrapper = await mountWithPlugins(GraphControls, {
    router: null,
    props: { ...MOUNT_PROPS, ...extraProps },
    global: {
      components: {
        ElSelect: ElSelectStub,
        ElInputNumber,
        ElDrawer: ElDrawerStub,
        ElRadioGroup: ElRadioGroupStub,
        ElRadioButton: { name: 'ElRadioButton', template: '<span class="radio-button-stub"><slot /></span>' },
        ElTooltip: { name: 'ElTooltip', setup (_, { slots }) { return () => slots.default?.() } },
        ElForm: { name: 'ElForm', setup (_, { slots }) { return () => slots.default?.() } },
        ElFormItem: { name: 'ElFormItem', setup (_, { slots }) { return () => slots.default?.() } }
      }
    }
  })
  return wrapper
}

/** 打开高级查询抽屉（走工具条按钮，与用户路径一致） */
async function openAdvanced (wrapper) {
  const btn = wrapper.findAll('button').find(b => b.text().includes('高级查询'))
  expect(btn, '找不到「高级查询」按钮').toBeTruthy()
  await btn.trigger('click')
  await flush()
  return wrapper
}

function selectAt (wrapper, selector) {
  const element = wrapper.find(selector).element
  return wrapper.findAllComponents(ElSelectStub).find(c => c.element === element) || null
}

async function chooseSelect (wrapper, selector, value) {
  const select = selectAt(wrapper, selector)
  expect(select, `找不到 ${selector} 命中的 el-select`).not.toBeNull()
  select.vm.$emit('update:modelValue', value)
  select.vm.$emit('change', value)
  await flush()
}

/** 工具条的「查询」按钮 */
function queryButton (wrapper) {
  return wrapper.findAll('button').find(b => b.text().replace(/\s/g, '').includes('查询') && b.classes().includes('control-button'))
}

function inputNumbers (wrapper) {
  return wrapper.findAllComponents(ElInputNumber)
}

describe('GraphControls 高级查询与查询下发', () => {
  beforeEach(() => {
    warningSpy.mockClear()
  })

  it('刷新按钮：未注入 refreshGraph 时 emit refresh-graph；注入了则优先调用注入实现', async () => {
    const injected = vi.fn().mockResolvedValue()
    const plain = await mountControls()

    const refreshBtn = plain.find('.table-refresh-control button')
    await refreshBtn.trigger('click')
    await flush()
    expect(plain.emitted('refresh-graph')).toHaveLength(1)

    const withInjected = await mountControls({ refreshGraph: injected })
    await withInjected.find('.table-refresh-control button').trigger('click')
    await flush()
    expect(injected).toHaveBeenCalledTimes(1)
    expect(withInjected.emitted('refresh-graph')).toBeUndefined()
  })

  it('搜索输入转发 search-input；「高级查询」按钮开抽屉并 emit advanced-open', async () => {
    const wrapper = await mountControls()

    await wrapper.find('.control-search input').setValue('芯片')
    expect(wrapper.emitted('search-input')[0]).toEqual(['芯片'])

    expect(wrapper.find('.drawer-stub').attributes('data-open')).toBe('false')
    const advancedBtn = wrapper.findAll('button').find(b => b.text().includes('高级查询'))
    await advancedBtn.trigger('click')
    await flush()

    expect(wrapper.emitted('advanced-open')).toHaveLength(1)
    expect(wrapper.find('.drawer-stub').attributes('data-open')).toBe('true')

    // expose 的 openAdvanced 是摘要行「显示上限」链接的入口，效果相同
    const second = await mountControls()
    second.vm.openAdvanced()
    await flush()
    expect(second.emitted('advanced-open')).toHaveLength(1)
  })

  it('limit 输入：change 夹取到 [1,1000]；blur 对 null 兜底发 50', async () => {
    const wrapper = await mountControls({ limitValue: 2000 })

    // 第一个 input-number 是 Limit
    inputNumbers(wrapper)[0].vm.$emit('change', 2000)
    await flush()
    expect(wrapper.emitted('limit-change')[0]).toEqual([1000])

    inputNumbers(wrapper)[0].vm.$emit('change', 0)
    await flush()
    expect(wrapper.emitted('limit-change')[1]).toEqual([1])

    inputNumbers(wrapper)[0].vm.$emit('change', NaN)
    await flush()
    expect(wrapper.emitted('limit-change')).toHaveLength(2)

    // blur 兜底：父组件显式传 null（Vue 不会用默认值 100 顶掉 null）
    const nullLimit = await mountControls({ limitValue: null })
    inputNumbers(nullLimit)[0].vm.$emit('blur')
    await flush()
    expect(nullLimit.emitted('limit-change')[0]).toEqual([50])
  })

  it('resetToken 变化：重置全部条件并清空实体/边类型选择', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)
    await chooseSelect(wrapper, '.query-type-select', 'relation')
    await chooseSelect(wrapper, '.entity-select', '投资')
    await flush()

    wrapper.setProps({ resetToken: 1 })
    await flush()

    expect(wrapper.emitted('entity-type-change').at(-1)).toEqual([[]])
    expect(wrapper.emitted('edge-type-change').at(-1)).toEqual([[]])
  })

  it('抽屉「重置」：清空条件并把 Limit 恢复到页面缺省 50（不自动查询）', async () => {
    const wrapper = await mountControls({ limitValue: 300 })
    await openAdvanced(wrapper)

    const resetBtn = wrapper.findAll('button').find(b => b.text().includes('重置'))
    expect(resetBtn, '找不到抽屉「重置」按钮').toBeTruthy()
    await resetBtn.trigger('click')
    await flush()

    expect(wrapper.emitted('limit-change')[0]).toEqual([50])
    expect(wrapper.emitted('execute-query')).toBeUndefined()
  })

  it('entity 查询：属性条件转 filters（数值转换），快速筛选类型去重后合并到最前', async () => {
    const wrapper = await mountControls({ selectedEntityTypes: ['Scene', 'Ghost'] })
    await openAdvanced(wrapper)

    await chooseSelect(wrapper, '.entity-select', 'Scene')
    await chooseSelect(wrapper, '.condition-select', 'level') // INTEGER → 运算符自动落 eq
    await wrapper.find('.col-value input').setValue('5')
    await flush()

    await queryButton(wrapper).trigger('click')
    await flush()

    const payload = wrapper.emitted('execute-query')[0][0]
    expect(payload.queryType).toBe('entity')
    expect(payload.direction).toBeUndefined()
    // 高级条件已覆盖 Scene → 快速筛选只剩 Ghost，且排在最前
    expect(payload.filters).toEqual([
      { entity_type: ['Ghost'], properties: {} },
      { entity_type: ['Scene'], properties: { level: { op: 'eq', value: 5 } } }
    ])
    // 下发后抽屉收起
    expect(wrapper.find('.drawer-stub').attributes('data-open')).toBe('false')
  })

  it('entity 查询：两条条件合成 complex_filter，「满足任意」时 op 为 or', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)

    await chooseSelect(wrapper, '.entity-select', 'Scene')
    const conditionSelects = () => selectAll(wrapper, '.condition-select')
    await chooseAt(wrapper, conditionSelects()[0], 'level') // INTEGER
    await chooseAt(wrapper, conditionSelects()[1], 'between')
    await wrapper.find('.col-value input').setValue('[1,2]')
    await flush()

    // 第二条：点「添加属性条件」加行，再选 name + in
    await wrapper.find('.condition-footer .add-condition-row').trigger('click')
    await flush()
    await chooseAt(wrapper, conditionSelects()[2], 'name') // STRING
    await chooseAt(wrapper, conditionSelects()[3], 'in')
    await wrapper.findAll('.col-value input')[1].setValue('["芯片","传感器"]')
    await flush()

    // and（默认）
    await queryButton(wrapper).trigger('click')
    await flush()
    let payload = wrapper.emitted('execute-query')[0][0]
    expect(payload.filters[0].properties.complex_filter.op).toBe('and')
    expect(payload.filters[0].properties.complex_filter.value).toEqual([
      { property: 'level', op: 'between', value: [1, 2] },
      { property: 'name', op: 'in', value: ['芯片', '传感器'] }
    ])

    // or：radio 组替身写回 conditionCombine（同步所有条件组）
    const radioGroup = wrapper.findComponent(ElRadioGroupStub)
    radioGroup.vm.$emit('update:modelValue', 'or')
    await flush()
    await queryButton(wrapper).trigger('click')
    await flush()
    payload = wrapper.emitted('execute-query')[1][0]
    expect(payload.filters[0].properties.complex_filter.op).toBe('or')
  })

  it('relation 查询：filters 落在 edge_type / properties 键上', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)

    await chooseSelect(wrapper, '.query-type-select', 'relation')
    await flush()
    await chooseSelect(wrapper, '.entity-select', '投资')
    await chooseSelect(wrapper, '.condition-select', 'amount')
    await wrapper.find('.col-value input').setValue('99.5')
    await flush()

    await queryButton(wrapper).trigger('click')
    await flush()

    const payload = wrapper.emitted('execute-query')[0][0]
    expect(payload.queryType).toBe('relation')
    expect(payload.filters).toEqual([
      { edge_type: ['投资'], properties: { amount: { op: 'eq', value: 99.5 } } }
    ])
  })

  it('subgraph 查询：起点/途径实体/途径关系三段 filters + 深度与方向', async () => {
    const wrapper = await mountControls({ depthValue: 3 })
    await openAdvanced(wrapper)

    await chooseSelect(wrapper, '.query-type-select', 'subgraph')
    await flush()

    // 深度 input-number（抽屉里第二个）
    inputNumbers(wrapper)[1].vm.$emit('change', 4)
    await flush()
    expect(wrapper.emitted('depth-change')[0]).toEqual([4])

    // 方向（advanced-param-row 里的 el-select）
    const directionSelect = wrapper.find('.advanced-param-row').findAllComponents(ElSelectStub)[0]
    directionSelect.vm.$emit('update:modelValue', 'in')
    await flush()

    // 子图默认各有 1 个起点组 / 途径实体组 / 途径关系组，类型下拉都是 .entity-select
    const entitySelects = selectAll(wrapper, '.entity-select')
    expect(entitySelects).toHaveLength(3)
    await chooseAt(wrapper, entitySelects[0], 'Scene')
    await chooseAt(wrapper, entitySelects[1], 'Resource')
    await chooseAt(wrapper, entitySelects[2], '投资')

    // 属性下拉（.condition-select）：每行「属性 + 运算符」成对，取偶数位
    const propSelects = selectAll(wrapper, '.condition-select')
    await chooseAt(wrapper, propSelects[0], 'level')
    await chooseAt(wrapper, propSelects[2], 'tag')
    await chooseAt(wrapper, propSelects[4], 'amount')

    const values = wrapper.findAll('.col-value input')
    await values[0].setValue('5')
    await values[1].setValue('%芯片%')
    await values[2].setValue('10')
    await flush()

    await queryButton(wrapper).trigger('click')
    await flush()

    const payload = wrapper.emitted('execute-query')[0][0]
    expect(payload.queryType).toBe('subgraph')
    expect(payload.direction).toBe('in')
    expect(payload.filters).toEqual([
      { start_entity_type: ['Scene'], start_entity_properties: { level: { op: 'eq', value: 5 } } },
      { path_entity_type: ['Resource'], path_entity_properties: { tag: { op: 'eq', value: '%芯片%' } } },
      { path_edge_type: ['投资'], path_edge_properties: { amount: { op: 'eq', value: 10 } } }
    ])
  })

  it('subgraph 条件行：加行受属性上限守卫（0 属性时只弹 warning）', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)
    await chooseSelect(wrapper, '.query-type-select', 'subgraph')
    await chooseSelect(wrapper, '.entity-select', 'Ghost') // Ghost 无属性表
    await flush()

    const addBtns = wrapper.findAll('.condition-footer button')
    await addBtns[0].trigger('click')
    await flush()

    expect(warningSpy).toHaveBeenCalledTimes(1)
    expect(warningSpy.mock.calls[0][0]).toEqual(
      expect.objectContaining({ type: 'warning', message: '属性条件个数不能超过可选属性总数的两倍' })
    )
  })

  it('subgraph 组：途径实体组与途径关系组可增删（至少保留一组）', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)
    await chooseSelect(wrapper, '.query-type-select', 'subgraph')
    await flush()

    const actions = () => wrapper.findAll('.entity-editor-actions button')
    // 布局：[途径实体组 add, 途径实体组 remove, 途径关系组 add, 途径关系组 remove]
    expect(actions()).toHaveLength(4)
    const groupCountBefore = wrapper.findAll('.entity-group').length

    await actions()[0].trigger('click') // 加一个途径实体组
    await flush()
    expect(wrapper.findAll('.entity-group').length).toBe(groupCountBefore + 1)

    await actions()[1].trigger('click') // 删掉新加的途径实体组
    await flush()
    expect(wrapper.findAll('.entity-group').length).toBe(groupCountBefore)

    // 只剩一组时删除按钮是禁用的（isOnly 守卫）
    expect(actions()[1].attributes('disabled')).toBeDefined()
  })

  it('运算符清空（clearable）：错误提示同步清掉', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)
    await chooseSelect(wrapper, '.entity-select', 'Scene')
    await chooseSelect(wrapper, '.condition-select', 'level')
    const valueInput = wrapper.find('.col-value input')
    await valueInput.setValue('abc')
    await flush()

    // gt 运算符 + 非数字 → 错误
    const operatorSelect = selectAll(wrapper, '.condition-select')[1]
    operatorSelect.vm.$emit('update:modelValue', 'gt')
    operatorSelect.vm.$emit('change', 'gt')
    await flush()
    expect(wrapper.find('.error-msg').exists()).toBe(true)

    // 清空运算符 → 错误清掉
    operatorSelect.vm.$emit('update:modelValue', '')
    operatorSelect.vm.$emit('change', '')
    await flush()
    expect(wrapper.find('.error-msg').exists()).toBe(false)
  })
})

/** 按 selector 收集全部命中的 el-select 替身 */
function selectAll (wrapper, selector) {
  const elements = new Set(wrapper.findAll(selector).map(n => n.element))
  return wrapper.findAllComponents(ElSelectStub).filter(c => elements.has(c.element))
}

/** 对已定位的替身发射一次「选值」（v-model 写回 + change 回调） */
async function chooseAt (wrapper, select, value) {
  expect(select, '命中的 el-select 不存在').toBeTruthy()
  select.vm.$emit('update:modelValue', value)
  select.vm.$emit('change', value)
  await flush()
}
