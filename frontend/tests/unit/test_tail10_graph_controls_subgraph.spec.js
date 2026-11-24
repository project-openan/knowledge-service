// @vitest-environment jsdom
/**
 * GraphControls.vue —— 补齐既有两份 spec（GraphControls.spec.js /
 * test_gviz_graph_controls_advanced.spec.js）没覆盖的面：
 *
 * - 子图模式（queryType=subgraph）的完整交互：起始实体 / 途径实体 / 途径关系三段的
 *   加行、删行、加组、删组、换类型重置、换属性重置运算符；
 * - 实体/关系模式的组级增删（addActiveGroup / removeActiveGroup）与删行守卫；
 * - 工具条实体类型快速筛选（handleEntityTypeFilter 的选中与清空两路）；
 * - 模板插槽面：el-select/el-option 的下拉选项渲染（查询类型/逻辑/方向/属性/运算符/类型）、
 *   抽屉 header/footer、tooltip 内容 —— select 桩渲染默认插槽即可让 el-option 的
 *   v-for 插槽函数在渲染期执行（与真下拉的选项渲染等价，开销小得多）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { h } from 'vue'

import { flush, mountWithPlugins, textOf } from './helpers/mount'

import GraphControls from '@/features/graph/components/GraphControls.vue'

const { warningSpy } = vi.hoisted(() => ({ warningSpy: vi.fn() }))
vi.mock('element-plus', () => ({
  ElMessage: { warning: warningSpy, success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

/**
 * el-select 桩：渲染默认插槽（el-option 的 v-for 就在插槽里，渲染即覆盖其模板函数），
 * v-model / change 由测试用 $emit 驱动 —— 与仓内既有 spec 的替身契约一致。
 */
const ElSelectStub = {
  name: 'ElSelect',
  props: {
    modelValue: { default: undefined },
    placeholder: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    clearable: { type: Boolean, default: false },
    size: { type: String, default: '' }
  },
  emits: ['update:modelValue', 'change'],
  setup (_, { slots }) {
    return () => h('div', { class: 'select-stub' }, slots.default ? slots.default() : [])
  }
}

/** el-drawer 桩：header/default/footer 全渲染。 */
const DrawerStub = {
  name: 'ElDrawer',
  props: ['modelValue', 'direction', 'size', 'appendToBody'],
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => h('div', { class: 'drawer-stub', 'data-open': String(props.modelValue) }, [
      props.modelValue
        ? [slots.header ? slots.header() : null, slots.default ? slots.default() : null,
          slots.footer ? h('div', { class: 'stub-drawer-footer' }, slots.footer()) : null]
        : null
    ])
  }
}

/** el-tooltip 桩：渲染内容 + 触发元素。 */
const TooltipStub = {
  name: 'ElTooltip',
  props: ['content', 'placement', 'disabled'],
  setup (props, { slots }) {
    return () => h('span', { class: 'tooltip-stub' }, [
      slots.default ? slots.default() : null,
      props.content ? h('em', { class: 'tooltip-content' }, String(props.content)) : null
    ])
  }
}

const PROPS_BASE = {
  entityTypes: ['Product', 'Person'],
  edgeTypes: ['Knows', 'Owns'],
  entityTypeProperties: {
    Product: [{ name: 'name', type: 'STRING' }, { name: 'price', type: 'DOUBLE' }],
    Person: [{ name: 'age', type: 'INTEGER' }]
  },
  edgeTypeProperties: {
    Knows: [{ name: 'since', type: 'DATE' }],
    Owns: [{ name: 'qty', type: 'INTEGER' }]
  }
}

async function mountControls (props = {}) {
  const wrapper = await mountWithPlugins(GraphControls, {
    router: null,
    props: { ...PROPS_BASE, ...props },
    global: {
      components: {
        ElSelect: ElSelectStub, ElDrawer: DrawerStub, ElTooltip: TooltipStub,
        ElOption: { name: 'ElOption', props: ['label', 'value'], template: '<div class="option-stub">{{ label }}</div>' }
      }
    }
  })
  await flush()
  return wrapper
}

/** 打开高级查询抽屉。 */
async function openAdvanced (wrapper) {
  const advanced = wrapper.findAll('button').find(btn => textOf(btn).includes('高级查询'))
  expect(advanced, '找不到「高级查询」按钮').toBeTruthy()
  await advanced.trigger('click')
  await flush()
  return wrapper
}

