// @vitest-environment jsdom
/**
 * PropertyPanel.vue —— 真渲染 + 校验/提交两路补齐（与 test_gviz_property_panel.spec.js
 * 互补：那份用替身只测逻辑，这份把 Element Plus 表单件真渲染出来，覆盖模板插槽面）。
 *
 * el-form 用「渲染插槽 + 暴露 validate/validateField/clearValidate 间谍」的桩：
 * 真 el-form 的 validateField 在校验失败时返回 rejected promise（组件没有 catch，
 * 真跑会产生 unhandled rejection），校验器分支改由「校验器直调」用例逐条驱动。
 *
 * 钉住：
 * - 未选中 / 节点 / 关系三种形态的真渲染（el-collapse、el-tabs、el-form-item、el-radio 真件）；
 * - applyChanges 的全部分支（类名必填/超长/格式/保留字、描述必填/空白、属性名必填/
 *   格式/保留字/重复、属性描述必填/空白、关系侧同样一套、合法提交 payload）；
 * - 属性 tab 的新增/删除（含 100 上限拦截）、切 tab 触发上一页签校验；
 * - 输入事件触发的字段级校验入口（validateNodeName / validateEdgeType / 属性行字段）；
 * - resetForm；X6 节点无 getData() 时回落 .data。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { ElCollapse, ElCollapseItem } from 'element-plus/es/components/collapse/index'
import { ElFormItem } from 'element-plus/es/components/form/index'
import { ElInput } from 'element-plus/es/components/input/index'
import { ElRadio, ElRadioGroup } from 'element-plus/es/components/radio/index'
import { ElSelect, ElOption } from 'element-plus/es/components/select/index'
import { ElTabs, ElTabPane } from 'element-plus/es/components/tabs/index'
import { h } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'

import PropertyPanel from '@/features/graph/components/GraphEditor/PropertyPanel.vue'

const messageError = vi.fn()
const messageWarning = vi.fn()

/**
 * el-form 桩：渲染默认插槽（el-form-item 真件照常渲染 label 与控件），
 * 校验入口全部换成 spy —— 既让组件的 ref 调用面（validateField/clearValidate）可断言，
 * 又不引入 async-validator 的 rejected promise。
 */
function makeFormStub () {
  return {
    name: 'ElForm',
    props: { model: { type: Object, default: () => ({}) }, rules: { type: Object, default: () => ({}) } },
    setup (_, { slots, expose }) {
      const validateField = vi.fn()
      // validate 带回调调用：组件 watch 里 `formRef.validate(() => {})` 的空回调要被执行
      const validate = vi.fn(cb => { if (cb) cb(true) })
      const clearValidate = vi.fn()
      expose({ validate, validateField, clearValidate, resetFields: vi.fn() })
      return () => h('form', { class: 'panel-form-stub' }, slots.default ? slots.default() : [])
    }
  }
}

async function mountPanel ({ selectedItem, itemType } = { selectedItem: null, itemType: null }) {
  const wrapper = await mountWithPlugins(PropertyPanel, {
    router: null,
    attachTo: document.body,
    props: { selectedItem, itemType },
    global: {
      components: {
        ElCollapse, ElCollapseItem, ElFormItem, ElInput,
        ElRadio, ElRadioGroup, ElSelect, ElOption, ElTabs, ElTabPane,
        ElForm: makeFormStub()
      },
      config: {
        globalProperties: {
          $message: { error: messageError, warning: messageWarning, success: vi.fn() }
        }
      }
    }
  })
  await flush()
  return wrapper
}

const NODE_ITEM = {
  id: 'n1',
  getData: () => ({
    name: 'EntityA',
    description: '第一个实体',
    properties: [
      { name: 'tag', type: 'STRING', desc: '标签', is_primary: true },
      { name: 'score', type: 'DOUBLE', desc: '分数', is_embedding: true, is_index: true }
    ]
  })
}

function edgeItem (data, shape = 'single-arrow-edge') {
  return {
    id: 'r1',
    shape,
    getData: () => data,
    getSourceCell: () => ({ getData: () => ({ name: '源实体' }) }),
    getTargetCell: () => ({ getData: () => ({ name: '目标实体' }) })
  }
}

/** 等组件内部 nextTick + setTimeout(0) 的“新增 tab 后清校验”链落地。 */
async function settleTimers () {
  await flush()
  await new Promise(resolve => setTimeout(resolve, 10))
  await flush()
}

beforeEach(() => {
  messageError.mockClear()
  messageWarning.mockClear()
  document.body.innerHTML = ''
})

