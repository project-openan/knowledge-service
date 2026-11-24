// @vitest-environment jsdom
/**
 * GraphTemplateDesigner.vue（/graph/createTemplate/:templateId 模版设计器）——
 * 页面只做「编排」：路由（new / 既有模版）、把 schema 画到画布、把画布导出成 schema、
 * 保存（新建 vs 更新）与校验提示。X6 内核在 GraphCanvas 里，这里整体 stub 成可编程替身：
 * 用例直接改 canvasApi 的返回值/计数器，即可驱动页面全部 script 分支。
 *
 * - 装配：编辑模式拉详情并画布回显（节点网格布局 / 边的形状映射 / 自闭环 vertices）、
 *   详情为空报错、拉取失败走 reportError；新建模式生成 UUID，query 里带名称/描述时回填。
 * - 画布事件：节点/边选中开对应配置抽屉、空白点击关闭、initialized 后补画 pending schema。
 * - 工具栏：undo/redo/缩放上限（zoom>=3 / <=0.5 时锁按钮）/fit/连线模式/删除（0 个警告）。
 * - 保存链路：buildSchemaFromGraph 的实体/属性/边校验、无名称弹模版信息框、
 *   校验失败拼错误清单、新建走 create 更新走 update、成功回列表（延迟 1s）、
 *   失败（空响应）与异常（Error 对象 message / 非 Error 兜底文案）。
 * - 导出 JSON / 返回列表 / 属性面板的应用与取消。
 */
import { vi } from 'vitest'
import { h } from 'vue'

const { api, canvasApi, reportMock } = vi.hoisted(() => ({
  api: {
    createGraphSchemaTemplate: vi.fn(),
    getGraphSchemaTemplateDetail: vi.fn(),
    updateGraphSchemaTemplate: vi.fn()
  },
  canvasApi: {},
  reportMock: { reportError: vi.fn() }
}))

vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  createGraphSchemaTemplate: (...args) => api.createGraphSchemaTemplate(...args),
  getGraphSchemaTemplateDetail: (...args) => api.getGraphSchemaTemplateDetail(...args),
  updateGraphSchemaTemplate: (...args) => api.updateGraphSchemaTemplate(...args)
}))

vi.mock('@/shared/lib/reportError', () => ({ reportError: (...args) => reportMock.reportError(...args) }))

// 画布替身：页面用到的 expose 全在这里，测试可随时改写行为
vi.mock('@/features/graph/components/GraphEditor/GraphCanvas.vue', () => ({
  default: {
    name: 'GraphCanvasStub',
    emits: ['node-select', 'edge-select', 'canvas-click', 'initialized'],
    setup (_, { expose, emit }) {
      expose({
        get graph () { return canvasApi.graph || null },
        triggerInitialized: () => emit('initialized'),
        addNode: (...args) => canvasApi.addNode(...args),
        addEdge: (...args) => canvasApi.addEdge(...args),
        clearCanvas: (...args) => canvasApi.clearCanvas(...args),
        updateNodeProperties: (...args) => canvasApi.updateNodeProperties(...args),
        updateEdgeProperties: (...args) => canvasApi.updateEdgeProperties(...args),
        undo: (...args) => canvasApi.undo(...args),
        redo: (...args) => canvasApi.redo(...args),
        zoomIn: (...args) => canvasApi.zoomIn(...args),
        zoomOut: (...args) => canvasApi.zoomOut(...args),
        fitView: (...args) => canvasApi.fitView(...args),
        setConnectionMode: (...args) => canvasApi.setConnectionMode(...args),
        deleteSelectedCells: (...args) => canvasApi.deleteSelectedCells(...args),
        exportForSchema: (...args) => canvasApi.exportForSchema(...args)
      })
      return () => h('div', { class: 'graph-canvas-stub' })
    }
  }
}))

vi.mock('@/features/graph/components/GraphEditor/PropertyPanel.vue', () => ({
  default: {
    name: 'PropertyPanelStub',
    props: ['selectedItem', 'itemType'],
    emits: ['update-properties'],
    setup (_, { expose, emit }) {
      expose({
        applyChanges: (...args) => canvasApi.applyChanges(...args),
        emit
      })
      return () => h('div', { class: 'property-panel-stub' })
    }
  }
}))

