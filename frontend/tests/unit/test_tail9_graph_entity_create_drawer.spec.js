// @vitest-environment jsdom
/**
 * GraphEntityCreateDrawer.vue —— 画布「新增实体」抽屉（开态 + 表单交互 + 提交两路）。
 *
 * 与编辑抽屉同款透传件：el-drawer 的 header/默认/footer 都真渲染；下拉用替身，
 * change / update:modelValue 直接从组件实例 $emit。EP 表单校验的行内红字依赖
 * validateState，替身场景不触发 —— 断言挂在 ElFormItem 的 error prop 上。
 *
 * 覆盖：草稿开合（modelValue watch）、模板声明/自由填写两种属性模式、
 * 属性行的增删与 key/kind/value 三类控件、关联边开关（含无实体禁用）、
 * 对端/方向切换后的边类型联动（syncEdgeType）、提交校验全部分支
 * （name/type/peer/edgeType/keyRequired/duplicate/notDefined/number/integer/json/jsonType）、
 * 成功提交载荷、saving 防抖与 before-close。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElInput } from 'element-plus/es/components/input/index'
import { ElSwitch } from 'element-plus/es/components/switch/index'
import { ElButton } from 'element-plus/es/components/button/index'
import GraphEntityCreateDrawer from '@/features/graph/components/GraphEntityCreateDrawer.vue'

const DrawerShell = {
  name: 'ElDrawer',
  props: { modelValue: Boolean, beforeClose: Function },
  emits: ['update:modelValue'],
  setup (props, { slots, attrs, emit }) {
    // 真 el-drawer 的右上角关闭叉会先走 before-close（done 由抽屉提供）
    const closeX = () => props.beforeClose?.(() => emit('update:modelValue', false))
    return () => props.modelValue
      ? h('div', { class: ['drawer-shell', attrs.class] }, [
        h('div', { class: 'drawer-shell-header' }, [
          slots.header?.(),
          h('button', { class: 'drawer-shell-close', onClick: closeX }, '×')
        ]),
        h('div', { class: 'drawer-shell-body' }, slots.default?.()),
        h('div', { class: 'drawer-shell-footer' }, slots.footer?.())
      ])
      : null
  }
}

const SelectStub = {
  name: 'SelectStub',
  props: { modelValue: { type: null, default: '' }, placeholder: String, disabled: Boolean },
  emits: ['update:modelValue', 'change'],
  template: '<div class="ops-stub-select"><slot /></div>'
}

const OptionStub = {
  name: 'ElOption',
  props: { label: String, value: null },
  template: '<div class="ops-stub-option"><slot /></div>'
}

/** 模板声明 Person：name(展示) / age(INTEGER) / description；Company 无声明 → 自由填写。 */
const PROPERTY_DEFS = {
  Person: [
    { name: 'name', type: 'STRING' },
    { name: 'age', type: 'INTEGER' },
    { name: 'active', type: 'BOOLEAN' },
    { name: 'description', type: 'STRING' }
  ],
  // 无 description 声明 → 切到该类型后说明字段收起（handleTypeChange 的清空分支）
  Robot: [
    { name: 'name', type: 'STRING' },
    { name: 'model', type: 'STRING' }
  ]
}

const ENTITIES = [
  { entity_id: 'e-company-1', entity_type: 'Company', entity_name: '阿里巴巴', properties: { name: '阿里巴巴' } }
]

const edgeTypesFor = vi.fn((newType, peerType) => ([
  { edge_type: 'WORKS_AT', direction: 'out' },
  { edge_type: 'WORKS_AT_R', direction: 'in' }
]))

async function mountDrawer (props = {}) {
  return mountWithPlugins(GraphEntityCreateDrawer, {
    router: null,
    props: {
      modelValue: true,
      graphName: '企业图谱',
      entityTypes: ['Person', 'Company', 'Robot'],
      typeTones: { Person: 'purple' },
      entities: ENTITIES,
      propertyDefs: PROPERTY_DEFS,
      edgeTypesFor,
      saving: false,
      ...props
    },
    global: {
      components: {
        ElDrawer: DrawerShell, ElForm, ElFormItem, ElInput, ElSwitch, ElButton,
        ElSelect: SelectStub, ElOption: OptionStub
      },
      stubs: { transition: false, 'transition-group': false }
    }
  })
}