describe('PropertyPanel：真渲染（Element Plus 真件）', () => {
  it('未选中：渲染空态提示，不渲染任何表单', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.find('.panel-content').exists()).toBe(false)
    expect(wrapper.text()).toContain('请选择一个实体或关系进行配置')
  })

  it('节点面板真渲染：类名输入回填、属性 tab 页与类型下拉选项', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })

    expect(wrapper.find('.entity-config').exists()).toBe(true)
    const nameInput = wrapper.findAll('input')
      .find(node => node.attributes('placeholder') === '请输入实体类名')
    expect(nameInput.element.value).toBe('EntityA')
    expect(wrapper.find('textarea').element.value).toBe('第一个实体')

    // 两个属性页签（有名字的显示名字）
    const tabLabels = wrapper.findAll('.el-tabs__item').map(node => node.text().trim())
    expect(tabLabels).toEqual(['tag', 'score'])
    // 属性类型下拉：el-select 常驻渲染下拉内容（teleport 到 body，从 document 找）
    const optionTexts = [...document.querySelectorAll('.el-select-dropdown__item')]
      .map(node => node.textContent.trim())
    expect(optionTexts).toContain('STRING (字符串)')
    expect(optionTexts.filter(text => text.startsWith('LINK')).length).toBeGreaterThanOrEqual(4)
    // 单选组：是/否（每行两个，共三行）
    expect(wrapper.findAll('.el-radio').length).toBeGreaterThanOrEqual(6)
    // el-form-item 真件渲染 label
    expect(wrapper.text()).toContain('是否是主键')
    expect(wrapper.text()).toContain('是否向量化')
  })

  it('节点面板：无名字的属性页签显示「属性 N」占位标题', async () => {
    const wrapper = await mountPanel({
      selectedItem: { id: 'n2', getData: () => ({ name: 'B' }) },
      itemType: 'node'
    })
    const tabLabels = wrapper.findAll('.el-tabs__item').map(node => node.text().trim())
    expect(tabLabels).toEqual(['属性 1'])
  })

  it('关系面板真渲染：类型/描述/两端实体回填与关系属性页签', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({
        edge_type: 'Invests',
        edge_desc: '投资关系',
        direction: 'double',
        properties: [{ name: 'amount', type: 'DOUBLE', desc: '金额' }]
      }),
      itemType: 'edge'
    })

    expect(wrapper.find('.relationship-config').exists()).toBe(true)
    expect(wrapper.vm.edgeForm.edge_type).toBe('Invests')
    expect(wrapper.vm.edgeForm.edge_desc).toBe('投资关系')
    expect(wrapper.vm.edgeForm.direction).toBe('two-way')
    expect(wrapper.vm.edgeForm.source_entity).toBe('源实体')
    expect(wrapper.vm.edgeForm.target_entity).toBe('目标实体')
    const tabLabels = wrapper.findAll('.el-tabs__item').map(node => node.text().trim())
    expect(tabLabels).toEqual(['amount'])
    // 折叠面板标题来自 i18n
    expect(wrapper.text()).toContain('关系设置')
    expect(wrapper.text()).toContain('关系属性')
  })

  it('X6 节点没有 getData() 时回落到 .data；edge 数据为空时补一行空属性', async () => {
    const wrapper = await mountPanel({
      selectedItem: { id: 'n3', data: { name: 'PlainNode', description: 'd' } },
      itemType: 'node'
    })
    expect(wrapper.vm.nodeForm.name).toBe('PlainNode')

    const emptyEdge = await mountPanel({ selectedItem: { id: 'r2', data: null }, itemType: 'edge' })
    expect(emptyEdge.vm.edgeForm.properties).toHaveLength(1)
  })

  it('选中项从节点切到关系：折叠面板随之切换展开集合', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    expect(wrapper.vm.activeNames).toEqual(['basic', 'attributes'])

    await wrapper.setProps({ selectedItem: edgeItem({ edge_type: 'A', edge_desc: 'd' }), itemType: 'edge' })
    await flush()
    expect(wrapper.vm.activeNames).toEqual(['basic', 'edge-attributes'])
    expect(wrapper.find('.relationship-config').exists()).toBe(true)
  })
})

describe('PropertyPanel：字段级校验入口（经 el-form ref）', () => {
  it('实体类名输入触发 name 字段校验', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    const nameInput = wrapper.findAll('input')
      .find(node => node.attributes('placeholder') === '请输入实体类名')

    await nameInput.setValue('1abc')
    await flush()

    // 基础表单（第一个 el-form）的 validateField 被以 'name' 调用
    const baseForm = wrapper.findAllComponents({ name: 'ElForm' })[0]
    expect(baseForm.vm.validateField).toHaveBeenCalledWith('name')
  })

  it('关系类型输入触发 edge_type 字段校验', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Invests', edge_desc: 'd' }),
      itemType: 'edge'
    })
    const typeInput = wrapper.findAll('input')
      .find(node => node.attributes('placeholder') === '请输入关系类型')

    await typeInput.setValue('Follows')
    await flush()
    const baseForm = wrapper.findAllComponents({ name: 'ElForm' })[0]
    expect(baseForm.vm.validateField).toHaveBeenCalledWith('edge_type')
  })

  it('属性行的 name 输入触发行内校验（validateNodePropField → 该行 ref）', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    const nameInputs = wrapper.findAll('input')
      .filter(node => node.attributes('placeholder') === '请输入属性名称')
    expect(nameInputs.length).toBeGreaterThanOrEqual(2)

    await nameInputs[0].setValue('renamed_tag')
    await flush()

    const propForms = wrapper.findAllComponents({ name: 'ElForm' }).slice(1)
    expect(propForms[0].vm.validateField).toHaveBeenCalledWith('name')
  })
})