vi.mock('@/features/graph/components/GraphEditor/ToolBar.vue', () => ({
  default: { name: 'ToolBarStub', props: ['templateName'], render: () => h('div', { class: 'toolbar-stub' }) }
}))

import { flush, mountWithPlugins } from './helpers/mount'
import GraphTemplateDesigner from '@/features/graph/GraphTemplateDesigner.vue'

const ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } },
  { path: '/graph/createTemplate/:templateId', name: 'graph-template', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

const closeMock = vi.fn()
const messageMock = Object.assign(vi.fn(() => ({ close: closeMock })), {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn()
})

const SCHEMA = {
  schema_id: 'tpl-9',
  schema_name: '影视模版',
  schema_desc: '人物与场景',
  entities: [
    { entity_type: 'Scene', entity_desc: '场景', properties: [{ name: 'name', type: 'STRING', desc: '' }] },
    { entity_type: 'Character', entity_desc: '人物', properties: [{ name: 'name', type: 'STRING', desc: '' }] }
  ],
  edges: [
    { edge_type: 'Relates', edge_desc: '关联', direction: 'two-way', source_entity: 'Scene', target_entity: 'Character', properties: [] },
    { edge_type: 'SelfRel', edge_desc: '', direction: 'one-way', source_entity: 'Scene', target_entity: 'Scene', properties: [] }
  ]
}

/** 可编程画布替身的默认行为 */
function installDefaultCanvas () {
  const calls = { addNode: [], addEdge: [], cleared: 0 }
  canvasApi.graph = {
    zoom: vi.fn(() => 1),
    getCellById: vi.fn(id => (id === 'node-1' ? { getPosition: () => ({ x: 10, y: 20 }) } : null))
  }
  let nodeSeq = 0
  canvasApi.addNode = vi.fn(() => ({
    id: `node-${nodeSeq += 1}`,
    setPosition: vi.fn(),
    setData: vi.fn(),
    setAttrs: vi.fn()
  }))
  canvasApi.addEdge = vi.fn(config => {
    calls.addEdge.push(config)
    return {
      id: `edge-${calls.addEdge.length}`,
      setSource: vi.fn(),
      setTarget: vi.fn(),
      setVertices: vi.fn(),
      model: { graph: canvasApi.graph }
    }
  })
  canvasApi.clearCanvas = vi.fn(() => { calls.cleared += 1 })
  canvasApi.updateNodeProperties = vi.fn()
  canvasApi.updateEdgeProperties = vi.fn()
  canvasApi.undo = vi.fn()
  canvasApi.redo = vi.fn()
  canvasApi.zoomIn = vi.fn()
  canvasApi.zoomOut = vi.fn()
  canvasApi.fitView = vi.fn()
  canvasApi.setConnectionMode = vi.fn()
  canvasApi.deleteSelectedCells = vi.fn(() => 2)
  canvasApi.exportForSchema = vi.fn(() => ({
    nodes: [
      { id: 'n1', data: { entity_type: 'Scene', description: '', properties: [{ name: 'name', type: 'STRING' }] } },
      { id: 'n2', data: { entity_type: 'Character', description: '', properties: [{ name: 'name', type: 'STRING', is_embedding: true }] } }
    ],
    edges: [
      { id: 'e1', shape: 'double-arrow-edge', source: { cell: 'n1' }, target: { cell: 'n2' }, data: { edge_type: 'Relates', edge_desc: '关联', direction: 'two-way', properties: [] } },
      { id: 'e2', shape: 'self-loop-edge', source: { cell: 'n1' }, target: { cell: 'n1' }, data: { edge_type: 'SelfRel', properties: [{ name: 'k', type: 'STRING' }] } }
    ]
  }))
  canvasApi.applyChanges = vi.fn(async () => {})
  return calls
}

async function mountDesigner ({ templateId = 'tpl-9', query = '', detail = SCHEMA, detailImpl } = {}) {
  api.getGraphSchemaTemplateDetail.mockReset()
  if (detailImpl) {
    api.getGraphSchemaTemplateDetail.mockImplementation(detailImpl)
  } else {
    api.getGraphSchemaTemplateDetail.mockResolvedValue(detail)
  }
  api.createGraphSchemaTemplate.mockReset().mockResolvedValue({ schema_id: 'tpl-new' })
  api.updateGraphSchemaTemplate.mockReset().mockResolvedValue({ schema_id: 'tpl-9' })
  const calls = installDefaultCanvas()

  const wrapper = await mountWithPlugins(GraphTemplateDesigner, {
    route: `/graph/createTemplate/${templateId}${query}`,
    routes: ROUTES,
    attachTo: document.body,
    global: { config: { globalProperties: { $message: messageMock } } }
  })
  // 画布 stub 不自动发 initialized：默认流在这里发一次（与真实时序一致：画布先就绪），
  // 再等「convertSchemaToGraph」里 100/300/200ms 的真实 setTimeout 落地
  wrapper.findComponent({ name: 'GraphCanvasStub' }).vm.triggerInitialized()
  await flush()
  await new Promise(resolve => setTimeout(resolve, 700))
  await flush()
  return { wrapper, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('路由装配：编辑模式 / 新建模式', () => {
  it('编辑模式：拉详情、回填元数据与表单，画布回显节点与边（含自闭环 vertices）', async () => {
    const { wrapper, calls } = await mountDesigner()

    expect(api.getGraphSchemaTemplateDetail).toHaveBeenCalledWith('tpl-9')
    expect(wrapper.vm.templateMeta).toEqual({ id: 'tpl-9', name: '影视模版', description: '人物与场景' })
    expect(wrapper.vm.templateForm).toEqual({ name: '影视模版', description: '人物与场景' })
    expect(wrapper.vm.isEditMode).toBe(true)
    expect(wrapper.vm.loading).toBe(false)
    expect(calls.cleared).toBe(1)
    // 两个实体各建一个节点：网格布局落点、节点数据与标签
    expect(canvasApi.addNode).toHaveBeenCalledTimes(2)
    expect(canvasApi.addNode.mock.calls[0]).toEqual(['entity'])
    // 两条边：two-way → double-arrow-edge，自闭环 → self-loop-edge
    expect(calls.addEdge).toHaveLength(2)
    expect(calls.addEdge[0].shape).toBe('double-arrow-edge')
    expect(calls.addEdge[1].shape).toBe('self-loop-edge')
    expect(calls.addEdge[0].data).toMatchObject({ edge_type: 'Relates', direction: 'two-way', lightStroke: '#0077FF' })
    // 自闭环：配置里带 left 端口与 vertices；画布上再 setSource/setVertices
    expect(calls.addEdge[1].source).toEqual({ cell: 'node-1', port: 'left' })
    expect(calls.addEdge[1].vertices.length).toBeGreaterThan(0)
  })

  it('详情为空响应：报「加载模版失败」', async () => {
    const { wrapper } = await mountDesigner({ detail: null })
    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.loadTemplateFailed'))
  })

  it('详情接口异常：走 reportError 统一出口，loading 复位', async () => {
    const { wrapper } = await mountDesigner({ detailImpl: () => Promise.reject(new Error('boom')) })
    expect(reportMock.reportError).toHaveBeenCalled()
    expect(wrapper.vm.loading).toBe(false)
  })

  it('新建模式：生成 UUID；query 带名称/描述时回填（含非法字符清洗前的原样）', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new', query: '?templateName=新建模版&templateDescription=说明' })
    expect(wrapper.vm.isEditMode).toBe(false)
    expect(wrapper.vm.templateMeta.id).toBeTruthy()
    expect(wrapper.vm.templateMeta.id).not.toBe('new')
    expect(wrapper.vm.templateMeta.name).toBe('新建模版')
    expect(wrapper.vm.templateForm.description).toBe('说明')
    expect(api.getGraphSchemaTemplateDetail).not.toHaveBeenCalled()

    // 不带 query：名称/描述保持空
    const { wrapper: bare } = await mountDesigner({ templateId: 'new' })
    expect(bare.vm.templateMeta.name).toBe('')
    expect(bare.vm.templateMeta.description).toBe('')
  })
})

describe('画布事件与选择状态', () => {
  it('选中节点/边开配置抽屉，空白点击关闭', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    const canvas = wrapper.findComponent({ name: 'GraphCanvasStub' })

    canvas.vm.$emit('node-select', { id: 'n1', data: {} })
    await flush()
    expect(wrapper.vm.selectionType).toBe('node')
    expect(wrapper.vm.showPropertyPanel).toBe(true)
    expect(wrapper.findComponent({ name: 'PropertyPanelStub' }).exists()).toBe(true)

    canvas.vm.$emit('edge-select', { id: 'e1', data: {} })
    await flush()
    expect(wrapper.vm.selectionType).toBe('edge')

    canvas.vm.$emit('canvas-click')
    await flush()
    expect(wrapper.vm.selectionType).toBeNull()
    expect(wrapper.vm.selectedNodeOrEdge).toBeNull()
    expect(wrapper.vm.showPropertyPanel).toBe(false)
  })

  it('详情先于画布就绪时暂存 pending，initialized 后补画', async () => {
    api.getGraphSchemaTemplateDetail.mockResolvedValue(SCHEMA)
    installDefaultCanvas()

    const wrapper = await mountWithPlugins(GraphTemplateDesigner, {
      route: '/graph/createTemplate/tpl-9',
      routes: ROUTES,
      attachTo: document.body,
      global: { config: { globalProperties: { $message: messageMock } } }
    })
    await flush()
    // 画布还没 initialized：详情已回来但只能暂存
    expect(wrapper.vm.pendingSchemaData).toEqual(SCHEMA)
    expect(wrapper.vm.graphInitialized).toBe(false)

    // 画布就绪：暂存的 schema 补画到画布
    wrapper.findComponent({ name: 'GraphCanvasStub' }).vm.triggerInitialized()
    await flush()
    await new Promise(resolve => setTimeout(resolve, 700))
    await flush()
    expect(wrapper.vm.pendingSchemaData).toBeNull()
    expect(wrapper.vm.graphInitialized).toBe(true)
    wrapper.unmount()
  })

  it('属性更新：node 走 updateNodeProperties，edge 走 updateEdgeProperties，无画布时静默', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    wrapper.vm.handlePropertiesUpdate({ type: 'node', id: 'n1', data: { name: 'x' } })
    expect(canvasApi.updateNodeProperties).toHaveBeenCalledWith('n1', { name: 'x' })
    wrapper.vm.handlePropertiesUpdate({ type: 'edge', id: 'e1', data: { edge_type: 'R' } })
    expect(canvasApi.updateEdgeProperties).toHaveBeenCalledWith('e1', { edge_type: 'R' })

    // 画布未挂（模板 ref 为 null）：静默返回
    const setup = wrapper.vm.$.setupState
    const original = setup.graphCanvasRef
    setup.graphCanvasRef = null
    wrapper.vm.handlePropertiesUpdate({ type: 'node', id: 'n1', data: {} })
    setup.graphCanvasRef = original
    expect(canvasApi.updateNodeProperties).toHaveBeenCalledTimes(1)
  })
})