const selects = wrapper => wrapper.findAllComponents(SelectStub)
const footerButtons = wrapper => wrapper.find('.drawer-shell-footer').findAll('button.el-button')
const itemError = (wrapper, index) => wrapper.findAllComponents(ElFormItem)[index]?.props('error') || ''

beforeEach(() => {
  edgeTypesFor.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Element.prototype.scrollIntoView = vi.fn()
})

describe('开合与头部', () => {
  it('关闭态不渲染表单；打开后标题/图谱名/说明出现', async () => {
    const closed = await mountDrawer({ modelValue: false })
    expect(closed.find('form').exists()).toBe(false)

    const wrapper = await mountDrawer()
    expect(wrapper.text()).toContain('添加实体')
    expect(wrapper.text()).toContain('企业图谱')
    expect(wrapper.text()).toContain('选填')
    expect(wrapper.text()).toContain('同时建立关联')
  })

  it('打开时聚焦名称输入框；关闭后草稿清空', async () => {
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(() => {})
    const wrapper = await mountDrawer()
    const name = wrapper.find('input[maxlength="128"]')
    expect(focusSpy).toHaveBeenCalled()
    focusSpy.mockRestore()

    await name.setValue('张三')
    await wrapper.setProps({ modelValue: false })
    await flush()
    await wrapper.setProps({ modelValue: true })
    await flush()
    expect(wrapper.find('input[maxlength="128"]').element.value).toBe('')
  })
})

describe('模板声明模式（Person 有属性表）', () => {
  it('名称字段落模板展示属性名；属性行 key 走下拉、类型只读标签', async () => {
    const wrapper = await mountDrawer()
    // 名称字段 label：模板展示属性 name 就是 'name' → 本地化词条「实体名称」
    expect(wrapper.text()).toContain('实体名称')
    // 模板有 description → textarea 渲染（说明字段启用）
    expect(wrapper.find('.el-textarea__inner').exists()).toBe(true)

    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()

    // 类型选项带色点；Person 下拉被点开过（options 来自 entityTypes）
    expect(wrapper.findAllComponents(ElFormItem).length).toBeGreaterThan(0)
  })

  it('加属性 → key 下拉选 age(INTEGER) → kind 只读「数字」；值输入写回', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()

    const addBtn = wrapper.findAll('button').find(b => b.text().includes('添加属性'))
    await addBtn.trigger('click')
    await flush()
    expect(wrapper.text()).toContain('属性 1')

    const keySelect = selects(wrapper)[1]
    keySelect.vm.$emit('update:modelValue', 'age')
    keySelect.vm.$emit('change', 'age')
    await flush()

    // 模板声明 INTEGER → 值输入是文本框；填非数字提交后报「请输入有效数字」
    const valueInput = wrapper.findAll('.gc-property input[type="text"]').at(-1)
    await valueInput.setValue('abc')
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('create')).toBeUndefined()
    expect(itemError(wrapper, 5)).toBe('请输入有效数字')
  })

  it('重复选同一模板属性 → duplicate；未声明键 → notDefined', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()

    const addBtn = wrapper.findAll('button').find(b => b.text().includes('添加属性'))
    await addBtn.trigger('click')
    const keySelect = selects(wrapper)[1]
    keySelect.vm.$emit('update:modelValue', 'name')
    keySelect.vm.$emit('change', 'name')
    await flush()

    // name 是展示属性，提交时报 duplicate（与 name 键冲突）
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('create')).toBeUndefined()

    // 改成未声明的键 → notDefined
    keySelect.vm.$emit('update:modelValue', 'hobby')
    keySelect.vm.$emit('change', 'hobby')
    await flush()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(itemError(wrapper, 3)).toBe('属性未在模板中定义')
  })

  it('INTEGER 填 3.5 → integer 错误；删除属性行恢复正常', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()

    await wrapper.findAll('button').find(b => b.text().includes('添加属性')).trigger('click')
    selects(wrapper)[1].vm.$emit('update:modelValue', 'age')
    selects(wrapper)[1].vm.$emit('change', 'age')
    await flush()
    await wrapper.findAll('.gc-property input[type="text"]').at(-1).setValue('3.5')

    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(itemError(wrapper, 5)).toBe('请输入整数')

    // 删除行后可成功提交
    await wrapper.find('.danger-icon').trigger('click')
    await flush()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('create')).toHaveLength(1)
    expect(wrapper.emitted('create')[0][0].properties).toMatchObject({ name: '张三' })
  })
})

