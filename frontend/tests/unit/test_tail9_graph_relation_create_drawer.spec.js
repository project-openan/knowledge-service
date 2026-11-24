// @vitest-environment jsdom
/**
 * GraphRelationCreateDrawer.vue —— 画布「添加关系」抽屉（开态 + 表单交互 + 保存两路）。
 *
 * 覆盖：开抽屉预填（sourceId/targetId）、预览区两端实体（空态/就绪态）、
 * 端点下拉的过滤（filter-method → filteredNodes）、互换方向（swap）、
 * 边类型联动（watch 清空不可用类型 + 布尔属性默认值）、模板属性区
 * （布尔下拉 / 文本输入 / 首个属性错误）、保存校验全部分支
 * （source/target/selfLoop/edgeType/duplicate/属性错误码）、成功保存载荷、
 * footer 就绪态文案与 saving 防抖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElInput } from 'element-plus/es/components/input/index'
import { ElButton } from 'element-plus/es/components/button/index'
import GraphRelationCreateDrawer from '@/features/graph/components/GraphRelationCreateDrawer.vue'

const DrawerShell = {
  name: 'ElDrawer',
  props: { modelValue: Boolean, beforeClose: Function },
  emits: ['update:modelValue'],
  setup (props, { slots, attrs, emit }) {
    const closeX = () => {
      if (props.beforeClose) {
        props.beforeClose(() => emit('update:modelValue', false))
        return
      }
      emit('update:modelValue', false)
    }
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
  props: { modelValue: { type: null, default: '' }, placeholder: String, disabled: Boolean, filterMethod: Function },
  emits: ['update:modelValue', 'change', 'visible-change'],
  setup (_, { slots }) {
    return () => h('div', { class: 'ops-stub-select' }, [slots.default?.(), slots.empty?.()])
  }
}

const OptionStub = {
  name: 'ElOption',
  props: { label: String, value: null, disabled: Boolean },
  template: '<div class="ops-stub-option"><slot /></div>'
}

const NODES = [
  { entity_id: 'e-person-1', entity_type: 'Person', entity_name: '张三', properties: { name: '张三' } },
  { entity_id: 'e-company-1', entity_type: 'Company', entity_name: '阿里巴巴', properties: { name: '阿里巴巴' } }
]

/** Person→Company 方向只有 out 一条 WORKS_AT；带一个 BOOLEAN 与一个 INTEGER 属性声明。 */
const edgeTypesFor = vi.fn(() => ([
  {
    edge_type: 'WORKS_AT',
    direction: 'out',
    edge_desc: '就职于',
    properties: [
      { name: 'since', type: 'INTEGER', desc: '入职年份' },
      { name: 'primary', type: 'BOOLEAN' }
    ]
  }
]))

async function mountDrawer (props = {}) {
  const wrapper = await mountWithPlugins(GraphRelationCreateDrawer, {
    router: null,
    props: {
      modelValue: false,
      sourceId: '',
      targetId: '',
      nodes: NODES,
      edges: [],
      typeTones: { Person: 'blue' },
      edgeTypesFor,
      saving: false,
      ...props
    },
    global: {
      components: {
        ElDrawer: DrawerShell, ElForm, ElFormItem, ElInput, ElButton,
        ElSelect: SelectStub, ElOption: OptionStub
      },
      stubs: { transition: false, 'transition-group': false }
    }
  })
  await flush()
  await wrapper.setProps({ modelValue: true, ...Object.fromEntries(Object.entries(props).filter(([k]) => k !== 'modelValue')) })
  await flush()
  return wrapper
}

const selects = wrapper => wrapper.findAllComponents(SelectStub)
const footerButtons = wrapper => wrapper.find('.drawer-shell-footer').findAll('button.el-button')

const DEFAULT_EDGE_TYPES = () => ([
  {
    edge_type: 'WORKS_AT',
    direction: 'out',
    edge_desc: '就职于',
    properties: [
      { name: 'since', type: 'INTEGER', desc: '入职年份' },
      { name: 'primary', type: 'BOOLEAN' }
    ]
  }
])

beforeEach(() => {
  // mockReset 会连实现一起清掉：每个用例前恢复默认实现，防止上个用例的
  // mockImplementation 泄漏（比如 MENTIONS 覆盖后 WORKS_AT 就找不到了）
  edgeTypesFor.mockReset()
  edgeTypesFor.mockImplementation(DEFAULT_EDGE_TYPES)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Element.prototype.scrollIntoView = vi.fn()
})