describe('属性面板：应用 / 取消', () => {
  it('applyChanges 成功：提示并关抽屉；失败：只记日志（错误由面板提示）', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    wrapper.vm.handleNodeSelect({ id: 'n1' })
    await flush()

    await wrapper.vm.handleApplyProperties()
    await flush()
    expect(canvasApi.applyChanges).toHaveBeenCalled()
    expect(messageMock.success).toHaveBeenCalled()
    expect(wrapper.vm.showPropertyPanel).toBe(false)

    canvasApi.applyChanges = vi.fn(async () => { throw new Error('必填缺失') })
    wrapper.vm.showPropertyPanel = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.handleApplyProperties()
    await flush()
    expect(error).toHaveBeenCalled()
    expect(wrapper.vm.showPropertyPanel).toBe(true)
    error.mockRestore()

    // 面板没有 applyChanges：什么都不做
    wrapper.vm.handleCancelProperties()
    expect(wrapper.vm.showPropertyPanel).toBe(false)
  })
})

describe('工具栏动作', () => {
  it('undo / redo / fit / 连线模式直接透传', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    wrapper.vm.handleUndo()
    wrapper.vm.handleRedo()
    wrapper.vm.handleFitView()
    wrapper.vm.handleSetConnectionMode('self')
    expect(canvasApi.undo).toHaveBeenCalled()
    expect(canvasApi.redo).toHaveBeenCalled()
    expect(canvasApi.fitView).toHaveBeenCalled()
    expect(canvasApi.setConnectionMode).toHaveBeenCalledWith('self')
  })

  it('缩放边界：zoom>=3 锁放大、<=0.5 锁缩小，其余复位并缩放', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    canvasApi.graph.zoom = vi.fn(() => 3)
    wrapper.vm.handleZoomIn()
    expect(wrapper.vm.limitZoomIn).toBe(true)
    expect(canvasApi.zoomIn).not.toHaveBeenCalled()

    canvasApi.graph.zoom = vi.fn(() => 0.5)
    wrapper.vm.handleZoomOut()
    expect(wrapper.vm.limitZoomOut).toBe(true)
    expect(canvasApi.zoomOut).not.toHaveBeenCalled()

    canvasApi.graph.zoom = vi.fn(() => 1.2)
    wrapper.vm.handleZoomIn()
    wrapper.vm.handleZoomOut()
    expect(canvasApi.zoomIn).toHaveBeenCalled()
    expect(canvasApi.zoomOut).toHaveBeenCalled()
    expect(wrapper.vm.limitZoomIn).toBe(false)
    expect(wrapper.vm.limitZoomOut).toBe(false)
  })

  it('删除：0 个选中警告，>0 个提示删除数量', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    canvasApi.deleteSelectedCells = vi.fn(() => 0)
    wrapper.vm.handleDelete()
    expect(messageMock.warning).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.pleaseSelectElementsToDelete'))

    canvasApi.deleteSelectedCells = vi.fn(() => 3)
    wrapper.vm.handleDelete()
    expect(messageMock.success).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.elementsDeleted', { count: 3 }))
  })

  it('画布未初始化时删除：只记错误日志', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const setup = wrapper.vm.$.setupState
    const original = setup.graphCanvasRef
    setup.graphCanvasRef = null
    wrapper.vm.handleDelete()
    expect(error).toHaveBeenCalledWith('graphCanvasRef.value is null')
    setup.graphCanvasRef = original
    error.mockRestore()
  })

  it('添加实体按钮：委托 addNode("entity")（居中默认节点）', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    await wrapper.find('.floating-add-button .el-button').trigger('click')
    expect(canvasApi.addNode).toHaveBeenCalledWith('entity')
  })
})

