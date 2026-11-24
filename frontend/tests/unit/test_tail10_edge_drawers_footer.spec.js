// @vitest-environment jsdom
/**
 * GraphEdgeDrawers.vue —— 补齐 test_gviz_edge_drawers.spec.js 没覆盖的渲染面：
 *
 * el-drawer 换成「渲染 header/default/footer 三层插槽、v-model 双向」的桩：
 * - footer 的三个按钮真渲染，点击分别调 store 的 close/confirm/cancel；
 * - 抽屉与折叠面板的 v-model 写回（update:modelValue → store 上的 visible/collapse）；
 * - 禁用基础字段与 BOOLEAN 下拉的 update:modelValue 也能写回 editForm。
 */
import { describe, expect, it } from 'vitest'
import { h, reactive } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'

import GraphEdgeDrawers from '@/features/graph/components/graph-visualization/GraphEdgeDrawers.vue'

function makeEdgeStore () {
  return reactive({
    selectedEdge: {
      edge_id: 'r1',
      edge_type: 'Relates',
      source_id: 'a',
      target_id: 'b',
      properties: { weight: 3, enabled: 'true' }
    },
    viewDrawerVisible: true,
    editDrawerVisible: true,
    viewCollapse: ['basic', 'properties'],
    editCollapse: ['basic', 'properties'],
    editForm: {
      edge_id: 'r1',
      class: 'Relates',
      rid: '',
      source_id: 'a',
      target_id: 'b',
      in: '',
      out: '',
      properties: { weight: 3, enabled: 'true' }
    },
    getEdgePropertyDef: (_edgeType, propName) => (propName === 'enabled' ? { name: 'enabled', type: 'BOOLEAN' } : null),
    handleCloseEdgeDrawer: () => {},
    handleConfirmEditEdge: () => {},
    handleCancelEditEdge: () => {}
  })
}

/** el-drawer 桩：v-model 双向 + header/default/footer 全渲染。 */
const DrawerStub = {
  name: 'ElDrawer',
  props: ['modelValue', 'title', 'modal', 'direction', 'size'],
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => h('div', { class: 'drawer-stub', 'data-visible': String(props.modelValue) }, [
      props.modelValue
        ? [
          slots.header ? slots.header() : null,
          slots.default ? slots.default() : null,
          slots.footer ? h('div', { class: 'stub-footer' }, slots.footer()) : null
        ]
        : null
    ])
  }
}

/** el-collapse / el-collapse-item 桩：渲染插槽 + v-model 双向。 */
const CollapseStub = {
  name: 'ElCollapse',
  props: { modelValue: { type: Array, default: () => [] } },
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => h('div', {
      class: 'collapse-stub',
      onClick: () => emit('update:modelValue', props.modelValue.length ? [] : ['basic'])
    }, slots.default ? slots.default() : [])
  }
}
const CollapseItemStub = {
  name: 'ElCollapseItem',
  props: ['title', 'name'],
  setup (props, { slots }) {
    return () => h('div', { class: 'collapse-item-stub', 'data-name': props.name }, slots.default ? slots.default() : [])
  }
}

/** el-select 桩：渲染插槽（el-option），可发 update:modelValue。 */
const SelectStub = {
  name: 'ElSelect',
  props: { modelValue: { default: '' } },
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => h('div', { class: 'select-stub' }, [
      h('button', { class: 'select-true', onClick: () => emit('update:modelValue', 'true') }),
      h('button', { class: 'select-false', onClick: () => emit('update:modelValue', 'false') }),
      slots.default ? slots.default() : []
    ])
  }
}

async function mountDrawers (edge) {
  return mountWithPlugins(GraphEdgeDrawers, {
    router: null,
    props: { edge },
    global: {
      components: {
        ElDrawer: DrawerStub,
        ElCollapse: CollapseStub,
        ElCollapseItem: CollapseItemStub,
        ElSelect: SelectStub,
        ElOption: { name: 'ElOption', props: ['label', 'value'], template: '<div class="option-stub" />' }
      }
    }
  })
}

describe('GraphEdgeDrawers：footer 与 v-model 写回', () => {
  it('查看抽屉 footer 的「关闭」按钮调 store.handleCloseEdgeDrawer', async () => {
    const edge = makeEdgeStore()
    const calls = []
    edge.handleCloseEdgeDrawer = () => calls.push('close')
    const wrapper = await mountDrawers(edge)

    const viewFooter = wrapper.findAll('.drawer-stub')[0].find('.stub-footer')
    expect(viewFooter.text()).toContain('关闭')
    await viewFooter.find('button').trigger('click')
    expect(calls).toEqual(['close'])
  })

  it('编辑抽屉 footer：「确认」「取消」分别调 confirm / cancel', async () => {
    const edge = makeEdgeStore()
    const calls = []
    edge.handleConfirmEditEdge = () => calls.push('confirm')
    edge.handleCancelEditEdge = () => calls.push('cancel')
    const wrapper = await mountDrawers(edge)

    const footer = wrapper.findAll('.drawer-stub')[1].find('.stub-footer')
    const buttons = footer.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].text()).toContain('确定')
    expect(buttons[1].text()).toContain('取消')
    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    expect(calls).toEqual(['confirm', 'cancel'])
  })

  it('抽屉 / 折叠面板的 v-model 写回 store（visible 与 collapse）', async () => {
    const edge = makeEdgeStore()
    const wrapper = await mountDrawers(edge)

    const [viewDrawer, editDrawer] = wrapper.findAll('.drawer-stub')
    expect(viewDrawer.attributes('data-visible')).toBe('true')
    expect(editDrawer.attributes('data-visible')).toBe('true')

    // 折叠面板：点一下 → 全收起（此时抽屉还开着）
    await wrapper.findAll('.collapse-stub')[0].trigger('click')
    await wrapper.findAll('.collapse-stub')[1].trigger('click')
    expect(edge.viewCollapse).toEqual([])
    expect(edge.editCollapse).toEqual([])

    // v-model → store 上的可见性
    wrapper.findAllComponents(DrawerStub)[0].vm.$emit('update:modelValue', false)
    wrapper.findAllComponents(DrawerStub)[1].vm.$emit('update:modelValue', false)
    await flush()
    expect(edge.viewDrawerVisible).toBe(false)
    expect(edge.editDrawerVisible).toBe(false)
    // 关掉后抽屉体不渲染
    expect(wrapper.findAll('.collapse-stub')).toHaveLength(0)
  })

  it('BOOLEAN 属性下拉选择写回 editForm.properties；禁用基础字段的 v-model 也能写', async () => {
    const edge = makeEdgeStore()
    const wrapper = await mountDrawers(edge)

    await wrapper.find('.select-stub .select-false').trigger('click')
    expect(edge.editForm.properties.enabled).toBe('false')
    await wrapper.find('.select-stub .select-true').trigger('click')
    expect(edge.editForm.properties.enabled).toBe('true')

    // 禁用的基础字段（edge_id/class/source_id/target_id）update:modelValue 照样写回
    const inputs = wrapper.findAllComponents({ name: 'ElInput' })
    expect(inputs.length).toBeGreaterThanOrEqual(4)
    inputs.forEach((input, index) => input.vm.$emit('update:modelValue', `v${index}`))
    inputs[0].vm.$emit('update:modelValue', 'r9')
    inputs[1].vm.$emit('update:modelValue', 'Follows')
    await flush()
    expect(edge.editForm.edge_id).toBe('r9')
    expect(edge.editForm.class).toBe('Follows')
  })
})