describe('开抽屉与预览区', () => {
  it('标题 + 两端空态占位（起点/终点未选）', async () => {
    const wrapper = await mountDrawer()
    expect(wrapper.text()).toContain('添加关系')
    expect(wrapper.text()).toContain('选择起点实体')
    expect(wrapper.text()).toContain('选择目标实体')
    expect(wrapper.text()).toContain('?')
    expect(wrapper.text()).toContain('支持按实体名称或 ID 搜索')
  })

  it('打开时按 sourceId/targetId 预填：预览区显示两端实体与就绪态', async () => {
    const wrapper = await mountDrawer({ sourceId: 'e-person-1', targetId: 'e-company-1' })
    expect(wrapper.find('.gr-preview').text()).toContain('张三')
    expect(wrapper.find('.gr-preview').text()).toContain('阿里巴巴')
    expect(wrapper.text()).toContain('Person')
    // 头像取 nameOf(node).slice(0, 1)，tone 取 typeTones
    expect(wrapper.find('.gr-avatar').text()).toBe('张')
    expect(wrapper.find('.gr-avatar').classes()).toContain('blue')
    // 两端已有但边类型未选 → 未就绪文案
    expect(wrapper.text()).toContain('完成实体和关系类型选择即可创建')
  })

  it('关闭再打开重置：submitted/搜索词清空、草稿回填', async () => {
    const wrapper = await mountDrawer()
    await selects(wrapper)[0].findComponent(SelectStub).setValue?.('')
    selects(wrapper)[0].vm.$emit('update:modelValue', 'e-person-1')
    await flush()
    await wrapper.setProps({ modelValue: false })
    await flush()
    await wrapper.setProps({ modelValue: true, sourceId: 'e-company-1' })
    await flush()
    expect(wrapper.find('.gr-preview').text()).toContain('阿里巴巴')
  })
})

describe('端点选择与互换', () => {
  it('端点下拉选项：另一端已选的实体被禁用；过滤词生效', async () => {
    const wrapper = await mountDrawer({ sourceId: 'e-person-1' })
    const sourceSelect = selects(wrapper)[0]
    // filter-method → entitySearch 更新 → filteredNodes 过滤
    sourceSelect.vm.filterMethod('阿里')
    await flush()
    const options = sourceSelect.findAll('.ops-stub-option')
    expect(options).toHaveLength(1)
    expect(options[0].text()).toContain('阿里巴巴')

    sourceSelect.vm.filterMethod('不存在')
    await flush()
    // 无匹配 → #empty 插槽
    expect(sourceSelect.text()).toContain('没有找到匹配的实体')
    // visible-change（弹层展开）会清空搜索词 → 选项恢复全量
    sourceSelect.vm.$emit('visible-change', true)
    await flush()
    expect(sourceSelect.findAll('.ops-stub-option')).toHaveLength(2)
  })

  it('选中起点/终点：预览更新 + 实体 id 提示', async () => {
    const wrapper = await mountDrawer()
    selects(wrapper)[0].vm.$emit('update:modelValue', 'e-person-1')
    await flush()
    selects(wrapper)[1].vm.$emit('update:modelValue', 'e-company-1')
    await flush()
    expect(wrapper.text()).toContain('e-person-1')
    // 边类型下拉解禁（两端齐了）
    expect(selects(wrapper)[2].props('disabled')).toBeFalsy()
  })

  it('互换方向：起终点对调（都为空时按钮禁用）', async () => {
    const empty = await mountDrawer()
    expect(empty.find('.gr-swap').element.disabled).toBe(true)

    const wrapper = await mountDrawer({ sourceId: 'e-person-1', targetId: 'e-company-1' })
    await wrapper.find('.gr-swap').trigger('click')
    await flush()
    expect(wrapper.find('.gr-preview').text()).toContain('阿里巴巴')
    // 预览区第一格现在是公司
    expect(wrapper.findAll('.gr-preview-node')[0].text()).toContain('阿里巴巴')
  })
})