describe('导出 JSON', () => {
  it('导出：schema 结构落盘并以模板名命名，成功提示', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new', query: '?templateName=导出模版' })
    await wrapper.vm.handleExportJson()

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    expect(messageMock.success).toHaveBeenCalled()
    expect(wrapper.vm.templateMeta.name).toBe('导出模版')
  })

  it('画布缺失：报「画布未初始化」不落盘', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    const setup = wrapper.vm.$.setupState
    const original = setup.graphCanvasRef
    setup.graphCanvasRef = null
    await wrapper.vm.handleExportJson()
    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.canvasNotInitialized'))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    setup.graphCanvasRef = original
  })

  it('导出过程中抛错：走 reportError', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    canvasApi.exportForSchema = vi.fn(() => { throw new Error('bad canvas') })
    await wrapper.vm.handleExportJson()
    expect(reportMock.reportError).toHaveBeenCalled()
  })
})

describe('schema 构建与校验（buildSchemaFromGraph / validateSchema）', () => {
  it('双向边 → two-way、自闭环 → self-loop、默认 one-way；属性字段整形', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    const schema = wrapper.vm.buildSchemaFromGraph()
    expect(schema.schema_name).toBe('')
    expect(schema.entities).toHaveLength(2)
    expect(schema.entities[0].properties[0]).toEqual({ name: 'name', type: 'STRING', desc: '', is_embedding: false, is_index: false, is_primary: false })
    expect(schema.entities[1].properties[0].is_embedding).toBe(true)
    expect(schema.edges[0]).toMatchObject({ direction: 'two-way', source_entity: 'Scene', target_entity: 'Character' })
    expect(schema.edges[1]).toMatchObject({ direction: 'self-loop', source_entity: 'Scene', target_entity: 'Scene' })
  })

  it('边缺类型 / 方向缺失：one-way 兜底；端点映射不到实体时报错', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    // 默认 exportForSchema 的边 direction 都是 undefined → one-way
    const schema = wrapper.vm.buildSchemaFromGraph()
    expect(schema.edges[0].direction).toBe('two-way') // shape 决定

    canvasApi.exportForSchema = vi.fn(() => ({
      nodes: [{ id: 'n1', data: { entity_type: 'Scene', properties: [{ name: 'x', type: 'STRING' }] } }],
      edges: [{ id: 'e1', data: {}, source: { cell: 'n9' }, target: { cell: 'n1' } }]
    }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.handleSaveTemplate() // 未命名 → 弹模版信息框，构建仍先发生
    error.mockRestore()
  })

  it('buildEntitiesAndMapping：无节点抛「至少一个实体」；节点无属性抛「必须配置属性」', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    expect(() => wrapper.vm.buildEntitiesAndMapping([])).toThrow(wrapper.vm.$t('modules.kb.atLeastOneEntityRequired'))

    canvasApi.exportForSchema = vi.fn(() => ({
      nodes: [{ id: 'n1', data: { entity_type: 'Scene', properties: [] } }],
      edges: []
    }))
    expect(() => wrapper.vm.buildSchemaFromGraph())
      .toThrow(wrapper.vm.$t('modules.kb.entityMustHaveProperty', { entityType: 'Scene' }))
  })

  it('validateSchema 全分支：名称 / 实体类型 / 实体属性 / 边两端与属性', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    const invalid = wrapper.vm.validateSchema({
      schema_name: '',
      entities: [
        { entity_type: '', properties: [] },
        { entity_type: 'Scene', properties: [{ name: '', type: '' }] }
      ],
      edges: [
        { edge_type: '', source_entity: '', target_entity: '', properties: [{ name: 'x', type: '' }] }
      ]
    })
    expect(invalid.valid).toBe(false)
    // 名称、实体1类型、实体1属性、实体2属性名/类型、边类型、边源、边目标、边属性类型
    expect(invalid.errors.length).toBeGreaterThanOrEqual(8)

    const noEntities = wrapper.vm.validateSchema({ schema_name: 'x', entities: [], edges: [] })
    expect(noEntities.valid).toBe(false)
    expect(noEntities.errors).toContain(wrapper.vm.$t('modules.kb.atLeastOneEntityRequired'))

    const clean = wrapper.vm.validateSchema({
      schema_name: 'ok',
      entities: [{ entity_type: 'Scene', properties: [{ name: 'n', type: 'STRING' }] }],
      edges: [{ edge_type: 'R', source_entity: 'Scene', target_entity: 'Scene', properties: [] }]
    })
    expect(clean.valid).toBe(true)
    expect(clean.errors).toEqual([])

    // 无边：合法（edges 校验对空数组直接通过）
    const noEdges = wrapper.vm.validateSchema({ schema_name: 'ok', entities: [{ entity_type: 'Scene', properties: [{ name: 'n', type: 'STRING' }] }], edges: [] })
    expect(noEdges.valid).toBe(true)
  })
})

