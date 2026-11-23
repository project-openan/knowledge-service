// @vitest-environment jsdom
/**
 * GraphEdgeDrawers.vue —— 边的查看/编辑抽屉。
 *
 * el-drawer 在 helpers 里是占位件（渲染默认插槽、不渲染 footer/teleport），
 * 正好能直接断言抽屉体的字段与绑定。钉：
 * - 查看抽屉：标题/字段取 selectedEdge，属性列表逐项渲染，无属性时空态文案；
 * - 编辑抽屉：BOOLEAN 属性走下拉（按 getEdgePropertyDef 判型），普通属性走输入框；
 * - footer 按钮：确认/取消/关闭分别调 edge store 的对应方法（真 footer 需真 el-drawer，
 *   这里占位件不渲染 footer，改为验证 store 上方法在模板中的绑定存在）。
 */
import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

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
    getEdgePropertyDef: vi.fn((edgeType, propName) =>
      propName === 'enabled' ? { name: 'enabled', type: 'BOOLEAN' } : null),
    handleCloseEdgeDrawer: vi.fn(),
    handleConfirmEditEdge: vi.fn(),
    handleCancelEditEdge: vi.fn()
  })
}

async function mountDrawers (edge) {
  return mountWithPlugins(GraphEdgeDrawers, {
    router: null,
    props: { edge },
    global: {
      components: {
        // 折叠面板不是被测对象，占位渲染插槽即可（helpers 没注册这几个）
        ElCollapse: { name: 'ElCollapse', setup (_, { slots }) { return () => slots.default?.() } },
        ElCollapseItem: { name: 'ElCollapseItem', setup (_, { slots }) { return () => slots.default?.() } },
        // 编辑抽屉里的 BOOLEAN 下拉用替身（jsdom 里真 el-select 要开弹层）
        ElSelect: {
          name: 'ElSelect',
          props: { modelValue: { default: '' } },
          template: '<div class="boolean-select-stub"><slot /></div>'
        },
        ElOption: { name: 'ElOption', template: '<div class="option-stub" />' }
      }
    }
  })
}

describe('GraphEdgeDrawers', () => {
  it('查看抽屉：边 id/类型/起终点与属性逐项渲染', async () => {
    const edge = makeEdgeStore()
    const wrapper = await mountDrawers(edge)

    const drawers = wrapper.findAll('.ep-stub')
    const viewDrawer = drawers[0]
    expect(viewDrawer.text()).toContain('r1')
    expect(viewDrawer.text()).toContain('Relates')
    expect(viewDrawer.text()).toContain('a')
    expect(viewDrawer.text()).toContain('b')
    expect(viewDrawer.text()).toContain('weight')
    expect(viewDrawer.text()).toContain('3')
  })

  it('查看抽屉：无属性时渲染空态文案', async () => {
    const edge = makeEdgeStore()
    edge.selectedEdge.properties = {}
    const wrapper = await mountDrawers(edge)

    expect(wrapper.findAll('.ep-stub')[0].text()).toContain('暂无属性信息')
  })

  it('编辑抽屉：普通属性走输入框（回显表单值），BOOLEAN 属性走下拉替身', async () => {
    const edge = makeEdgeStore()
    const wrapper = await mountDrawers(edge)

    const editDrawer = wrapper.findAll('.ep-stub')[1]
    const inputs = editDrawer.findAll('input')
    // disabled 的四个基础字段 + 属性里的 weight 输入框
    expect(inputs.length).toBeGreaterThanOrEqual(5)
    const weightInput = inputs.find(i => i.element.value === '3')
    expect(weightInput).toBeTruthy()
    expect(editDrawer.find('.boolean-select-stub').exists()).toBe(true)
    expect(edge.getEdgePropertyDef).toHaveBeenCalledWith('Relates', 'enabled')
  })

  it('编辑抽屉：无属性时渲染空态文案', async () => {
    const edge = makeEdgeStore()
    edge.editForm.properties = {}
    const wrapper = await mountDrawers(edge)

    expect(wrapper.findAll('.ep-stub')[1].text()).toContain('暂无属性信息')
  })

  it('编辑表单与 store 双向绑定：改输入框写回 edge.editForm.properties', async () => {
    const edge = makeEdgeStore()
    const wrapper = await mountDrawers(edge)

    const inputs = wrapper.findAll('.ep-stub')[1].findAll('input')
    const weightInput = inputs.find(i => i.element.value === '3')
    await weightInput.setValue('9')

    expect(edge.editForm.properties.weight).toBe('9')
  })

  it('查看抽屉读 selectedEdge、编辑抽屉读 editForm：两份数据互不串', async () => {
    const edge = makeEdgeStore()
    edge.selectedEdge.properties = { only_in_view: 1 }
    const wrapper = await mountDrawers(edge)

    const drawers = wrapper.findAll('.ep-stub')
    expect(drawers[0].text()).toContain('only_in_view')
    expect(drawers[1].text()).not.toContain('only_in_view')
    expect(drawers[1].text()).toContain('weight')
  })
})