describe('PropertyPanel：属性 tab 的新增 / 删除 / 上限', () => {
  it('新增属性：追加空行并切到新页签，新页签的校验被清掉', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    const before = wrapper.vm.nodeForm.properties.length

    wrapper.vm.handlePropTabsEdit('x', 'add')
    await settleTimers()

    expect(wrapper.vm.nodeForm.properties).toHaveLength(before + 1)
    expect(wrapper.vm.activePropTabName).toBe(wrapper.vm.nodeForm.properties.at(-1).__key)
    expect(wrapper.vm.isAddingNodePropTab).toBe(false)
  })

  it('属性到达 100 上限：新增被拦下并弹 warning', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    wrapper.vm.nodeForm.properties = Array.from({ length: 100 }, (_, i) => ({
      __key: `k${i}`, name: `p${i}`, type: 'STRING', desc: 'd'
    }))
    await flush()

    wrapper.vm.handlePropTabsEdit('x', 'add')
    await flush()
    expect(wrapper.vm.nodeForm.properties).toHaveLength(100)
    expect(messageWarning).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.isAddingNodePropTab).toBe(false)
  }, 20000) // 100 个真 tab-pane（各含 19 项的类型下拉）渲染慢，放宽超时

  it('删除当前激活页签：激活态移到相邻页签，行被移除', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    expect(wrapper.vm.activePropTabName).toBe('1')

    wrapper.vm.handlePropTabsEdit('1', 'remove')
    await flush()
    expect(wrapper.vm.nodeForm.properties.map(p => p.__key)).toEqual(['2'])
    expect(wrapper.vm.activePropTabName).toBe('2')
  })

  it('删除非激活页签：激活态保持不变', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    wrapper.vm.handlePropTabsEdit('2', 'remove')
    await flush()
    expect(wrapper.vm.nodeForm.properties.map(p => p.__key)).toEqual(['1'])
    expect(wrapper.vm.activePropTabName).toBe('1')
  })

  it('关系属性 tab 同一套：新增 / 上限拦截 / 删除激活页签', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'A', edge_desc: 'd', properties: [{ name: 'a', desc: 'x' }] }),
      itemType: 'edge'
    })
    wrapper.vm.handleEdgePropTabsEdit('x', 'add')
    await settleTimers()
    expect(wrapper.vm.edgeForm.properties).toHaveLength(2)
    expect(wrapper.vm.isAddingEdgePropTab).toBe(false)

    wrapper.vm.edgeForm.properties = Array.from({ length: 100 }, (_, i) => ({
      __key: `e${i}`, name: `p${i}`, type: 'STRING', desc: 'd'
    }))
    await flush()
    wrapper.vm.handleEdgePropTabsEdit('x', 'add')
    await flush()
    expect(wrapper.vm.edgeForm.properties).toHaveLength(100)
    expect(messageWarning).toHaveBeenCalledTimes(1)

    wrapper.vm.activeEdgePropTabName = 'e0'
    await flush()
    wrapper.vm.handleEdgePropTabsEdit('e0', 'remove')
    await flush()
    expect(wrapper.vm.edgeForm.properties.map(p => p.__key)).not.toContain('e0')
    expect(wrapper.vm.activeEdgePropTabName).toBe('e1')
  }, 20000) // 同上：100 个真 tab-pane 渲染慢

  it('真渲染路径：点击「添加标签页」按钮同样走 handlePropTabsEdit', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    const newTab = wrapper.find('.el-tabs__new-tab')
    expect(newTab.exists()).toBe(true)
    await newTab.trigger('click')
    await settleTimers()
    expect(wrapper.vm.nodeForm.properties).toHaveLength(3)
  })

  it('真渲染路径：点页签头切换页签会触发旧页签校验（watch activePropTabName）', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    await wrapper.findAll('.el-tabs__item')[1].trigger('click')
    await settleTimers()
    expect(wrapper.vm.activePropTabName).toBe('2')
    // 旧页签（第 1 个属性行表单）收到 validate
    const propForms = wrapper.findAllComponents({ name: 'ElForm' }).slice(1)
    expect(propForms[0].vm.validate).toHaveBeenCalled()
  })
})