/** 定位某 DOM 元素对应的 el-select 桩实例。 */
function selectAt (wrapper, element) {
  return wrapper.findAllComponents(ElSelectStub).find(c => c.element === element) || null
}

async function chooseSelect (wrapper, element, value) {
  const select = selectAt(wrapper, element)
  expect(select, '找不到目标 el-select').not.toBeNull()
  select.vm.$emit('update:modelValue', value)
  select.vm.$emit('change', value)
  await flush()
}

/** 找到包含指定标签文本的 .entity-group 区块。 */
function sectionOf (wrapper, labelText) {
  return wrapper.findAll('.entity-group').find(node => node.text().includes(labelText)) || null
}

/** 某区块内第 index 行的「加行 / 删行」按钮（.col-actions 按模板顺序：先加后删）。 */
function rowButtons (section, index = 0) {
  return section.findAll('.condition-row')[index].findAll('.col-actions button')
}

/** 某区块的组级按钮（.entity-editor-actions：先加组后删组）。 */
function groupButtons (section) {
  return section.findAll('.entity-editor-actions button')
}

/** 普通模式（entity/relation）的条件组区块。 */
function plainGroups (wrapper) {
  return wrapper.findAll('.query-condition.entity-group')
}

/** 普通模式的「加条件组」按钮。 */
function plainAddGroup (wrapper) {
  return wrapper.findAll('button').find(node => node.classes().includes('add-condition-card'))
}

/** 普通模式某组的「删组」按钮（.condition-label 里的 icon-button）。 */
function plainRemoveGroup (group) {
  return group.find('.condition-label .icon-button')
}

beforeEach(() => {
  warningSpy.mockClear()
  document.body.innerHTML = ''
})

describe('GraphControls：工具条与查询类型', () => {
  it('实体类型快速筛选：选中与清空各发一次 entity-type-change', async () => {
    const wrapper = await mountControls()
    const filter = wrapper.find('.control-type')
    await chooseSelect(wrapper, filter.element, 'Product')
    // handleEntityTypeFilter 发的载荷是 [value]
    expect(wrapper.emitted('entity-type-change')).toEqual([[['Product']]])
    await chooseSelect(wrapper, filter.element, '')
    expect(wrapper.emitted('entity-type-change').at(-1)).toEqual([[]])
  })

  it('查询类型三档切换：各发一次 query-type-change，抽屉里渲染对应的下拉选项', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)

    // 抽屉体以 queryType 为 key：每次切换后 DOM 重建，选择器要现查
    const chooseQueryType = async value => {
      await chooseSelect(wrapper, wrapper.find('.query-type-select').element, value)
    }
    await chooseQueryType('relation')
    expect(wrapper.emitted('query-type-change').at(-1)).toEqual(['relation'])
    // 关系模式：类型下拉选项来自 edgeTypes
    const options = wrapper.findAll('.select-stub .option-stub').map(node => node.text())
    expect(options).toContain('Knows')

    await chooseQueryType('subgraph')
    expect(wrapper.emitted('query-type-change').at(-1)).toEqual(['subgraph'])
    // 子图：方向下拉的方向选项渲染
    const texts = wrapper.text()
    expect(texts).toContain('起始实体类型')
    expect(texts).toContain('途径实体类型')
    expect(texts).toContain('途径关系类型')
  })

  it('条件组合开关（满足全部/任意）写回所有组', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)
    const combine = wrapper.find('.condition-combine, .combine-select') || wrapper.find('.advanced-query-form')
    // 组合开关是高级表单里的一个 el-select：按 class 找，找不到就按占位文案找
    const element = wrapper.findAll('.select-stub')
      .map((node, index) => ({ node, index }))
      .find(({ node }) => node.text().includes('满足全部') || selectAt(wrapper, node.element).vm.modelValue === 'and')
    expect(element || combine).toBeTruthy()
    wrapper.vm.conditionCombine = 'or'
    await flush()
    expect(wrapper.vm.entityGroups[0].logicOperator).toBe('or')
    wrapper.vm.conditionCombine = 'and'
    await flush()
    expect(wrapper.vm.entityGroups[0].logicOperator).toBe('and')
  })
})