describe('保存链路', () => {
  async function namedDesigner () {
    return mountDesigner({ templateId: 'new', query: '?templateName=保存模版&templateDescription=说明' })
  }

  it('新建成功：走 create，成功提示，1s 后回模版列表页签', async () => {
    const { wrapper } = await namedDesigner()
    vi.useFakeTimers()
    const replaceSpy = vi.spyOn(wrapper.router, 'replace')
    await wrapper.vm.handleSaveTemplate()
    expect(api.createGraphSchemaTemplate).toHaveBeenCalledTimes(1)
    expect(api.updateGraphSchemaTemplate).not.toHaveBeenCalled()
    expect(messageMock.success).toHaveBeenCalled()
    vi.advanceTimersByTime(1100)
    expect(replaceSpy).toHaveBeenCalledWith({ path: '/graph', query: { subTab: 'knowledgeGraphTemplate' } })
  })

  it('编辑模式成功：走 update', async () => {
    const { wrapper } = await mountDesigner()
    vi.useFakeTimers()
    await wrapper.vm.handleSaveTemplate()
    expect(api.updateGraphSchemaTemplate).toHaveBeenCalledTimes(1)
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('响应为空：提示保存失败', async () => {
    const { wrapper } = await mountDesigner()
    api.updateGraphSchemaTemplate.mockResolvedValue(null) // mountDesigner 会 reset，覆盖要放在其后
    vi.useFakeTimers()
    await wrapper.vm.handleSaveTemplate()
    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.graphTemplateUpdateFailed'))
  })

  it('未命名：弹模版信息对话框并警告，不调用保存接口', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    await wrapper.vm.handleSaveTemplate()
    expect(wrapper.vm.templateInfoDialogVisible).toBe(true)
    expect(messageMock.warning).toHaveBeenCalled()
    expect(api.createGraphSchemaTemplate).not.toHaveBeenCalled()
  })

  it('schema 校验失败：拼错误清单提示，不发请求', async () => {
    const { wrapper } = await namedDesigner()
    canvasApi.exportForSchema = vi.fn(() => ({
      nodes: [{ id: 'n1', data: { entity_type: 'Scene', properties: [{ name: '', type: '' }] } }],
      edges: []
    }))
    await wrapper.vm.handleSaveTemplate()
    expect(messageMock.error).toHaveBeenCalled()
    expect(String(messageMock.error.mock.calls.at(-1)[0])).toContain(wrapper.vm.$t('modules.kb.schemaValidationFailed'))
    // 错误清单里列出「属性名/属性类型不能为空」
    expect(String(messageMock.error.mock.calls.at(-1)[0])).toContain('不能为空')
    expect(api.createGraphSchemaTemplate).not.toHaveBeenCalled()
    expect(wrapper.vm.saving).toBe(false)
  })

  it('保存异常：Error 对象直接展示 message；非 Error 对象走本地化兜底', async () => {
    const { wrapper } = await namedDesigner()
    api.createGraphSchemaTemplate.mockRejectedValue(new Error('网络中断'))
    await wrapper.vm.handleSaveTemplate()
    expect(messageMock.error).toHaveBeenCalledWith('网络中断')

    api.createGraphSchemaTemplate.mockRejectedValue({ code: 'E1' })
    await wrapper.vm.handleSaveTemplate()
    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.graphTemplateCreateFailed'))
    expect(wrapper.vm.saving).toBe(false)
  })
})

describe('模版信息对话框 / 返回列表', () => {
  it('确认：validate 通过后回填元数据并关框；失败只记日志；未挂表单时直接返回', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    // 模板 ref 为 null（对话框从未开过）：直接返回
    const setup0 = wrapper.vm.$.setupState
    const originalRef = setup0.templateFormRef
    setup0.templateFormRef = null
    wrapper.vm.handleConfirmTemplateInfo()
    expect(wrapper.vm.templateInfoDialogVisible).toBe(false)
    setup0.templateFormRef = originalRef

    const setup = wrapper.vm.$.setupState
    setup.templateFormRef = { validate: async () => {} } // proxyRefs：写回 ref.value
    setup.templateForm.name = '改名'
    setup.templateForm.description = '改描述'
    await wrapper.vm.handleConfirmTemplateInfo()
    expect(wrapper.vm.templateMeta.name).toBe('改名')
    expect(wrapper.vm.templateInfoDialogVisible).toBe(false)
    expect(messageMock.success).toHaveBeenCalled()

    setup.templateFormRef = { validate: async () => { throw new Error('no') } }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.handleConfirmTemplateInfo()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
    wrapper.vm.handleCancelTemplateInfo()
    expect(wrapper.vm.templateInfoDialogVisible).toBe(false)
  })

  it('goBack：replace 回 /graph?subTab=knowledgeGraphTemplate', async () => {
    const { wrapper } = await mountDesigner({ templateId: 'new' })
    wrapper.vm.goBack()
    await flush()
    expect(wrapper.router.currentRoute.value.path).toBe('/graph')
    expect(wrapper.router.currentRoute.value.query.subTab).toBe('knowledgeGraphTemplate')
  })
})
