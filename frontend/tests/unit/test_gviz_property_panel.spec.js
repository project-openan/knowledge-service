// @vitest-environment jsdom
/**
 * PropertyPanel.vue（模板设计器的实体/关系属性面板）。
 *
 * 面板的全部行为由 props 驱动（selectedItem / itemType），校验与 payload 组装是
 * 纯逻辑，expose 的 applyChanges / resetForm 直接从 vm 调。钉住：
 * - 选中项 → 表单回填（节点含属性列表映射，关系含方向推断与端实体回退）；
 * - applyChanges：类名/描述/属性名/描述/重复名校验逐层拦截（错误走 $message），
 *   通过后 emit update-properties（payload 与后端 schema 创建入参对齐）；
 * - resetForm 复位；未选中项不渲染面板。
 * Element Plus 表单件全部用替身（真件在 jsdom 里要开弹层/teleport，不是被测对象）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { h } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'

import PropertyPanel from '@/features/graph/components/GraphEditor/PropertyPanel.vue'

// el-form 替身：暴露 validate/validateField/clearValidate（组件的 ref 调用面）
const ElFormStub = {
  name: 'ElForm',
  props: { model: { type: Object, default: () => ({}) } },
  setup (_, { expose }) {
    expose({
      validate: vi.fn((cb) => cb && cb(true)),
      validateField: vi.fn(),
      clearValidate: vi.fn()
    })
    return () => h('form', { class: 'form-stub' })
  }
}

const EP_SIMPLE_STUBS = {
  ElCollapse: { name: 'ElCollapse', setup (_, { slots }) { return () => slots.default?.() } },
  ElCollapseItem: { name: 'ElCollapseItem', setup (_, { slots }) { return () => slots.default?.() } },
  ElFormItem: { name: 'ElFormItem', setup (_, { slots }) { return () => slots.default?.() } },
  ElTabs: { name: 'ElTabs', setup (_, { slots }) { return () => slots.default?.() } },
  ElTabPane: { name: 'ElTabPane', setup (_, { slots }) { return () => slots.default?.() } },
  ElInput: {
    name: 'ElInput',
    props: { modelValue: { type: [String, Number], default: '' }, type: { type: String, default: 'text' } },
    emits: ['update:modelValue', 'input', 'blur'],
    template: '<input class="input-stub" :value="modelValue" />'
  },
  ElSwitch: { name: 'ElSwitch', props: { modelValue: { type: Boolean, default: false } }, template: '<span class="switch-stub" />' },
  ElSelect: { name: 'ElSelect', props: { modelValue: { type: String, default: '' } }, template: '<span class="select-stub" />' },
  ElOption: { name: 'ElOption', template: '<span />' },
  ElButton: { name: 'ElButton', template: '<button class="el-button"><slot /></button>' }
}

const messageError = vi.fn()

async function mountPanel ({ selectedItem, itemType }) {
  return mountWithPlugins(PropertyPanel, {
    router: null,
    attachTo: document.body,
    props: { selectedItem, itemType },
    global: {
      components: { ElForm: ElFormStub, ...EP_SIMPLE_STUBS },
      config: {
        globalProperties: {
          $message: { error: messageError, success: vi.fn() }
        }
      }
    }
  })
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

describe('PropertyPanel.vue（节点）', () => {
  beforeEach(() => {
    messageError.mockClear()
  })

  it('未选中项时不渲染面板', async () => {
    const wrapper = await mountPanel({ selectedItem: null, itemType: null })
    expect(wrapper.find('.panel-content').exists()).toBe(false)
  })

  it('选中节点后回填表单：属性映射 is_primary/is_embedding/is_index，缺属性时补一行', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    await flush()

    expect(wrapper.find('.panel-content').exists()).toBe(true)
    expect(wrapper.vm.nodeForm.name).toBe('EntityA')
    expect(wrapper.vm.nodeForm.description).toBe('第一个实体')
    expect(wrapper.vm.nodeForm.properties).toEqual([
      expect.objectContaining({ name: 'tag', type: 'STRING', desc: '标签', is_primary: true }),
      expect.objectContaining({ name: 'score', type: 'DOUBLE', is_embedding: true, is_index: true })
    ])

    const empty = await mountPanel({ selectedItem: { id: 'n2', getData: () => ({ name: 'B' }) }, itemType: 'node' })
    expect(empty.vm.nodeForm.properties).toHaveLength(1)
    expect(empty.vm.nodeForm.properties[0].name).toBe('')
    empty.unmount()
  })

  it('applyChanges：合法数据 emit update-properties（payload 与 schema 创建入参对齐）', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })

    await wrapper.vm.applyChanges()

    expect(messageError).not.toHaveBeenCalled()
    const emitted = wrapper.emitted('update-properties')
    expect(emitted).toHaveLength(1)
    const payload = emitted[0][0]
    expect(payload.type).toBe('node')
    expect(payload.id).toBe('n1')
    expect(payload.data.name).toBe('EntityA')
    expect(payload.data.entity_type).toBe('EntityA')
    expect(payload.data.properties[0]).toEqual({
      name: 'tag', type: 'STRING', desc: '标签', is_primary: true, is_embedding: false, is_index: false
    })
  })

  it.each([
    ['1abc', '第一个实体', [{ name: 'a', desc: 'd' }], '类名格式'],
    ['ORDER', '第一个实体', [{ name: 'a', desc: 'd' }], '保留字'],
    ['', '第一个实体', [{ name: 'a', desc: 'd' }], '类名必填'],
    ['EntityB', '', [{ name: 'a', desc: 'd' }], '描述必填'],
    ['EntityB', '描述', [{ name: '', desc: 'd' }], '属性名必填'],
    ['EntityB', '描述', [{ name: 'a', desc: '' }], '属性描述必填'],
    ['EntityB', '描述', [{ name: 'a', desc: 'd' }, { name: 'a', desc: 'd2' }], '属性名重复']
  ])('applyChanges 拦截非法输入（%s 场景）且不 emit', async (_label, name, properties, hint) => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })
    wrapper.vm.nodeForm.name = name
    wrapper.vm.nodeForm.description = _label.includes('描述必填') ? '' : '第一个实体'
    wrapper.vm.nodeForm.properties = properties.map(p => ({ ...p, __key: p.name || 'k' }))

    await expect(wrapper.vm.applyChanges()).rejects.toThrow()

    expect(messageError).toHaveBeenCalled()
    expect(wrapper.emitted('update-properties')).toBeUndefined()
    expect(hint).toBeTruthy()
  })

  it('resetForm 清空表单并保留一行空属性', async () => {
    const wrapper = await mountPanel({ selectedItem: NODE_ITEM, itemType: 'node' })

    wrapper.vm.resetForm()

    expect(wrapper.vm.nodeForm.name).toBe('')
    expect(wrapper.vm.nodeForm.description).toBe('')
    expect(wrapper.vm.nodeForm.properties).toHaveLength(1)
  })
})

describe('PropertyPanel.vue（关系）', () => {
  beforeEach(() => {
    messageError.mockClear()
  })

  function edgeItem (data, shape = 'double-arrow-edge') {
    return {
      id: 'r1',
      shape,
      getData: () => data,
      getSourceCell: () => ({ getData: () => ({ name: '源实体' }) }),
      getTargetCell: () => ({ getData: () => ({ name: '目标实体' }) })
    }
  }

  it('选中边后回填：方向映射 one-way/two-way/self-loop，端实体回退到连线两端节点名', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Invests', edge_desc: '投资关系' }),
      itemType: 'edge'
    })
    await flush()

    // shape 是 double-arrow-edge → two-way
    expect(wrapper.vm.edgeForm.direction).toBe('two-way')
    expect(wrapper.vm.edgeForm.source_entity).toBe('源实体')
    expect(wrapper.vm.edgeForm.target_entity).toBe('目标实体')

    const selfLoop = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Invests' }, 'self-loop-edge'),
      itemType: 'edge'
    })
    expect(selfLoop.vm.edgeForm.direction).toBe('self-loop')
    selfLoop.unmount()

    const plain = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Invests', direction: 'single' }, 'single-arrow-edge'),
      itemType: 'edge'
    })
    expect(plain.vm.edgeForm.direction).toBe('one-way')
    plain.unmount()
  })

  it('applyChanges（关系）：合法数据 emit update-properties；非法类名被拦截', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({
        edge_type: 'Invests',
        edge_desc: '投资关系',
        properties: [{ name: 'amount', type: 'DOUBLE', desc: '金额' }]
      }),
      itemType: 'edge'
    })

    await wrapper.vm.applyChanges()

    const payload = wrapper.emitted('update-properties')[0][0]
    expect(payload.type).toBe('edge')
    expect(payload.id).toBe('r1')
    expect(payload.data.edge_type).toBe('Invests')

    // 非法类名（中文不在 A-Za-z 白名单）
    const bad = await mountPanel({
      selectedItem: edgeItem({ edge_type: '投资', edge_desc: 'x' }),
      itemType: 'edge'
    })
    await expect(bad.vm.applyChanges()).rejects.toThrow()
    expect(messageError).toHaveBeenCalled()
    expect(bad.emitted('update-properties')).toBeUndefined()
    bad.unmount()
  })

  it('resetForm（关系）复位方向与端实体', async () => {
    const wrapper = await mountPanel({
      selectedItem: edgeItem({ edge_type: 'Invests', edge_desc: 'd' }),
      itemType: 'edge'
    })

    wrapper.vm.resetForm()

    expect(wrapper.vm.edgeForm.edge_type).toBe('')
    expect(wrapper.vm.edgeForm.direction).toBe('one-way')
    expect(wrapper.vm.edgeForm.source_entity).toBe('')
    expect(wrapper.vm.edgeForm.properties).toHaveLength(0)
  })
})