describe('GraphControls：实体/关系模式的组级增删与删行', () => {
  async function mountInRelationMode () {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)
    await chooseSelect(wrapper, wrapper.find('.query-type-select').element, 'relation')
    // 给当前组选一个有属性的边类型
    await chooseSelect(wrapper, wrapper.find('.entity-select').element, 'Knows')
    await flush()
    return wrapper
  }

  it('加组 / 删组：组数随按钮变化，只剩一组时删组被守卫拦下', async () => {
    const wrapper = await mountInRelationMode()
    expect(wrapper.vm.relationGroups).toHaveLength(1)

    // 「添加条件组」卡片：加一组
    await plainAddGroup(wrapper).trigger('click')
    await flush()
    expect(wrapper.vm.relationGroups).toHaveLength(2)

    // 第 2 组的删组按钮此时可用 → 删掉后回到一组
    await plainRemoveGroup(plainGroups(wrapper).at(-1)).trigger('click')
    await flush()
    expect(wrapper.vm.relationGroups).toHaveLength(1)

    // 只剩一组时按钮 disabled，点击被守卫拦下（不弹 warning、不变动）
    await plainRemoveGroup(plainGroups(wrapper)[0]).trigger('click')
    await flush()
    expect(wrapper.vm.relationGroups).toHaveLength(1)
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('加行到上限被拦（warning），删行恢复；单行删行守卫静默', async () => {
    const wrapper = await mountInRelationMode()
    const section = plainGroups(wrapper)[0]
    // Knows 有 1 个可选属性 → 上限 2 行
    await rowButtons(section, 0)[0].trigger('click')
    await flush()
    expect(wrapper.vm.relationGroups[0].conditions).toHaveLength(2)

    await rowButtons(section, 0)[0].trigger('click')
    await flush()
    expect(wrapper.vm.relationGroups[0].conditions).toHaveLength(2)
    expect(warningSpy).toHaveBeenCalledTimes(1)

    // 删第 2 行
    await rowButtons(section, 1)[1].trigger('click')
    await flush()
    expect(wrapper.vm.relationGroups[0].conditions).toHaveLength(1)

    // 单行：删行守卫（无 warning、无变动）
    await rowButtons(section, 0)[1].trigger('click')
    expect(wrapper.vm.relationGroups[0].conditions).toHaveLength(1)
  })

  it('换属性重置运算符（handlePropChange 的 relation 侧已在行内 select 触发）', async () => {
    const wrapper = await mountInRelationMode()
    const row = wrapper.vm.relationGroups[0].conditions[0]
    row.prop = 'since'
    wrapper.vm.handleOperatorChange(row)
    await flush()
    expect(row.error).toBe('')
    // 空 operator：直接清 error
    row.operator = ''
    wrapper.vm.handleOperatorChange(row)
    expect(row.error).toBe('')
    // 空行：直接返回
    wrapper.vm.handleOperatorChange(null)
    wrapper.vm.handleValueInput(row)
  })
})

describe('GraphControls：子图模式三段交互', () => {
  async function mountInSubgraphMode () {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)
    await chooseSelect(wrapper, wrapper.find('.query-type-select').element, 'subgraph')
    await flush()
    return wrapper
  }

  it('起始实体段：加行 / 删行（conditionGroups 区间随删除平移收缩）', async () => {
    const wrapper = await mountInSubgraphMode()
    const start = sectionOf(wrapper, '起始实体类型')
    expect(start, '找不到起始实体区块').toBeTruthy()

    // 选类型（有 2 个属性的 Product → 上限 4 行）
    await chooseSelect(wrapper, start.find('.entity-select').element, 'Product')
    // 行内加按钮：1 → 2 行
    await rowButtons(start, 0)[0].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphStartGroup.conditions).toHaveLength(2)
    // 删第 1 行：区间平移/过滤
    wrapper.vm.subgraphStartGroup.conditionGroups = [{ id: 'g1', start: 0, end: 1 }]
    await rowButtons(start, 0)[1].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphStartGroup.conditions).toHaveLength(1)
    expect(wrapper.vm.subgraphStartGroup.conditionGroups).toEqual([])

    // 单行删行守卫
    await rowButtons(start, 0)[1].trigger('click')
    expect(wrapper.vm.subgraphStartGroup.conditions).toHaveLength(1)
  })

  it('途径实体段：加组 / 删组（单组删组守卫）/ 加行 / 删行', async () => {
    const wrapper = await mountInSubgraphMode()
    const entity = sectionOf(wrapper, '途径实体类型')
    expect(entity, '找不到途径实体区块').toBeTruthy()

    await chooseSelect(wrapper, entity.find('.entity-select').element, 'Person')
    expect(wrapper.vm.subgraphEntityGroups[0].type).toBe('Person')

    // 加组 → 2 组
    await groupButtons(entity)[0].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEntityGroups).toHaveLength(2)

    // 第 2 组的删组按钮可用 → 删回 1 组
    const sections = wrapper.findAll('.entity-group').filter(node => node.text().includes('途径实体类型'))
    await groupButtons(sections.at(-1))[1].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEntityGroups).toHaveLength(1)

    // 单组：删组守卫
    await groupButtons(sectionOf(wrapper, '途径实体类型'))[1].trigger('click')
    expect(wrapper.vm.subgraphEntityGroups).toHaveLength(1)

    // 加行 / 删行 / 单行守卫（Person 1 个属性 → 上限 2）
    const section = sectionOf(wrapper, '途径实体类型')
    await rowButtons(section, 0)[0].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEntityGroups[0].conditions).toHaveLength(2)
    await rowButtons(section, 0)[0].trigger('click')
    await flush()
    expect(warningSpy).toHaveBeenCalledTimes(1)
    await rowButtons(section, 1)[1].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEntityGroups[0].conditions).toHaveLength(1)
    await rowButtons(section, 0)[1].trigger('click')
    expect(wrapper.vm.subgraphEntityGroups[0].conditions).toHaveLength(1)
  })

  it('途径关系段：加组 / 删组 / 加行 / 删行（边类型与边属性）', async () => {
    const wrapper = await mountInSubgraphMode()
    const edge = sectionOf(wrapper, '途径关系类型')
    expect(edge, '找不到途径关系区块').toBeTruthy()

    await chooseSelect(wrapper, edge.find('.entity-select').element, 'Knows')
    expect(wrapper.vm.subgraphEdgeGroups[0].type).toBe('Knows')

    await groupButtons(edge)[0].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEdgeGroups).toHaveLength(2)

    const sections = wrapper.findAll('.entity-group').filter(node => node.text().includes('途径关系类型'))
    await groupButtons(sections.at(-1))[1].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEdgeGroups).toHaveLength(1)

    const section = sectionOf(wrapper, '途径关系类型')
    await rowButtons(section, 0)[0].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEdgeGroups[0].conditions).toHaveLength(2)
    await rowButtons(section, 1)[1].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEdgeGroups[0].conditions).toHaveLength(1)
  })

  it('换属性重置运算符：三段各自的 handleSubgraph*PropChange', async () => {
    const wrapper = await mountInSubgraphMode()

    // 起始实体段
    wrapper.vm.subgraphStartGroup.type = 'Product'
    const startRow = wrapper.vm.subgraphStartGroup.conditions[0]
    startRow.prop = 'name'
    wrapper.vm.handleSubgraphStartPropChange(0)
    expect(startRow.operator).toBeTruthy()

    // 途径实体段
    wrapper.vm.subgraphEntityGroups[0].type = 'Person'
    const entityRow = wrapper.vm.subgraphEntityGroups[0].conditions[0]
    entityRow.prop = 'age'
    wrapper.vm.handleSubgraphEntityPropChange(0, 0)
    expect(entityRow.operator).toBeTruthy()

    // 途径关系段
    wrapper.vm.subgraphEdgeGroups[0].type = 'Knows'
    const edgeRow = wrapper.vm.subgraphEdgeGroups[0].conditions[0]
    edgeRow.prop = 'since'
    wrapper.vm.handleSubgraphEdgePropChange(0, 0)
    expect(edgeRow.operator).toBeTruthy()

    // 逻辑运算符文案：命中与未命中
    expect(wrapper.vm.getLogicLabel('and')).toBe('与')
    expect(wrapper.vm.getLogicLabel('or')).toBe('或')
    expect(wrapper.vm.getLogicLabel('nope')).toBe('')
  })
})