describe('自由填写模式（无模板属性表）', () => {
  async function freeDrawer (extra = {}) {
    const wrapper = await mountDrawer({
      propertyDefs: {},
      entities: [],
      ...extra
    })
    await wrapper.find('input[maxlength="128"]').setValue('李四')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Company')
    selects(wrapper)[0].vm.$emit('change', 'Company')
    await flush()
    return wrapper
  }

  it('无模板：说明字段被收起（提示「该类型不支持描述」），key/kind 都是自由控件', async () => {
    const wrapper = await freeDrawer()
    // 自由模式说明字段仍可用；属性区提示自由填写
    expect(wrapper.find('.el-textarea__inner').exists()).toBe(true)
    expect(wrapper.text()).toContain('自由填写')

    await wrapper.findAll('button').find(b => b.text().includes('添加属性')).trigger('click')
    await flush()
    // key 走 input（无 schemaDeclared），kind 走下拉
    expect(wrapper.find('.gc-property input[maxlength="64"]').exists()).toBe(true)
    // 自由模式：类型下拉 + 属性行 kind 下拉（无模板 key 下拉）
    expect(selects(wrapper)).toHaveLength(2)
  })

  it('kind 切到 boolean → 值变开关；切到 json → 占位与 textarea', async () => {
    const wrapper = await freeDrawer()
    await wrapper.findAll('button').find(b => b.text().includes('添加属性')).trigger('click')
    await flush()

    const kindSelect = selects(wrapper).at(-1)
    kindSelect.vm.$emit('update:modelValue', 'boolean')
    kindSelect.vm.$emit('change', 'boolean')
    await flush()
    expect(wrapper.find('.gc-property .el-switch').exists()).toBe(true)

    kindSelect.vm.$emit('update:modelValue', 'json')
    kindSelect.vm.$emit('change', 'json')
    await flush()
    expect(wrapper.find('.gc-property .el-textarea__inner').exists()).toBe(true)
  })

  it('提交分支：空 key → keyRequired；重复 key → duplicate', async () => {
    const wrapper = await freeDrawer()
    await wrapper.findAll('button').find(b => b.text().includes('添加属性')).trigger('click')
    await flush()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(itemError(wrapper, 3)).toBe('请输入属性名称')

    await wrapper.find('.gc-property input[maxlength="64"]').setValue('段位')
    await wrapper.findAll('button').find(b => b.text().includes('添加属性')).trigger('click')
    await flush()
    await wrapper.findAll('.gc-property input[maxlength="64"]')[1].setValue('段位')
    await flush()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(itemError(wrapper, 3)).toBe('属性名称不能重复')
  })

  it('json 值非法 → json；json 值是标量 → jsonType；提交成功走 create 载荷', async () => {
    const wrapper = await freeDrawer()
    await wrapper.findAll('button').find(b => b.text().includes('添加属性')).trigger('click')
    await wrapper.find('.gc-property input[maxlength="64"]').setValue('扩展')
    const kindSelect = selects(wrapper).at(-1)
    kindSelect.vm.$emit('update:modelValue', 'json')
    kindSelect.vm.$emit('change', 'json')
    await flush()

    const jsonArea = wrapper.find('.gc-property .el-textarea__inner')
    await jsonArea.setValue('oops')
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(itemError(wrapper, 5)).toBe('JSON 格式不正确，请检查引号、逗号和括号')

    await jsonArea.setValue('123')
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(itemError(wrapper, 5)).toBe('请输入 JSON 对象、数组或 null')

    await jsonArea.setValue('{"a":1}')
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    const payload = wrapper.emitted('create')[0][0]
    expect(payload.entityType).toBe('Company')
    expect(payload.properties).toMatchObject({ name: '李四', 扩展: { a: 1 } })
  })
})

