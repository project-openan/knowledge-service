// @vitest-environment jsdom
// 图谱可视化组合层（GraphVisualization.vue）的交互残余分支（9/6 之图一）：
// 「添加关系」按钮、沉浸画布的工具开关、三个抽屉的 v-model 关闭与 add-relation 上抛、
// getAvailableEdgeTypesForEntities、stopGraphLoading、拿不到知识库 ID 的报错分支、
// 搜索清空事件、容器点击退出连线模式（DOM 与画布两条通路）、批量处理中的数据同步。
// 基础覆盖见 test_gviz_graph_visualization.spec.js。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'

vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  createEntityApi: vi.fn(),
  updateEntityApi: vi.fn(),
  deleteEntityApi: vi.fn(),
  updateEdgeApi: vi.fn(),
  deleteEdgeApi: vi.fn(),
  createEdgeApi: vi.fn()
}))

import GraphVisualization from '@/features/graph/components/GraphVisualization.vue'

const canvasSpies = {}
function makeCanvasStub () {
  return {
    name: 'GraphCanvasVisStub',
    props: ['graphData', 'colorMap', 'edgeColorMap', 'graphId', 'resetToken'],
    emits: ['node-click', 'edge-click', 'container-click', 'zoom-change', 'node-double-click', 'edge-double-click', 'toggle-expand', 'after-drawing'],
    setup (_, { expose }) {
      expose({
        selectNodes: vi.fn(),
        focusNode: vi.fn(),
        syncVisibilityFromHiddenProps: vi.fn(),
        compactLayoutToFit: vi.fn(),
        updateNode: vi.fn(),
        addNode: vi.fn(() => ({ x: 5, y: 6 })),
        addEdge: vi.fn()
      })
      return () => h('div', { class: 'canvas-stub' })
    }
  }
}

function makeControlsStub () {
  return {
    name: 'GraphControlsStub',
    props: ['entityTypes', 'edgeTypes', 'limitValue', 'searchKeyword', 'resetToken', 'refreshGraph'],
    emits: ['entity-type-change', 'edge-type-change', 'limit-change', 'depth-change', 'export', 'search-input', 'search-clear', 'execute-query', 'query-type-change', 'advanced-open'],
    setup (_, { expose }) {
      expose({ openAdvanced: vi.fn() })
      return () => h('div', { class: 'controls-stub' })
    }
  }
}

function makeDrawerStub (name, markerClass) {
  return {
    name,
    props: ['modelValue'],
    emits: ['update:modelValue', 'create', 'save', 'select', 'locate', 'add-relation'],
    setup (props) {
      return () => h('div', { class: markerClass, 'data-visible': String(!!props.modelValue) })
    }
  }
}

const GRAPH_DATA = {
  entities: [
    { entity_id: 'e1', entity_type: 'Scene', entity_name: '场景A' },
    { entity_id: 'e2', entity_type: 'Resource', entity_name: '资源B' }
  ],
  edges: [{ edge_id: 'r1', edge_type: 'Relates', source_id: 'e1', target_id: 'e2' }]
}

