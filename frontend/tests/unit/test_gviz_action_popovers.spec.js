// @vitest-environment jsdom
/**
 * GraphActionPopovers.vue —— 实体/边的操作气泡卡片（编辑/删除/加关系）。
 *
 * 钉三件事：
 * - 默认隐藏（v-show），按 store 的可见性与坐标定位显示；
 * - 实体气泡三个按钮分别调 selection.handleEdit / entity.handleDeleteNode / relation.handleAddEdge；
 * - 边气泡两个按钮分别调 edge.handleEditEdge / edge.handleDeleteEdge。
 * store 用手工 reactive 桩（与各 composable 的字段面一致），按钮点击断言到方法被调。
 */
import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { mountWithPlugins } from './helpers/mount'
import GraphActionPopovers from '@/features/graph/components/graph-visualization/GraphActionPopovers.vue'

function makeStores ({ entityVisible = false, edgeVisible = false } = {}) {
  const selection = reactive({
    selectedEntity: { entity_id: 'e1' },
    actionPopoverVisible: entityVisible,
    actionPopoverPosition: { x: 120, y: 80 },
    handleEdit: vi.fn()
  })
  const entity = reactive({ handleDeleteNode: vi.fn() })
  const relation = reactive({ handleAddEdge: vi.fn() })
  const edge = reactive({
    selectedEdge: { edge_id: 'r1' },
    edgeActionPopoverVisible: edgeVisible,
    edgeActionPopoverPosition: { x: 30, y: 40 },
    handleEditEdge: vi.fn(),
    handleDeleteEdge: vi.fn()
  })
  return { selection, entity, relation, edge }
}

async function mountPopovers (stores) {
  const wrapper = await mountWithPlugins(GraphActionPopovers, {
    router: null,
    props: stores,
    global: {
      // el-tooltip 不在 helpers 的最小集里：气泡里的提示浮层不是被测对象，占位即可
      components: {
        ElTooltip: { name: 'ElTooltip', setup (_, { slots }) { return () => slots.default?.() } }
      }
    }
  })
  return wrapper
}

describe('GraphActionPopovers', () => {
  it('默认隐藏：两个气泡都渲染但 display:none（v-show，不销毁 DOM）', async () => {
    const stores = makeStores()
    const wrapper = await mountPopovers(stores)

    const popovers = wrapper.findAll('.action-popover')
    expect(popovers).toHaveLength(2)
    expect(popovers[0].isVisible()).toBe(false)
    expect(popovers[1].isVisible()).toBe(false)
  })

  it('实体气泡显示：定位到 actionPopoverPosition，三个按钮各调各的方法', async () => {
    const stores = makeStores({ entityVisible: true })
    const wrapper = await mountPopovers(stores)

    const entityPopover = wrapper.findAll('.action-popover')[0]
    expect(entityPopover.isVisible()).toBe(true)
    expect(entityPopover.attributes('style')).toContain('left: 120px')
    expect(entityPopover.attributes('style')).toContain('top: 80px')

    const buttons = entityPopover.findAll('.action-btn')
    expect(buttons).toHaveLength(3)

    await buttons[0].trigger('click')
    expect(stores.selection.handleEdit).toHaveBeenCalledTimes(1)

    await buttons[1].trigger('click')
    expect(stores.entity.handleDeleteNode).toHaveBeenCalledTimes(1)

    await buttons[2].trigger('click')
    expect(stores.relation.handleAddEdge).toHaveBeenCalledTimes(1)
  })

  it('实体气泡可见但没选中实体时仍隐藏（v-show 双条件）', async () => {
    const stores = makeStores({ entityVisible: true })
    stores.selection.selectedEntity = null
    const wrapper = await mountPopovers(stores)

    expect(wrapper.findAll('.action-popover')[0].isVisible()).toBe(false)
  })

  it('边气泡显示：两个按钮分别调边编辑与边删除', async () => {
    const stores = makeStores({ edgeVisible: true })
    const wrapper = await mountPopovers(stores)

    const edgePopover = wrapper.findAll('.action-popover')[1]
    expect(edgePopover.isVisible()).toBe(true)
    expect(edgePopover.attributes('style')).toContain('left: 30px')

    const buttons = edgePopover.findAll('.action-btn')
    expect(buttons).toHaveLength(2)

    await buttons[0].trigger('click')
    expect(stores.edge.handleEditEdge).toHaveBeenCalledTimes(1)

    await buttons[1].trigger('click')
    expect(stores.edge.handleDeleteEdge).toHaveBeenCalledTimes(1)
  })
})