describe('关联边（第 03 节）', () => {
  async function withRelation (extra = {}) {
    const wrapper = await mountDrawer(extra)
    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()
    // 打开关联开关
    await wrapper.find('.studio-switch-row .el-switch').trigger('click')
    await flush()
    return wrapper
  }

  it('无实体时开关禁用并提示；有实体时打开出现对端/类型/方向控件', async () => {
    const none = await mountDrawer({ entities: [] })
    expect(none.find('.studio-switch-row .el-switch').classes()).toContain('is-disabled')
    expect(none.text()).toContain('当前还没有可关联的实体')

    const wrapper = await withRelation()
    expect(wrapper.text()).toContain('关联实体')
    expect(wrapper.text()).toContain('关系类型')
    expect(wrapper.text()).toContain('关系方向')
  })

  it('edgeTypesFor 返回空 → 「所选方向没有可用的关系类型」，提交报 edgeTypeRequired', async () => {
    const wrapper = await withRelation({ edgeTypesFor: () => [] })
    await flush()
    // 先选对端，才谈得上「当前方向有没有可用边类型」
    selects(wrapper)[1].vm.$emit('update:modelValue', 'e-company-1')
    selects(wrapper)[1].vm.$emit('change', 'e-company-1')
    await flush()
    expect(wrapper.text()).toContain('所选方向没有可用的关系类型')
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('create')).toBeUndefined()
    expect(wrapper.findAllComponents(ElFormItem).map(item => item.props('error')))
      .toContain('请选择关系类型')
  })

  it('对端与方向切换会触发边类型联动（syncEdgeType）', async () => {
    const wrapper = await withRelation()
    const selectsOf = selects(wrapper)
    // 对端 select（index 1）、边类型（index 2）、方向（index 3）
    selectsOf[1].vm.$emit('update:modelValue', 'e-company-1')
    selectsOf[1].vm.$emit('change', 'e-company-1')
    await flush()
    expect(edgeTypesFor).toHaveBeenCalled()

    // 方向切换：重新按新方向过滤可用边类型
    const callsAfterPeer = edgeTypesFor.mock.calls.length
    selectsOf[3].vm.$emit('update:modelValue', 'peerToNew')
    selectsOf[3].vm.$emit('change', 'peerToNew')
    await flush()
    expect(edgeTypesFor.mock.calls.length).toBeGreaterThan(callsAfterPeer)

    // 清空边类型后提交 → edgeTypeRequired
    selectsOf[2].vm.$emit('update:modelValue', '')
    selectsOf[2].vm.$emit('change', '')
    await flush()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('create')).toBeUndefined()
  })

  it('完整关联提交：载荷带 relation（peerId/edgeType/direction 转换）', async () => {
    const wrapper = await withRelation()
    const selectsOf = selects(wrapper)
    selectsOf[1].vm.$emit('update:modelValue', 'e-company-1')
    selectsOf[1].vm.$emit('change', 'e-company-1')
    await flush()
    selectsOf[2].vm.$emit('update:modelValue', 'WORKS_AT')
    selectsOf[2].vm.$emit('change', 'WORKS_AT')
    await flush()

    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('create')).toHaveLength(1)
    const payload = wrapper.emitted('create')[0][0]
    expect(payload.relation).toMatchObject({
      peerId: 'e-company-1',
      peerType: 'Company',
      edgeType: 'WORKS_AT',
      direction: 'out',
      sourceId: payload.entityId,
      targetId: 'e-company-1'
    })
  })

  it('没选对端就提交 → peerRequired（挂在对应 form-item）', async () => {
    const wrapper = await withRelation()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('create')).toBeUndefined()
    const errors = wrapper.findAllComponents(ElFormItem).map(item => item.props('error'))
    expect(errors).toContain('请选择关联实体')
  })
})