async function mountViz ({ route = '/graph/detail/kb-9', graphData = GRAPH_DATA } = {}) {
  const wrapper = await mountWithPlugins(GraphVisualization, {
    route,
    routes: [
      { path: '/graph/detail/:id', name: 'graph-detail', component: { render: () => null } },
      { path: '/graph', name: 'graph', component: { render: () => null } },
      { path: '/:pathMatch(.*)*', component: { render: () => null } }
    ],
    props: { graphData, limitValue: 100 },
    global: {
      stubs: {
        GraphControls: makeControlsStub(),
        GraphCanvasVis: makeCanvasStub(),
        GraphEntityDrawer: makeDrawerStub('GraphEntityDrawerStub', 'entity-drawer-stub'),
        GraphEntityCreateDrawer: makeDrawerStub('GraphEntityCreateDrawerStub', 'entity-create-stub'),
        GraphRelationCreateDrawer: makeDrawerStub('GraphRelationCreateDrawerStub', 'relation-drawer-stub')
      },
      config: {
        globalProperties: {
          $message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
          $confirm: vi.fn().mockResolvedValue()
        }
      }
    }
  })
  await flush()
  return wrapper
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('GraphVisualization：交互残余', () => {
  it('「添加关系」按钮：打开关系抽屉', async () => {
    const wrapper = await mountViz()
    const buttons = wrapper.findAll('.graph-create-actions button')
    await buttons[1].trigger('click')
    await flush()
    const drawer = wrapper.findComponent({ name: 'GraphRelationCreateDrawerStub' })
    expect(drawer.props('modelValue')).toBe(true)
  })

  it('三个抽屉的 v-model 关闭与 add-relation 上抛', async () => {
    const wrapper = await mountViz()
    const entityDrawer = wrapper.findComponent({ name: 'GraphEntityDrawerStub' })
    entityDrawer.vm.$emit('update:modelValue', false)
    await flush()
    const createDrawer = wrapper.findComponent({ name: 'GraphEntityCreateDrawerStub' })
    createDrawer.vm.$emit('update:modelValue', false)
    const relationDrawer = wrapper.findComponent({ name: 'GraphRelationCreateDrawerStub' })
    relationDrawer.vm.$emit('update:modelValue', false)
    await flush()
    // add-relation 上抛：关系抽屉被打开
    entityDrawer.vm.$emit('add-relation')
    await flush()
    expect(wrapper.findComponent({ name: 'GraphRelationCreateDrawerStub' }).props('modelValue')).toBe(true)
  })

  it('getAvailableEdgeTypesForEntities：按两端类型给可用边类型', async () => {
    const wrapper = await mountViz({ graphData: { ...GRAPH_DATA, schemaMapping: undefined } })
    const types = wrapper.vm.getAvailableEdgeTypesForEntities('Scene', 'Resource')
    expect(Array.isArray(types)).toBe(true)
  })

  it('stopGraphLoading：向父组件上报停止加载', async () => {
    const wrapper = await mountViz()
    wrapper.vm.stopGraphLoading()
    expect(wrapper.emitted('refresh-graph-data').at(-1)[0]).toEqual({ stopLoading: true })
  })

  it('拿不到知识库 ID：报错并提示（route 与 props 都没有）', async () => {
    const wrapper = await mountViz({ route: '/graph' })
    const id = wrapper.vm.getKnowledgeBaseId()
    expect(id).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })

  it('搜索清空事件：向父组件转发', async () => {
    const wrapper = await mountViz()
    const controls = wrapper.findComponent({ name: 'GraphControlsStub' })
    controls.vm.$emit('search-clear')
    await flush()
    expect(wrapper.emitted('search-clear')).toHaveLength(1)
  })

  it('连线模式下点容器空白：DOM 与画布两条通路都退出连线', async () => {
    const wrapper = await mountViz()
    await wrapper.setProps({ searchKeyword: 'kw' })
    await flush()
    // 进入连线模式
    wrapper.vm.relation.isAddingEdgeMode = true
    await wrapper.find('.graph-container').trigger('click')
    await flush()
    expect(wrapper.vm.relation.isAddingEdgeMode).toBe(false)

    // 画布空白点击通路
    wrapper.vm.relation.isAddingEdgeMode = true
    wrapper.findComponent({ name: 'GraphCanvasVisStub' }).vm.$emit('container-click')
    await flush()
    expect(wrapper.vm.relation.isAddingEdgeMode).toBe(false)
  })

  it('批量处理中 props.graphData 变化：只更新缓存不渲染', async () => {
    let resolveCreate
    const { createEntityApi } = await import('@/features/graph/api/knowledgeGraph')
    createEntityApi.mockImplementation(() => new Promise(resolve => { resolveCreate = resolve }))
    const wrapper = await mountViz()
    const createDrawer = wrapper.findComponent({ name: 'GraphEntityCreateDrawerStub' })
    createDrawer.vm.$emit('create', { entityId: 'ent-x', entityType: 'Scene', entityName: '新', properties: {} })
    await flush()

    // 创建仍在途（批量中）：数据变化只进缓存
    await wrapper.setProps({
      graphData: { entities: [...GRAPH_DATA.entities, { entity_id: 'e9', entity_type: 'Scene' }], edges: GRAPH_DATA.edges }
    })
    expect(wrapper.vm.graphDataCache.entities.some(e => e.entity_id === 'e9')).toBe(true)

    resolveCreate({ success: true })
    await flush()
    await flush()
  })
})
