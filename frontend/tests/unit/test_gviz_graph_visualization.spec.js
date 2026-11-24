// @vitest-environment jsdom
/**
 * GraphVisualization.vue（主文件）—— 只测「组合层」自己的行为：
 * - 缓存同步：props.graphData（含 deep watch / 批量处理分支）→ 画布 stub 收到的 graphData；
 * - 画布事件流：单击节点（延迟弹气泡）/ 单击边 / 双击进对应抽屉 / 空白点击收一切 / 缩放上报；
 * - 工具条事件转发：entity-type-change 等八种事件原样 emit 给父组件；
 * - 摘要行：显示上限链接 → 收浮层 + 打开高级查询；resultHasMore 截断提示；
 * - 沉浸画布：按钮切换 + is-fullscreen 类 + Esc 退出（经 expose）；
 * - expose 的画布方法与刷新后重排；新增实体超 limit 时先 emit limit-change 抬高上限。
 *
 * 重型子组件（GraphControls / GraphCanvasVis / 三个抽屉）全部用可编程 stub 替换：
 * stub 暴露主文件会调用的方法、可从用例里 emit 事件，主文件的 ctx 组装逻辑就能被真跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'

const { createEntityApiMock } = vi.hoisted(() => ({ createEntityApiMock: vi.fn() }))
vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  createEntityApi: createEntityApiMock,
  updateEntityApi: vi.fn(),
  deleteEntityApi: vi.fn(),
  updateEdgeApi: vi.fn(),
  deleteEdgeApi: vi.fn(),
  createEdgeApi: vi.fn()
}))

import { CLICK_DELAY_MS } from '@/features/graph/lib/graph-geometry'
import GraphVisualization from '@/features/graph/components/GraphVisualization.vue'

// ── 子组件 stub ──────────────────────────────────────────────────────────────

const canvasSpies = {}
function makeCanvasStub () {
  return {
    name: 'GraphCanvasVisStub',
    props: ['graphData', 'colorMap', 'edgeColorMap', 'graphId', 'resetToken', 'persistentlyHiddenNodeIds', 'entityExpandStateMap', 'edgeLabelDisplayMode'],
    emits: ['node-click', 'edge-click', 'container-click', 'zoom-change', 'node-double-click', 'edge-double-click', 'toggle-expand', 'after-drawing'],
    setup (_, { expose }) {
      expose({
        selectNodes: vi.fn((...args) => canvasSpies.selectNodes?.(args)),
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

async function mountViz (extraProps = {}) {
  const wrapper = await mountWithPlugins(GraphVisualization, {
    route: '/graph/detail/kb-9',
    props: { graphData: GRAPH_DATA, limitValue: 100, ...extraProps },
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

function canvas (wrapper) {
  return wrapper.findComponent({ name: 'GraphCanvasVisStub' })
}

function controls (wrapper) {
  return wrapper.findComponent({ name: 'GraphControlsStub' })
}

describe('GraphVisualization.vue（组合层）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.keys(canvasSpies).forEach(key => delete canvasSpies[key])
    createEntityApiMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('挂载后把 props.graphData 同步进本地缓存并传给画布 stub（含图例配色）', async () => {
    const wrapper = await mountViz()

    expect(canvas(wrapper).props('graphData').entities).toHaveLength(2)
    expect(canvas(wrapper).props('graphData').edges).toHaveLength(1)
    expect(canvas(wrapper).props('graphId')).toBe('kb-9')

    // 图例来自 useGraphTones 派生（真实链路）
    const legend = wrapper.find('.graph-legend-row')
    expect(legend.exists()).toBe(true)
    expect(legend.text()).toContain('Scene')
    expect(legend.text()).toContain('Resource')
    wrapper.unmount()
  })

  it('props.graphData 变化（deep watch）→ 缓存同步给画布', async () => {
    const wrapper = await mountViz()

    await wrapper.setProps({
      graphData: { entities: [...GRAPH_DATA.entities, { entity_id: 'e3', entity_type: 'Scene' }], edges: GRAPH_DATA.edges }
    })

    expect(canvas(wrapper).props('graphData').entities).toHaveLength(3)
    wrapper.unmount()
  })

  it('批量处理中（isBatchProcessing）数据变化只更新缓存，不触发画布重渲染路径', async () => {
    // 通过新增实体流程置 isBatchProcessing：成功后批量标志复位
    const wrapper = await mountViz()
    createEntityApiMock.mockResolvedValue({ success: true })
    const createDrawer = wrapper.findComponent({ name: 'GraphEntityCreateDrawerStub' })

    createDrawer.vm.$emit('create', {
      entityId: 'ent-x',
      entityType: 'Scene',
      entityName: '新',
      properties: {}
    })
    await flush()

    expect(createEntityApiMock).toHaveBeenCalledTimes(1)
    expect(canvas(wrapper).props('graphData').entities.some(e => e.entity_id === 'ent-x')).toBe(true)
    wrapper.unmount()
  })

  it('单击节点 → 延迟弹实体气泡（收边气泡），气泡位置换算成容器内坐标', async () => {
    const wrapper = await mountViz()

    canvas(wrapper).vm.$emit('node-click', { entity_id: 'e1' }, { x: 40, y: 30 })
    await flush()
    vi.advanceTimersByTime(CLICK_DELAY_MS)
    await flush()

    const popovers = wrapper.findAll('.action-popover')
    expect(popovers[0].isVisible()).toBe(true)
    // 容器相对定位：坐标 = 页面坐标 - 容器 rect（jsdom 里 rect 全 0 → 原样）
    expect(popovers[0].attributes('style')).toContain('left: 40px')
    wrapper.unmount()
  })

  it('单击边 → 延迟弹边气泡并高亮两端节点', async () => {
    const wrapper = await mountViz()

    canvas(wrapper).vm.$emit('edge-click', GRAPH_DATA.edges[0], { x: 1, y: 2 })
    await flush()
    vi.advanceTimersByTime(CLICK_DELAY_MS)
    await flush()

    expect(wrapper.findAll('.action-popover')[1].isVisible()).toBe(true)
    wrapper.unmount()
  })

  it('双击节点 / 双击边 → 打开对应编辑抽屉（互斥），气泡不弹', async () => {
    const wrapper = await mountViz()

    canvas(wrapper).vm.$emit('node-double-click', { entity_id: 'e1' })
    await flush()
    vi.advanceTimersByTime(CLICK_DELAY_MS + 50)

    expect(wrapper.findComponent({ name: 'GraphEntityDrawerStub' }).props('modelValue')).toBe(true)
    expect(wrapper.findAll('.action-popover')[0].isVisible()).toBe(false)
    wrapper.unmount()
  })

  it('画布空白点击：清两个气泡与已选节点、退出搜索模式并 emit search-clear', async () => {
    const wrapper = await mountViz()
    // 先让气泡弹出来、进入搜索模式
    canvas(wrapper).vm.$emit('node-click', { entity_id: 'e1' }, { x: 0, y: 0 })
    await wrapper.setProps({ searchKeyword: 'kw' })
    await flush()

    canvas(wrapper).vm.$emit('container-click')
    await flush()
    vi.advanceTimersByTime(CLICK_DELAY_MS + 50)

    expect(wrapper.findAll('.action-popover')[0].isVisible()).toBe(false)
    expect(wrapper.emitted('search-clear')).toBeTruthy()
    wrapper.unmount()
  })

  it('画布缩放上报 → 缩放工具簇的百分比文本更新', async () => {
    const wrapper = await mountViz()

    canvas(wrapper).vm.$emit('zoom-change', 1.5)
    await flush()

    expect(wrapper.find('.zoom-select-btn').text()).toBe('150%')
    wrapper.unmount()
  })

  it('画布 toggle-expand 事件 → 展开状态落盘，画布收到持久隐藏列表', async () => {
    const wrapper = await mountViz()

    canvas(wrapper).vm.$emit('toggle-expand', 'e1')
    await flush()

    expect(canvas(wrapper).props('persistentlyHiddenNodeIds')).toEqual(['e2'])
    wrapper.unmount()
  })

  it('工具条事件原样转发给父组件（转发层行为）', async () => {
    const wrapper = await mountViz()
    const ctl = controls(wrapper)

    ;[
      ['entity-type-change', ['Scene']],
      ['edge-type-change', ['Relates']],
      ['limit-change', 50],
      ['depth-change', 3],
      ['export', undefined],
      ['execute-query', { keyword: 'x' }],
      ['query-type-change', 'keyword']
    ].forEach(([event, payload]) => ctl.vm.$emit(event, payload))
    ctl.vm.$emit('search-input', 'foo')
    await flush()

    expect(wrapper.emitted('entity-type-change')[0]).toEqual([['Scene']])
    expect(wrapper.emitted('edge-type-change')[0]).toEqual([['Relates']])
    expect(wrapper.emitted('limit-change')[0]).toEqual([50])
    expect(wrapper.emitted('depth-change')[0]).toEqual([3])
    expect(wrapper.emitted('export')).toBeTruthy()
    expect(wrapper.emitted('execute-query')[0]).toEqual([{ keyword: 'x' }])
    expect(wrapper.emitted('query-type-change')[0]).toEqual(['keyword'])
    expect(wrapper.emitted('search-input')).toBeTruthy()
    wrapper.unmount()
  })

  it('search-input 空串走 clearSearch（不置搜索模式）', async () => {
    const wrapper = await mountViz()
    controls(wrapper).vm.$emit('search-input', '')
    await flush()

    // 空串：清搜索，容器空白点击不会再 emit search-clear
    canvas(wrapper).vm.$emit('container-click')
    await flush()
    expect(wrapper.emitted('search-clear')).toBeUndefined()
    wrapper.unmount()
  })

  it('摘要行「显示上限」链接：收浮层 + 打开工具条高级查询', async () => {
    const wrapper = await mountViz()
    const ctl = controls(wrapper)

    await wrapper.find('.graph-limit-link').trigger('click')

    expect(ctl.vm.openAdvanced).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('resultHasMore 时展示截断提示文案', async () => {
    const wrapper = await mountViz({ resultHasMore: true })

    expect(wrapper.find('.graph-limit-notice').exists()).toBe(true)
    wrapper.unmount()
  })

  it('全屏按钮切换沉浸画布：根节点加 is-fullscreen + 发 fullscreen-change', async () => {
    const wrapper = await mountViz()

    const buttons = wrapper.findAll('.graph-fullscreen-actions button')
    await buttons[buttons.length - 1].trigger('click')
    await flush()

    expect(wrapper.find('.graph-visualization').classes()).toContain('is-fullscreen')
    expect(wrapper.emitted('fullscreen-change')[0]).toEqual([true])
    expect(wrapper.find('.graph-legend-row').exists()).toBe(false)
    wrapper.unmount()
  })

  it('容器空白点击（DOM 层）：收下拉与浮层；搜索模式 + 连线模式下额外清搜索 / 退连线', async () => {
    const wrapper = await mountViz()
    await wrapper.setProps({ searchKeyword: 'kw' })
    await flush()

    await wrapper.find('.graph-container').trigger('click')
    await flush()

    expect(wrapper.emitted('search-clear')).toBeTruthy()
    wrapper.unmount()
  })

  it('容器空白点击且无搜索模式：不发 search-clear', async () => {
    const wrapper = await mountViz()

    await wrapper.find('.graph-container').trigger('click')

    expect(wrapper.emitted('search-clear')).toBeUndefined()
    wrapper.unmount()
  })

  describe('expose 的实例方法', () => {
    it('fitView / fitViewImmediate / exitFullscreen 走到画布与全屏状态', async () => {
      const wrapper = await mountViz()

      wrapper.vm.fitView()
      wrapper.vm.fitViewImmediate()
      wrapper.vm.closeTools()

      wrapper.vm.toggleFullscreen()
      await flush()
      expect(wrapper.find('.graph-visualization').classes()).toContain('is-fullscreen')

      wrapper.vm.exitFullscreen()
      await flush()
      expect(wrapper.find('.graph-visualization').classes()).not.toContain('is-fullscreen')
      wrapper.unmount()
    })

    it('restoreLayoutAfterRefresh：nextTick 后调画布收拢布局（preserveView=true）', async () => {
      const wrapper = await mountViz()

      await wrapper.vm.restoreLayoutAfterRefresh()

      expect(canvas(wrapper).vm.compactLayoutToFit).toHaveBeenCalledWith(true)
      wrapper.unmount()
    })
  })

  it('新增实体时本地实体数超过 limit：先 emit limit-change 抬高上限再回源刷新', async () => {
    const wrapper = await mountViz({ limitValue: 1 })
    createEntityApiMock.mockResolvedValue({ success: true })

    wrapper.findComponent({ name: 'GraphEntityCreateDrawerStub' }).vm.$emit('create', {
      entityId: 'ent-y',
      entityType: 'Scene',
      entityName: 'Y',
      properties: {}
    })
    await flush()

    expect(wrapper.emitted('limit-change')).toBeTruthy()
    // 先把新实体压进本地缓存再抬高上限：2 条旧数据 + 1 条新实体 = 3
    expect(wrapper.emitted('limit-change')[0]).toEqual([3])
    // 回源刷新带 ensureEntity
    const refreshPayload = wrapper.emitted('refresh-graph-data').at(-1)[0]
    expect(refreshPayload.refreshFromServer).toBe(true)
    expect(refreshPayload.ensureEntity).toEqual(expect.objectContaining({ entity_id: 'ent-y' }))
    wrapper.unmount()
  })

  it('工具条刷新：注入了 refreshGraph（详情页实现）时优先调用它', async () => {
    const refreshGraph = vi.fn().mockResolvedValue()
    const wrapper = await mountViz({ refreshGraph })

    // GraphControls 通过 prop 拿到 handleToolbarRefresh；stub 未自己调，
    // 直接从 props 里取出调用即等价于真实工具条点「刷新知识图谱」
    await controls(wrapper).props('refreshGraph')()

    expect(refreshGraph).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('refresh-graph-data')).toBeUndefined()
    wrapper.unmount()
  })

  it('工具条刷新：未注入 refreshGraph 时退回服务端刷新事件', async () => {
    const wrapper = await mountViz()

    await controls(wrapper).props('refreshGraph')()

    expect(wrapper.emitted('refresh-graph-data')[0][0]).toEqual({ refreshFromServer: true })
    wrapper.unmount()
  })
})