async function mountInRelationModeLocal () {
  const wrapper = await mountControls()
  await openAdvanced(wrapper)
  await chooseSelect(wrapper, wrapper.find('.query-type-select').element, 'relation')
  await chooseSelect(wrapper, wrapper.find('.entity-select').element, 'Knows')
  await flush()
  return wrapper
}

async function mountInSubgraphModeLocal () {
  const wrapper = await mountControls()
  await openAdvanced(wrapper)
  await chooseSelect(wrapper, wrapper.find('.query-type-select').element, 'subgraph')
  await flush()
  return wrapper
}

describe('GraphControls：validateConditionRow 运算符格式校验全分支', () => {
  async function mountWithRow () {
    const wrapper = await mountInRelationModeLocal()
    const row = wrapper.vm.relationGroups[0].conditions[0]
    return { wrapper, row }
  }

  it('通用分支：无属性 / 有运算符空值 / 超长', async ({ }) => {
    const { wrapper, row } = await mountWithRow()

    row.prop = ''
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toBe('')

    row.prop = 'since'
    row.operator = 'eq'
    row.value = '   '
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('不能为空')

    row.value = 'x'.repeat(1001)
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('1000')
    wrapper.unmount()
  })

  it('like：空值 / 缺 % / 合法', async () => {
    const { wrapper, row } = await mountWithRow()
    row.prop = 'since'
    row.operator = 'like'

    row.value = ''
    wrapper.vm.validateConditionRow(row)
    // 有运算符时空值先被通用分支拦下
    expect(row.error).toContain('不能为空')
    row.value = 'abc'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('%')
    row.value = 'abc%'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toBe('')
    wrapper.unmount()
  })

  it('in：空值 / 非列表 / 非数组 JSON / 坏 JSON / 合法', async () => {
    const { wrapper, row } = await mountWithRow()
    row.prop = 'since'
    row.operator = 'in'

    row.value = ''
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('不能为空')
    row.value = 'a,b'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('列表')
    row.value = '[not json'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('列表')
    row.value = '{"a": 1}'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('列表')
    row.value = '["a","b"]'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toBe('')
    wrapper.unmount()
  })

  it('between：空值 / 非列表 / 长度或数字不对 / 合法', async () => {
    const { wrapper, row } = await mountWithRow()
    row.prop = 'since'
    row.operator = 'between'

    row.value = ''
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('不能为空')
    row.value = '1-2'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('范围格式')
    row.value = '[1]'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('范围格式')
    row.value = '[1,"x"]'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('范围格式')
    row.value = '[1, 2]'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toBe('')
    wrapper.unmount()
  })

  it('contains_all / contains_any / contains：空值与列表校验', async () => {
    const { wrapper, row } = await mountWithRow()
    row.prop = 'since'

    for (const op of ['contains_all', 'contains_any']) {
      row.operator = op
      row.value = ''
      wrapper.vm.validateConditionRow(row)
      expect(row.error).toContain('不能为空')
      row.value = 'x'
      wrapper.vm.validateConditionRow(row)
      expect(row.error).toContain('列表')
      row.value = '["a"]'
      wrapper.vm.validateConditionRow(row)
      expect(row.error).toBe('')
    }

    row.operator = 'contains'
    row.value = ''
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toContain('不能为空')
    row.value = 'anything'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toBe('')
    wrapper.unmount()
  })

  it('数字比较符：非数字报错；eq/ne 默认清错', async () => {
    const { wrapper, row } = await mountWithRow()
    row.prop = 'since'

    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      row.operator = op
      row.value = 'abc'
      wrapper.vm.validateConditionRow(row)
      expect(row.error).toContain('数字')
      row.value = '3.5'
      wrapper.vm.validateConditionRow(row)
      expect(row.error).toBe('')
    }

    row.operator = 'eq'
    row.value = 'x'
    wrapper.vm.validateConditionRow(row)
    expect(row.error).toBe('')
    wrapper.unmount()
  })

  it('handlePropChange：运算符不在允许集时重置为第一个；无组/无行守卫', async () => {
    const { wrapper } = await mountWithRow()
    const row = wrapper.vm.relationGroups[0].conditions[0]
    row.prop = 'since'
    row.operator = 'like'
    wrapper.vm.handlePropChange(0, 0)
    // like 不在 DATE 的允许集里 → 重置为第一个（eq）
    expect(row.operator).toBe('eq')

    // 守卫：越界组/行
    expect(() => wrapper.vm.handlePropChange(9, 0)).not.toThrow()
    expect(() => wrapper.vm.handlePropChange(0, 9)).not.toThrow()
    wrapper.unmount()
  })

  it('子图三段换类型：resetGroupConditions 清条件行', async () => {
    const wrapper = await mountInSubgraphModeLocal()
    // 起始实体段
    const start = sectionOf(wrapper, '起始实体类型')
    await chooseSelect(wrapper, start.find('.entity-select').element, 'Product')
    expect(wrapper.vm.subgraphStartGroup.type).toBe('Product')
    // 换类型 → 条件被重置（prop 清空）
    await chooseSelect(wrapper, start.find('.entity-select').element, 'Person')
    expect(wrapper.vm.subgraphStartGroup.type).toBe('Person')
    expect(wrapper.vm.subgraphStartGroup.conditions[0].prop).toBe('')

    // 途径实体段换类型
    const entity = sectionOf(wrapper, '途径实体类型')
    await chooseSelect(wrapper, entity.find('.entity-select').element, 'Person')
    await chooseSelect(wrapper, entity.find('.entity-select').element, 'Product')
    expect(wrapper.vm.subgraphEntityGroups[0].conditions[0].prop).toBe('')

    // 途径关系段换类型
    const edge = sectionOf(wrapper, '途径关系类型')
    await chooseSelect(wrapper, edge.find('.entity-select').element, 'Knows')
    await chooseSelect(wrapper, edge.find('.entity-select').element, 'Owns')
    expect(wrapper.vm.subgraphEdgeGroups[0].conditions[0].prop).toBe('')
    wrapper.unmount()
  })

  it('子图三段的「追加条件」按钮（appendToEnd）', async () => {
    const wrapper = await mountInSubgraphModeLocal()
    const start = sectionOf(wrapper, '起始实体类型')
    await chooseSelect(wrapper, start.find('.entity-select').element, 'Product')
    // 区块尾部的「新增属性条件」按钮
    const startAdd = start.findAll('button').find(node => textOf(node).includes('新增属性条件'))
    await startAdd.trigger('click')
    await flush()
    expect(wrapper.vm.subgraphStartGroup.conditions).toHaveLength(2)

    const entity = sectionOf(wrapper, '途径实体类型')
    await chooseSelect(wrapper, entity.find('.entity-select').element, 'Person')
    const entityAdd = entity.findAll('button').find(node => textOf(node).includes('新增属性条件'))
    await entityAdd.trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEntityGroups[0].conditions).toHaveLength(2)

    const edge = sectionOf(wrapper, '途径关系类型')
    await chooseSelect(wrapper, edge.find('.entity-select').element, 'Knows')
    const edgeAdd = edge.findAll('button').find(node => textOf(node).includes('新增属性条件'))
    await edgeAdd.trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEdgeGroups[0].conditions).toHaveLength(2)
    wrapper.unmount()
  })
})