describe('关系类型与属性', () => {
  it('选边类型：模板属性区展开（INTEGER 文本框 + BOOLEAN 下拉，布尔默认 false）', async () => {
    const wrapper = await mountDrawer({ sourceId: 'e-person-1', targetId: 'e-company-1' })
    selects(wrapper)[2].vm.$emit('update:modelValue', 'WORKS_AT')
    selects(wrapper)[2].vm.$emit('change', 'WORKS_AT')
    await flush()

    expect(wrapper.find('.gr-extra').exists()).toBe(true)
    expect(wrapper.text()).toContain('since')
    expect(wrapper.text()).toContain('primary')
    const selectsInExtra = wrapper.findAll('.gr-extra .ops-stub-select')
    expect(selectsInExtra).toHaveLength(1) // 布尔属性走下拉
    expect(wrapper.find('.gr-extra .el-input__inner').element.value).toBe('') // 文本属性
    expect(wrapper.text()).toContain('关系 ID 将在创建后自动生成')
  })

  it('属性输入写回草稿；非法值保存时给首个属性错误', async () => {
    const wrapper = await mountDrawer({ sourceId: 'e-person-1', targetId: 'e-company-1' })
    selects(wrapper)[2].vm.$emit('update:modelValue', 'WORKS_AT')
    selects(wrapper)[2].vm.$emit('change', 'WORKS_AT')
    await flush()

    await wrapper.find('.gr-extra .el-input__inner').setValue('abc')
    selects(wrapper)[3].vm.$emit('update:modelValue', 'true')
    selects(wrapper)[3].vm.$emit('change', 'true')
    await flush()

    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.find('.gr-error').text()).toBe('请输入有效数字')
  })

  it('属性 JSON 非法 → json 错误码文案', async () => {
    const wrapper = await mountDrawer({
      sourceId: 'e-person-1',
      targetId: 'e-company-1',
      nodes: [...NODES, { entity_id: 'e-company-2', entity_type: 'Company', entity_name: '蚂蚁集团', properties: { name: '蚂蚁集团' } }]
    })
    // 同一对类型换成声明 EMBEDDED 属性的边；换端点才能让 edgeOptions 重新求值
    edgeTypesFor.mockImplementation(() => ([{
      edge_type: 'MENTIONS', direction: 'out', properties: [{ name: 'meta', type: 'EMBEDDED' }]
    }]))
    selects(wrapper)[1].vm.$emit('update:modelValue', 'e-company-2')
    selects(wrapper)[1].vm.$emit('change', 'e-company-2')
    await flush()
    selects(wrapper)[2].vm.$emit('update:modelValue', 'MENTIONS')
    selects(wrapper)[2].vm.$emit('change', 'MENTIONS')
    await flush()

    await wrapper.find('.gr-extra .el-input__inner').setValue('oops')
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.find('.gr-error').text()).toContain('JSON 格式不正确')
  })

  it('边类型切换后原选择失效会被 watch 清空（换一对没有可用边的端点）', async () => {
    const wrapper = await mountDrawer({
      sourceId: 'e-person-1',
      targetId: 'e-company-1',
      nodes: [...NODES, { entity_id: 'e-doc-1', entity_type: 'Doc', entity_name: '文档' }]
    })
    selects(wrapper)[2].vm.$emit('update:modelValue', 'WORKS_AT')
    selects(wrapper)[2].vm.$emit('change', 'WORKS_AT')
    await flush()
    // 终点换成没有出边的类型 → watch 清掉 edgeType
    edgeTypesFor.mockImplementation(() => ([]))
    selects(wrapper)[1].vm.$emit('update:modelValue', 'e-doc-1')
    selects(wrapper)[1].vm.$emit('change', 'e-doc-1')
    await flush()
    // 两端齐但没有任何可用边 → 警示文案；此时保存被校验拦下
    expect(wrapper.text()).toContain('当前实体类型之间没有可用的关系类型')
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('save')).toBeUndefined()
  })
})