describe('PropertyPanel：applyChanges 校验全分支（节点）', () => {
  const legalProps = [{ __key: '1', name: 'a', type: 'STRING', desc: 'd', is_primary: false, is_embedding: false, is_index: false }]

  async function mountWithForm (form) {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    Object.assign(wrapper.vm.nodeForm, form)
    return wrapper
  }

  it.each([
    ['类名必填', { name: '', description: 'd', properties: legalProps }],
    ['类名超长', { name: 'A'.repeat(64), description: 'd', properties: legalProps }],
    ['类名格式', { name: '1abc', description: 'd', properties: legalProps }],
    ['类名保留字', { name: 'select', description: 'd', properties: legalProps }],
    ['描述必填', { name: 'Good', description: '', properties: legalProps }],
    ['描述全空白', { name: 'Good', description: '   ', properties: legalProps }],
    ['无属性', { name: 'Good', description: 'd', properties: [] }],
    ['属性名必填', { name: 'Good', description: 'd', properties: [{ __key: '1', name: '', desc: 'd' }] }],
    ['属性名格式', { name: 'Good', description: 'd', properties: [{ __key: '1', name: 'a b', desc: 'd' }] }],
    ['属性名保留字', { name: 'Good', description: 'd', properties: [{ __key: '1', name: 'ORDER', desc: 'd' }] }],
    ['属性名重复', { name: 'Good', description: 'd', properties: [{ __key: '1', name: 'ab', desc: 'd' }, { __key: '2', name: 'ab', desc: 'd' }] }],
    ['属性描述必填', { name: 'Good', description: 'd', properties: [{ __key: '1', name: 'a', desc: '' }] }],
    ['属性描述空白', { name: 'Good', description: 'd', properties: [{ __key: '1', name: 'a', desc: '  ' }] }],
    ['描述超长', { name: 'Good', description: 'x'.repeat(1001), properties: legalProps }]
  ])('拦截：%s', async (_label, form) => {
    const wrapper = await mountWithForm(form)
    await expect(wrapper.vm.applyChanges()).rejects.toThrow()
    expect(messageError).toHaveBeenCalled()
    expect(wrapper.emitted('update-properties')).toBeUndefined()
  })

  it('拦截：属性描述超长（propertyDescLengthInvalid）', async () => {
    const wrapper = await mountWithForm({
      name: 'Good', description: 'd',
      properties: [{ __key: '1', name: 'a', desc: 'x'.repeat(1001) }]
    })
    await expect(wrapper.vm.applyChanges()).rejects.toThrow()
    expect(messageError).toHaveBeenCalledTimes(1)
  })

  it('合法提交：payload 与后端 schema 对齐', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    const payload = await wrapper.vm.applyChanges()

    expect(messageError).not.toHaveBeenCalled()
    expect(payload.type).toBe('node')
    expect(payload.id).toBe('n1')
    expect(payload.data.name).toBe('EntityA')
    expect(payload.data.entity_type).toBe('EntityA')
    expect(payload.data.properties).toEqual([
      { name: 'tag', type: 'STRING', desc: '标签', is_primary: true, is_embedding: false, is_index: false },
      { name: 'score', type: 'DOUBLE', desc: '分数', is_primary: false, is_embedding: true, is_index: true }
    ])
    expect(wrapper.emitted('update-properties')).toHaveLength(1)
  })
})

describe('PropertyPanel：applyChanges 校验全分支（关系）', () => {
  async function mountWithForm (form) {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Invests', edge_desc: 'd' }),
      itemType: 'edge'
    })
    Object.assign(wrapper.vm.edgeForm, form)
    return wrapper
  }

  it.each([
    ['类型必填', { edge_type: '', edge_desc: 'd', properties: [{ name: 'a', desc: 'x' }] }],
    ['类型超长', { edge_type: 'R'.repeat(64), edge_desc: 'd', properties: [{ name: 'a', desc: 'x' }] }],
    ['类型格式', { edge_type: '_bad', edge_desc: 'd', properties: [{ name: 'a', desc: 'x' }] }],
    ['类型保留字', { edge_type: 'TABLE', edge_desc: 'd', properties: [{ name: 'a', desc: 'x' }] }],
    ['描述必填', { edge_type: 'Follows', edge_desc: '', properties: [] }],
    ['描述超长', { edge_type: 'Follows', edge_desc: 'x'.repeat(1001), properties: [] }],
    ['描述空白', { edge_type: 'Follows', edge_desc: '  ', properties: [] }],
    ['属性名必填', { edge_type: 'Follows', edge_desc: 'd', properties: [{ name: '', desc: 'x' }] }],
    ['属性名保留字', { edge_type: 'Follows', edge_desc: 'd', properties: [{ name: 'END', desc: 'x' }] }],
    ['属性描述必填', { edge_type: 'Follows', edge_desc: 'd', properties: [{ name: 'a', desc: '' }] }],
    ['属性描述空白', { edge_type: 'Follows', edge_desc: 'd', properties: [{ name: 'a', desc: ' ' }] }],
    ['属性名重复', { edge_type: 'Follows', edge_desc: 'd', properties: [{ name: 'ab', desc: 'x' }, { name: 'ab', desc: 'y' }] }],
    ['属性描述超长', { edge_type: 'Follows', edge_desc: 'd', properties: [{ name: 'a', desc: 'x'.repeat(1001) }] }]
  ])('拦截：%s', async (_label, form) => {
    const wrapper = await mountWithForm(form)
    await expect(wrapper.vm.applyChanges()).rejects.toThrow()
    expect(messageError).toHaveBeenCalled()
    expect(wrapper.emitted('update-properties')).toBeUndefined()
  })

  it('合法提交：方向回写 X6 模式，属性允许为空', async () => {
    const wrapper = await mountWithForm({
      edge_type: 'Follows', edge_desc: 'd', direction: 'two-way',
      source_entity: 'A', target_entity: 'B', properties: []
    })
    const payload = await wrapper.vm.applyChanges()

    expect(payload.type).toBe('edge')
    expect(payload.id).toBe('r1')
    expect(payload.data.direction).toBe('double')
    expect(payload.data.properties).toEqual([])
    expect(wrapper.emitted('update-properties')).toHaveLength(1)

    // self-loop → self
    const selfWrapper = await mountWithForm({ edge_type: 'Follows', edge_desc: 'd', direction: 'self-loop', properties: [] })
    const selfPayload = await selfWrapper.vm.applyChanges()
    expect(selfPayload.data.direction).toBe('self')
  })
})