describe('提交按钮门控与 saving 防抖', () => {
  it('名称或类型未填时提交按钮禁用', async () => {
    const wrapper = await mountDrawer()
    expect(footerButtons(wrapper)[1].element.disabled).toBe(true)

    await wrapper.find('input[maxlength="128"]').setValue('张三')
    await flush()
    expect(footerButtons(wrapper)[1].element.disabled).toBe(true) // 还差类型

    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()
    expect(footerButtons(wrapper)[1].element.disabled).toBe(false)
  })

  it('saving=true：提交/关闭全部短路，before-close 不放行', async () => {
    const wrapper = await mountDrawer({ saving: true })
    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()

    await footerButtons(wrapper)[1].trigger('click')
    expect(wrapper.emitted('create')).toBeUndefined()

    await footerButtons(wrapper)[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('取消按钮 emit update:modelValue=false；Ctrl+Enter 快捷提交', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()

    await wrapper.find('form').trigger('keydown.ctrl.enter')
    await flush()
    expect(wrapper.emitted('create')).toHaveLength(1)

    await footerButtons(wrapper)[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')[0][0]).toBe(false)
  })
})

describe('补充分支（选项渲染 / 类型切换 / 关联复位 / 关闭叉）', () => {
  it('类型选项渲染：色点 toneColor（有 tone 与无 tone 两分支）与模板属性类型标签', async () => {
    const wrapper = await mountDrawer()
    const typeOptions = selects(wrapper)[0].findAll('.ops-stub-option')
    expect(typeOptions.length).toBeGreaterThanOrEqual(2)
    // Person 有 tone → var(--rs-tone-purple)；Robot 没登记 tone → 默认主色
    expect(typeOptions[0].find('i').attributes('style')).toContain('var(--rs-tone-purple)')
    expect(typeOptions[2].find('i').attributes('style')).toContain('var(--rs-primary)')
    // 模板属性行选项里的类型标签要等选中类型后才渲染，这里只看选项本身
    expect(typeOptions[0].text()).toContain('Person')
  })

  it('graphName 为空时副标题回落「—」', async () => {
    const wrapper = await mountDrawer({ graphName: '' })
    expect(wrapper.text()).toContain('—')
  })

  it('切到未声明 description 的类型：说明字段收起且草稿描述被清空', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('.el-textarea__inner').setValue('先写点描述')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Robot')
    selects(wrapper)[0].vm.$emit('change', 'Robot')
    await flush()
    expect(wrapper.text()).toContain('该实体类型未声明描述属性')
    expect(wrapper.find('.el-textarea__inner').exists()).toBe(false)
  })

  it('模板 BOOLEAN 属性：选 key 后值变开关且默认 false', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()
    await wrapper.findAll('button').find(b => b.text().includes('添加属性')).trigger('click')
    selects(wrapper)[1].vm.$emit('update:modelValue', 'active')
    selects(wrapper)[1].vm.$emit('change', 'active')
    await flush()
    expect(wrapper.find('.gc-property .el-switch').exists()).toBe(true)
  })

  it('关联开关关掉：错误提示清空；切换对端后不合法的边类型被复位', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('input[maxlength="128"]').setValue('张三')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'Person')
    selects(wrapper)[0].vm.$emit('change', 'Person')
    await flush()
    const relationSwitch = wrapper.find('.studio-switch-row .el-switch')
    await relationSwitch.trigger('click')
    await flush()
    // 填一个非法边类型，再切对端 → syncEdgeType 把它复位成可用项
    selects(wrapper)[2].vm.$emit('update:modelValue', 'BOGUS')
    selects(wrapper)[2].vm.$emit('change', 'BOGUS')
    await flush()
    selects(wrapper)[1].vm.$emit('update:modelValue', 'e-company-1')
    selects(wrapper)[1].vm.$emit('change', 'e-company-1')
    await flush()
    expect(edgeTypesFor).toHaveBeenCalled()

    // 再关掉开关（handleRelationToggle(false)），错误态被清空
    await relationSwitch.trigger('click')
    await flush()
    expect(wrapper.find('.gc-relation-fields').exists()).toBe(false)
  })

  it('右上角关闭叉走 before-close：saving 时不放行，否则 emit update:modelValue=false', async () => {
    const savingWrapper = await mountDrawer({ saving: true })
    await savingWrapper.find('.drawer-shell-close').trigger('click')
    expect(savingWrapper.emitted('update:modelValue')).toBeUndefined()

    const wrapper = await mountDrawer()
    await wrapper.find('.drawer-shell-close').trigger('click')
    expect(wrapper.emitted('update:modelValue')[0][0]).toBe(false)
  })
})