describe('保存两路', () => {
  it('全空提交：sourceRequired/targetRequired/edgeTypeRequired 逐项报错', async () => {
    const wrapper = await mountDrawer()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()

    expect(wrapper.emitted('save')).toBeUndefined()
    const errors = wrapper.findAllComponents(ElFormItem).map(item => item.props('error'))
    expect(errors).toContain('请选择关系类型')
    expect(wrapper.find('.gr-invalid').exists()).toBe(true)
  })

  it('起点 === 终点：selfLoop 文案', async () => {
    const wrapper = await mountDrawer({ sourceId: 'e-person-1', targetId: 'e-person-1' })
    selects(wrapper)[2].vm.$emit('update:modelValue', 'WORKS_AT')
    selects(wrapper)[2].vm.$emit('change', 'WORKS_AT')
    await flush()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.text()).toContain('起点与目标不能是同一个实体')
    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('重复关系：duplicate 警示出现且提交按钮禁用', async () => {
    const wrapper = await mountDrawer({
      sourceId: 'e-person-1',
      targetId: 'e-company-1',
      edges: [{ edge_id: 'r1', edge_type: 'WORKS_AT', source_id: 'e-person-1', target_id: 'e-company-1' }]
    })
    // watch 会因已存在同类型边先清一次，这里重新选
    selects(wrapper)[2].vm.$emit('update:modelValue', 'WORKS_AT')
    selects(wrapper)[2].vm.$emit('change', 'WORKS_AT')
    await flush()

    expect(wrapper.find('.gr-duplicate').text()).toContain('该关系已存在')
    expect(footerButtons(wrapper)[1].element.disabled).toBe(true)
  })

  it('成功保存：emit save 且载荷带 direction 两端与解析后的属性', async () => {
    const wrapper = await mountDrawer({ sourceId: 'e-person-1', targetId: 'e-company-1' })
    selects(wrapper)[2].vm.$emit('update:modelValue', 'WORKS_AT')
    selects(wrapper)[2].vm.$emit('change', 'WORKS_AT')
    await flush()
    await wrapper.find('.gr-extra .el-input__inner').setValue('2020')
    selects(wrapper)[3].vm.$emit('update:modelValue', 'true')
    await flush()

    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.emitted('save')).toHaveLength(1)
    const payload = wrapper.emitted('save')[0][0]
    expect(payload).toMatchObject({
      edgeType: 'WORKS_AT',
      sourceId: 'e-person-1',
      targetId: 'e-company-1',
      properties: { since: 2020, primary: true }
    })
    expect(payload.edgeId).toContain('WORKS_AT_')
  })

  it('saving=true：取消禁用、保存 loading 且短路', async () => {
    const wrapper = await mountDrawer({ saving: true })
    expect(footerButtons(wrapper)[0].element.disabled).toBe(true)
    expect(footerButtons(wrapper)[1].classes()).toContain('is-loading')

    await footerButtons(wrapper)[1].trigger('click')
    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('取消按钮与关闭叉都 emit update:modelValue=false', async () => {
    const wrapper = await mountDrawer()
    await footerButtons(wrapper)[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')[0][0]).toBe(false)

    await wrapper.find('.drawer-shell-close').trigger('click')
    expect(wrapper.emitted('update:modelValue')[1][0]).toBe(false)
  })

  it('Ctrl+Enter 快捷保存成功', async () => {
    const wrapper = await mountDrawer({ sourceId: 'e-person-1', targetId: 'e-company-1' })
    selects(wrapper)[2].vm.$emit('update:modelValue', 'WORKS_AT')
    selects(wrapper)[2].vm.$emit('change', 'WORKS_AT')
    await flush()
    await wrapper.find('.gr-form').trigger('keydown.ctrl.enter')
    await flush()
    expect(wrapper.emitted('save')).toHaveLength(1)
  })
})

describe('补充分支', () => {
  it('端点实体缺类型声明 → 预览显示「未知类型」', async () => {
    const wrapper = await mountDrawer({
      sourceId: 'e-mute-1',
      nodes: [...NODES, { entity_id: 'e-mute-1', entity_name: '无类型' }]
    })
    expect(wrapper.find('.gr-preview').text()).toContain('未知类型')
  })

  it('JSON 属性错误在保存时落到首个错误属性', async () => {
    edgeTypesFor.mockImplementation(() => ([{
      edge_type: 'MENTIONS', direction: 'out', properties: [{ name: 'meta', type: 'EMBEDDED' }]
    }]))
    const wrapper = await mountDrawer({ sourceId: 'e-person-1', targetId: 'e-company-1' })
    selects(wrapper)[2].vm.$emit('update:modelValue', 'MENTIONS')
    selects(wrapper)[2].vm.$emit('change', 'MENTIONS')
    await flush()
    expect(wrapper.find('.gr-extra').exists()).toBe(true)
    await wrapper.find('.gr-extra .el-input__inner').setValue('oops')
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    expect(wrapper.find('.gr-error').text()).toContain('JSON 格式不正确')
  })

  it('可见性回调清空搜索词（visible-change 展开 = 重置过滤）', async () => {
    const wrapper = await mountDrawer({ sourceId: 'e-person-1' })
    const target = selects(wrapper)[1]
    target.vm.filterMethod('阿里')
    await flush()
    expect(target.findAll('.ops-stub-option')).toHaveLength(1)

    target.vm.$emit('visible-change', true)
    await flush()
    // 搜索词被清空 → 选项恢复全量
    expect(target.findAll('.ops-stub-option')).toHaveLength(2)
    // 已选起点在终点下拉里被禁用（另一端已选的实体不能重复选）
    const targetOptions = target.findAllComponents(OptionStub)
    expect(targetOptions.map(o => o.props('disabled'))).toEqual([true, false])
  })
})