describe('PropertyPanel：校验器直调（规则分支）', () => {
  it('validateClassType：entity / relationship 两种字段名下的所有错误分支', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    const run = value => new Promise(resolve => {
      wrapper.vm.nodeFormRules.name[0].validator({}, value, error => resolve(error ? error.message : ''))
    })
    const edgeRun = value => new Promise(resolve => {
      wrapper.vm.edgeFormRules.edge_type[0].validator({}, value, error => resolve(error ? error.message : ''))
    })

    // 该键在 zh 词条里缺失：真实行为就是把键名原样显示出来（既有缺口，钉住）
    expect(await run('')).toContain('entityClassNameRequired')
    expect(await edgeRun('')).toContain('relationshipTypeRequired')
    expect(await edgeRun('x'.repeat(64))).toContain('长度不合法')
    expect(await edgeRun('Abc1')).toContain('格式不合法')
    expect(await edgeRun('GROUP')).toContain('保留关键字')
    expect(await edgeRun('Fine')).toBe('')
    // nodeFormRules 一侧（fieldType 默认 entity）同样走全部分支
    expect(await run('x'.repeat(64))).toContain('长度不合法')
    expect(await run('Entity1')).toContain('格式不合法')
    expect(await run('VERTEX')).toContain('保留关键字')
    expect(await run('Vertex')).toContain('保留关键字')
    expect(await run('Ok')).toBe('')
  })

  it('validateDesc：必填 / 超长 / 全空白 / 通过', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    const run = value => new Promise(resolve => {
      wrapper.vm.nodeFormRules.description[0].validator({}, value, error => resolve(error ? error.message : ''))
    })
    expect(await run('')).toContain('请输入必填字段')
    expect(await run('x'.repeat(1001))).toContain('1-1000')
    expect(await run('   ')).toContain('空白字符')
    expect(await run('正常描述')).toBe('')
  })

  it('属性名校验器：必填 / 长度 / 格式 / 保留字 / 重复（节点与关系两套）', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    const nodeRules = wrapper.vm.getNodePropertyRules(0)
    const nodeRun = value => new Promise(resolve => {
      nodeRules.name[0].validator({}, value, error => resolve(error ? error.message : ''))
    })
    expect(await nodeRun('')).toContain('不能为空')
    expect(await nodeRun('x'.repeat(64))).toContain('长度不合法')
    expect(await nodeRun('1abc')).toContain('必须以字母开头')
    expect(await nodeRun('LIMIT')).toContain('保留关键字')
    // 第 0 行取名 tag：取另一行（score）的名字 → 与已有行重复
    expect(await nodeRun('score')).toContain('不能重复')
    expect(await nodeRun('fresh_name')).toBe('')

    const edgeRules = wrapper.vm.getEdgePropertyRules(0)
    const edgeRun = value => new Promise(resolve => {
      edgeRules.name[0].validator({}, value, error => resolve(error ? error.message : ''))
    })
    expect(await edgeRun('')).toContain('不能为空')
    expect(await edgeRun('1abc')).toContain('必须以字母开头')
    // 关系侧无重名行 → 通过
    expect(await edgeRun('any')).toBe('')
  })

  it('关系属性名的重名校验：与另一行同名报重复（validateEdgePropertyName）', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({
        edge_type: 'Follows', edge_desc: 'd',
        properties: [{ name: 'x', desc: '1' }, { name: 'x', desc: '2' }]
      }),
      itemType: 'edge'
    })
    const rules = wrapper.vm.getEdgePropertyRules(0)
    const run = value => new Promise(resolve => {
      rules.name[0].validator({}, value, error => resolve(error ? error.message : ''))
    })
    expect(await run('x')).toContain('不能重复')
    expect(await run('solo')).toBe('')
  })
})