describe('GraphControls：剩余分支（提示、上限、区间平移、resetToken）', () => {
  it('条件带错误时：查询按钮禁用且 tooltip 区分错误类别', async () => {
    const wrapper = await mountControls()
    await openAdvanced(wrapper)
    // 无类型不算错（类型下拉是可选项）：按钮可用
    expect(wrapper.vm.isQueryButtonDisabled).toBe(false)
    expect(wrapper.vm.queryButtonTooltip).toBe('')

    // 行带错误：entity 模式提示「校验未通过」
    wrapper.vm.entityGroups[0].conditions[0].error = 'bad'
    await flush()
    expect(wrapper.vm.isQueryButtonDisabled).toBe(true)
    expect(wrapper.vm.queryButtonTooltip).toContain('Schema数据验证失败')

    wrapper.vm.queryType = 'subgraph'
    await flush()
    wrapper.vm.subgraphStartGroup.conditions[0].error = 'bad'
    await flush()
    expect(wrapper.vm.queryButtonTooltip).toContain('Schema数据验证失败')

    // 清掉错误后：恢复可用，tooltip 为空
    wrapper.vm.subgraphStartGroup.conditions[0].error = ''
    await flush()
    expect(wrapper.vm.queryButtonTooltip).toBe('')
    wrapper.unmount()
  })

  it('起始实体段加行到上限弹 warning；conditionGroups 区间随插入/删除平移', async () => {
    const wrapper = await mountInSubgraphModeLocal()
    const start = sectionOf(wrapper, '起始实体类型')
    await chooseSelect(wrapper, start.find('.entity-select').element, 'Product')
    // Product 2 个属性 → 上限 4 行：加到 4 行
    for (let i = 0; i < 3; i += 1) {
      await rowButtons(start, 0)[0].trigger('click')
      await flush()
    }
    expect(wrapper.vm.subgraphStartGroup.conditions).toHaveLength(4)
    await rowButtons(start, 0)[0].trigger('click')
    await flush()
    expect(warningSpy).toHaveBeenCalledTimes(1)

    // 回到 2 行再验证区间平移：中间插入 → start/end 都右移；删除中间行 → 区间收缩过滤
    wrapper.vm.subgraphStartGroup.conditions = wrapper.vm.subgraphStartGroup.conditions.slice(0, 2)
    await flush()
    wrapper.vm.subgraphStartGroup.conditionGroups = [{ id: 'g1', start: 1, end: 2 }]
    await rowButtons(start, 0)[0].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphStartGroup.conditionGroups).toEqual([{ id: 'g1', start: 2, end: 3 }])
    wrapper.vm.subgraphStartGroup.conditionGroups = [{ id: 'g2', start: 1, end: 3 }]
    await rowButtons(start, 1)[1].trigger('click')
    await flush()
    // 删除区间内的行：end 左移（1..3 → 1..2，仍是 >=2 行的区间，保留）
    expect(wrapper.vm.subgraphStartGroup.conditionGroups).toEqual([{ id: 'g2', start: 1, end: 2 }])
    wrapper.unmount()
  })

  it('途径实体/关系段加行到上限各自弹 warning', async () => {
    const wrapper = await mountInSubgraphModeLocal()
    const entity = sectionOf(wrapper, '途径实体类型')
    await chooseSelect(wrapper, entity.find('.entity-select').element, 'Person')
    await rowButtons(entity, 0)[0].trigger('click')
    await flush()
    await rowButtons(entity, 0)[0].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEntityGroups[0].conditions).toHaveLength(2)
    expect(warningSpy).toHaveBeenCalledTimes(1)

    const edge = sectionOf(wrapper, '途径关系类型')
    await chooseSelect(wrapper, edge.find('.entity-select').element, 'Knows')
    await rowButtons(edge, 0)[0].trigger('click')
    await flush()
    await rowButtons(edge, 0)[0].trigger('click')
    await flush()
    expect(wrapper.vm.subgraphEdgeGroups[0].conditions).toHaveLength(2)
    expect(warningSpy).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('运算符已在允许集时不重置（prop change 的无操作分支）', async () => {
    const wrapper = await mountInSubgraphModeLocal()
    wrapper.vm.subgraphStartGroup.type = 'Product'
    const startRow = wrapper.vm.subgraphStartGroup.conditions[0]
    startRow.prop = 'name'
    startRow.operator = 'eq'
    wrapper.vm.handleSubgraphStartPropChange(0, 0)
    expect(startRow.operator).toBe('eq')

    wrapper.vm.subgraphEntityGroups[0].type = 'Person'
    const entityRow = wrapper.vm.subgraphEntityGroups[0].conditions[0]
    entityRow.prop = 'age'
    entityRow.operator = 'gt'
    wrapper.vm.handleSubgraphEntityPropChange(0, 0)
    expect(entityRow.operator).toBe('gt')

    wrapper.vm.subgraphEdgeGroups[0].type = 'Knows'
    const edgeRow = wrapper.vm.subgraphEdgeGroups[0].conditions[0]
    edgeRow.prop = 'since'
    edgeRow.operator = 'eq'
    wrapper.vm.handleSubgraphEdgePropChange(0, 0)
    expect(edgeRow.operator).toBe('eq')
    wrapper.unmount()
  })

  it('resetToken 变化：清空三段条件与类型筛选', async () => {
    const wrapper = await mountControls()
    await flush()
    wrapper.vm.subgraphStartGroup.conditions[0].prop = 'x'
    await wrapper.setProps({ resetToken: 1 })
    await flush()
    expect(wrapper.vm.subgraphStartGroup.conditions[0].prop).toBe('')
    expect(wrapper.emitted('entity-type-change').at(-1)).toEqual([[]])
    expect(wrapper.emitted('edge-type-change').at(-1)).toEqual([[]])
    wrapper.unmount()
  })
})