describe('PropertyPanel：真渲染交互（v-model 写回与事件入口）', () => {
  it('节点面板：折叠面板、描述 textarea、属性类型下拉、单选组的 v-model 写回', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })

    // 折叠面板收起（update:modelValue → activeNames）
    wrapper.findAllComponents({ name: 'ElCollapse' })[0].vm.$emit('update:modelValue', ['basic'])
    await flush()
    expect(wrapper.vm.activeNames).toEqual(['basic'])

    // 实体描述 textarea
    const descTextarea = wrapper.find('textarea')
    await descTextarea.setValue('更新后的描述')
    expect(wrapper.vm.nodeForm.description).toBe('更新后的描述')

    // 属性行：名称 blur、描述输入 + blur、类型下拉、三组单选
    const propName = wrapper.findAll('input')
      .find(node => node.attributes('placeholder') === '请输入属性名称')
    await propName.setValue('renamed')
    await propName.trigger('blur')
    expect(wrapper.vm.nodeForm.properties[0].name).toBe('renamed')

    const propDesc = wrapper.findAll('textarea').find(node => node.attributes('placeholder') === '请输入属性的描述信息')
    await propDesc.setValue('新的属性描述')
    await propDesc.trigger('blur')
    expect(wrapper.vm.nodeForm.properties[0].desc).toBe('新的属性描述')

    const propSelect = wrapper.findAllComponents({ name: 'ElSelect' })[0]
    propSelect.vm.$emit('update:modelValue', 'LONG')
    await flush()
    expect(wrapper.vm.nodeForm.properties[0].type).toBe('LONG')

    const radioGroups = wrapper.findAllComponents({ name: 'ElRadioGroup' })
    expect(radioGroups.length).toBeGreaterThanOrEqual(3)
    radioGroups[0].vm.$emit('update:modelValue', true)
    radioGroups[1].vm.$emit('update:modelValue', true)
    radioGroups[2].vm.$emit('update:modelValue', true)
    await flush()
    expect(wrapper.vm.nodeForm.properties[0].is_primary).toBe(true)
    expect(wrapper.vm.nodeForm.properties[0].is_embedding).toBe(true)
    expect(wrapper.vm.nodeForm.properties[0].is_index).toBe(true)
  })

  it('关系面板：类型/描述/两端实体与关系属性行的 v-model 写回', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({
        edge_type: 'Follows', edge_desc: 'd',
        properties: [{ name: 'weight', type: 'DOUBLE', desc: '权重' }]
      }),
      itemType: 'edge'
    })

    await wrapper.find('textarea').setValue('关系描述更新')
    expect(wrapper.vm.edgeForm.edge_desc).toBe('关系描述更新')

    // 两端实体是禁用输入：真件会拦原生 input，改由组件事件写回（模板 v-model 处理器）
    const edgeInputs = wrapper.findAllComponents({ name: 'ElInput' })
    expect(edgeInputs.length).toBeGreaterThanOrEqual(4)
    edgeInputs[2].vm.$emit('update:modelValue', '甲')
    edgeInputs[3].vm.$emit('update:modelValue', '乙')
    await flush()
    expect(wrapper.vm.edgeForm.source_entity).toBe('甲')
    expect(wrapper.vm.edgeForm.target_entity).toBe('乙')

    // 关系属性行：名称输入 + blur、描述 textarea + blur、类型下拉、两组单选
    const edgePropName = wrapper.findAll('input')
      .find(node => node.attributes('placeholder') === '请输入属性名称')
    await edgePropName.setValue('renamed_weight')
    await edgePropName.trigger('blur')
    expect(wrapper.vm.edgeForm.properties[0].name).toBe('renamed_weight')

    // 关系类型输入（组件事件直发，绕开真件的原生合成拦截）
    wrapper.findAllComponents({ name: 'ElInput' })[0].vm.$emit('update:modelValue', 'Follows2')
    await flush()
    expect(wrapper.vm.edgeForm.edge_type).toBe('Follows2')

    // 关系属性页签的 v-model（tabs 组件直发；边面板只有一个 el-tabs）
    wrapper.findAllComponents({ name: 'ElTabs' })[0].vm.$emit('update:modelValue', '1')
    await flush()
    expect(wrapper.vm.activeEdgePropTabName).toBe('1')

    // 关系属性行：描述 textarea + blur、类型下拉、两组单选
    const propDesc = wrapper.findAll('textarea').find(node => node.attributes('placeholder') === '请输入属性的描述信息')
    await propDesc.setValue('权重更新')
    await propDesc.trigger('blur')
    expect(wrapper.vm.edgeForm.properties[0].desc).toBe('权重更新')

    wrapper.findAllComponents({ name: 'ElSelect' })[0].vm.$emit('update:modelValue', 'INTEGER')
    await flush()
    expect(wrapper.vm.edgeForm.properties[0].type).toBe('INTEGER')

    const radioGroups = wrapper.findAllComponents({ name: 'ElRadioGroup' })
    radioGroups.forEach(group => group.vm.$emit('update:modelValue', true))
    await flush()
    expect(wrapper.vm.edgeForm.properties[0].is_embedding).toBe(true)
    expect(wrapper.vm.edgeForm.properties[0].is_index).toBe(true)
  })

  it('手动在两个关系属性行之间切换：旧页签触发 validate（watch activeEdgePropTabName）', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({
        edge_type: 'Follows', edge_desc: 'd',
        properties: [{ name: 'a', desc: '1' }, { name: 'b', desc: '2' }]
      }),
      itemType: 'edge'
    })
    expect(wrapper.vm.activeEdgePropTabName).toBe('1')
    wrapper.vm.activeEdgePropTabName = '2'
    await settleTimers()
    const propForms = wrapper.findAllComponents({ name: 'ElForm' }).slice(1)
    expect(propForms[0].vm.validate).toHaveBeenCalled()
  })

  it('新增态下切到已有页签：watch 只清该页签校验（clearValidate 分支）', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    wrapper.vm.isAddingNodePropTab = true
    wrapper.vm.activePropTabName = '2'
    await settleTimers()
    const propForms = wrapper.findAllComponents({ name: 'ElForm' }).slice(1)
    expect(propForms.find(f => f.vm.clearValidate.mock.calls.length)?.vm.clearValidate).toBeTruthy()

    const edgeWrapper = await mountPanel({
      selectedItem: edgeItem({
        edge_type: 'Follows', edge_desc: 'd',
        properties: [{ name: 'a', desc: '1' }, { name: 'b', desc: '2' }]
      }),
      itemType: 'edge'
    })
    edgeWrapper.vm.isAddingEdgePropTab = true
    edgeWrapper.vm.activeEdgePropTabName = '2'
    await settleTimers()
    const edgePropForms = edgeWrapper.findAllComponents({ name: 'ElForm' }).slice(1)
    expect(edgePropForms.find(f => f.vm.clearValidate.mock.calls.length)?.vm.clearValidate).toBeTruthy()
  })

  it('directionLabel 按方向映射文案（双向/自环/单向）', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Follows', edge_desc: 'd', direction: 'double' }),
      itemType: 'edge'
    })
    expect(wrapper.vm.directionLabel).toBe('双向')

    const selfWrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Follows', edge_desc: 'd', direction: 'self' }), // 数据侧用 X6 模式名：self → 表单的 self-loop
      itemType: 'edge'
    })
    expect(selfWrapper.vm.directionLabel).toBe('自环')

    const oneWrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Follows', edge_desc: 'd', direction: 'single' }),
      itemType: 'edge'
    })
    expect(oneWrapper.vm.directionLabel).toBe('单向')
  })
})

describe('PropertyPanel：边界与防御分支', () => {
  it('属性没有 __key 时页签回落到索引名；点页签头切换空页签路径', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    // 直接换没有 __key 且没有名字的属性：模板 `p?.__key ?? String(idx)` 走回落
    wrapper.vm.nodeForm.properties = [{ name: '', type: 'STRING', desc: 'd' }]
    await flush()
    expect(wrapper.findAll('.el-tabs__item').map(node => node.text().trim())).toEqual(['属性 1'])

    // activePropTabName 先清空再切换：oldVal 为空的 watch 分支
    wrapper.vm.activePropTabName = ''
    await settleTimers()
    wrapper.vm.activePropTabName = '0'
    await settleTimers()
  })

  it('删除不存在的页签 / 删除唯一页签：激活态静默保持', async () => {
    const wrapper = await mountPanel({
      selectedItem: { id: 'n2', getData: () => ({ name: 'B' }) },
      itemType: 'node'
    })
    // 目标不存在：idx === -1 分支
    wrapper.vm.handlePropTabsEdit('ghost', 'remove')
    await flush()
    expect(wrapper.vm.nodeForm.properties).toHaveLength(1)

    // 唯一页签且是激活页签：next 不存在 → active 原样保留
    wrapper.vm.handlePropTabsEdit('1', 'remove')
    await flush()
    expect(wrapper.vm.nodeForm.properties).toHaveLength(0)
    expect(wrapper.vm.activePropTabName).toBe('1')

    // 同一套（关系侧）
    const edgeWrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'A', edge_desc: 'd', properties: [{ name: 'x', desc: 'y' }] }),
      itemType: 'edge'
    })
    edgeWrapper.vm.handleEdgePropTabsEdit('ghost', 'remove')
    await flush()
    expect(edgeWrapper.vm.edgeForm.properties).toHaveLength(1)
    edgeWrapper.vm.handleEdgePropTabsEdit('1', 'remove')
    await flush()
    expect(edgeWrapper.vm.edgeForm.properties).toHaveLength(0)
    expect(edgeWrapper.vm.activeEdgePropTabName).toBe('1')
  })

  it('新增态下切到不存在的页签：watch 里 newIndex === -1 分支', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    wrapper.vm.isAddingNodePropTab = true
    wrapper.vm.activePropTabName = 'ghost'
    await settleTimers()

    const edgeWrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'A', edge_desc: 'd', properties: [{ name: 'x', desc: 'y' }] }),
      itemType: 'edge'
    })
    edgeWrapper.vm.isAddingEdgePropTab = true
    edgeWrapper.vm.activeEdgePropTabName = 'ghost'
    await settleTimers()
  })

  it('边数据没有 getSourceCell / shape 时走字段回落推断', async () => {
    // 无 shape：用 getShape() 推断不出已知模式 → 单向
    const byGetShape = await mountPanel({
      selectedItem: {
        id: 'r3', getData: () => ({ edge_type: 'A', edge_desc: 'd' }), getShape: () => 'mystery-edge'
      },
      itemType: 'edge'
    })
    expect(byGetShape.vm.edgeForm.direction).toBe('one-way')
    expect(byGetShape.vm.edgeForm.source_entity).toBe('')

    // 无 shape 无 getShape：同样回落单向
    const bare = await mountPanel({
      selectedItem: { id: 'r4', getData: () => ({ edge_type: 'A', edge_desc: 'd' }) },
      itemType: 'edge'
    })
    expect(bare.vm.edgeForm.direction).toBe('one-way')
  })

  it('itemType 为空时 resetForm 不做任何事', async () => {
    const wrapper = await mountPanel()
    expect(() => wrapper.vm.resetForm()).not.toThrow()
  })
})

describe('PropertyPanel：tab 切换与字段级校验入口', () => {
  it('手动切换属性页签：旧页签触发 validate；新增态切换只清校验', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    // 手动切换到第 2 个页签（watch 会触发旧页签 validate）
    wrapper.vm.activePropTabName = '2'
    await settleTimers()
    expect(wrapper.vm.activePropTabName).toBe('2')

    // 新增态：watch 里 clearValidate 分支（新页签表单的 clearValidate 被调）
    wrapper.vm.isAddingNodePropTab = true
    wrapper.vm.handlePropTabsEdit('x', 'add')
    await settleTimers()
    expect(wrapper.vm.isAddingNodePropTab).toBe(false)
  })

  it('validateNodePropField / validateEdgePropField：经 ref 调 validateField；越界下标静默', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    expect(() => wrapper.vm.validateNodePropField(99, 'name')).not.toThrow()
    wrapper.vm.validateNodePropField(0, 'name')
    await flush()
    const propForm = wrapper.findAllComponents({ name: 'ElForm' })[1]
    expect(propForm.vm.validateField).toHaveBeenCalledWith('name')

    const edgeWrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'A', edge_desc: 'd', properties: [{ name: 'a', desc: 'x' }] }),
      itemType: 'edge'
    })
    expect(() => edgeWrapper.vm.validateEdgePropField(99, 'name')).not.toThrow()
    edgeWrapper.vm.validateEdgePropField(0, 'name')
    await flush()
    const edgePropForm = edgeWrapper.findAllComponents({ name: 'ElForm' })[1]
    expect(edgePropForm.vm.validateField).toHaveBeenCalledWith('name')
  })

  it('validateNodeName / validateEdgeType：经 ref 调字段校验', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    wrapper.vm.validateNodeName()
    await flush()
    expect(wrapper.findAllComponents({ name: 'ElForm' })[0].vm.validateField).toHaveBeenCalledWith('name')

    const edgeWrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'A', edge_desc: 'd' }),
      itemType: 'edge'
    })
    edgeWrapper.vm.validateEdgeType()
    await flush()
    expect(edgeWrapper.findAllComponents({ name: 'ElForm' })[0].vm.validateField).toHaveBeenCalledWith('edge_type')
  })

  it('resetForm：节点侧复位并保留一行空属性；关系侧整体复位', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    wrapper.vm.resetForm()
    expect(wrapper.vm.nodeForm.name).toBe('')
    expect(wrapper.vm.nodeForm.properties).toHaveLength(1)
    expect(wrapper.vm.nodeForm.properties[0].name).toBe('')

    const edgeWrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Invests', edge_desc: 'd', direction: 'double' }),
      itemType: 'edge'
    })
    edgeWrapper.vm.resetForm()
    expect(edgeWrapper.vm.edgeForm.edge_type).toBe('')
    expect(edgeWrapper.vm.edgeForm.direction).toBe('one-way')
    expect(edgeWrapper.vm.edgeForm.properties).toHaveLength(0)
  })
})
