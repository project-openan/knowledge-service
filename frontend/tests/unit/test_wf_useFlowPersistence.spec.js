// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// 与后端 flow api 的装配：api 全部 mock，画布用假 graph。
// composable 是方法映射，用假 this 逐方法调用。
const { apiMocks } = vi.hoisted(() => ({ apiMocks: {} }))

vi.mock('@/features/workflow/api/workflow', () => ({
  getFlowConfig: (...args) => apiMocks.getFlowConfig(...args),
  saveFlowConfig: (...args) => apiMocks.saveFlowConfig(...args),
  exportWorkFlow: (...args) => apiMocks.exportWorkFlow(...args),
  checkSaveFlowConfig: (...args) => apiMocks.checkSaveFlowConfig(...args)
}))

// exportWorkflow 会把 blob 交给 download；jsdom 里没有 createObjectURL，换成桩
vi.mock('@/shared/lib/utils', () => ({
  download: (...args) => apiMocks.download(...args)
}))

import { useFlowPersistence } from '@/features/workflow/composables/useFlowPersistence'
import { workflowState } from '@/features/workflow/store'

const methods = useFlowPersistence()

/** 组件 this 桩：带全套 composable 方法 + 常用组件字段。 */
function createCtx (overrides = {}) {
  return {
    ...methods,
    graph: null,
    $route: { params: { id: 'flow-1' } },
    $router: { replace: vi.fn() },
    $t: (key, params) => key + (params ? '|' + Object.values(params).join('|') : ''),
    $message: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
    $confirm: vi.fn(() => Promise.resolve()),
    $store: { state: {} },
    loading: true,
    nodeLoaded: true,
    version: 1,
    workflowName: '',
    workflowId: '',
    workflowPublishType: 0,
    queryEngineType: '',
    queryengineMap: { SequentialQueryEngine: { operator: 'SequentialQueryEngine' } },
    jsonDTO: null,
    graphAppId: '',
    cancelConnection: vi.fn(),
    clearNodeSelection: vi.fn(),
    importGraph: vi.fn(),
    initDefaultNode: vi.fn(),
    toolsOpen: false,
    debouncedInput: null,
    saveAppId: '',
    ...overrides
  }
}

/** 跑完整条微任务链（then/catch/finally）。 */
const drain = () => new Promise(resolve => setTimeout(resolve, 0))

/** 一份带 QUERY_ENGINE 的后端返回。 */
function flowResponse (overrides = {}) {
  return {
    version: 3,
    name: '检索流',
    appId: 'flow-1',
    publishType: 2,
    template: 'Blended',
    nodeConfigDTOList: [
      { nodeId: 'n1', componentType: 'RETRIEVER', xPosition: 10, yPosition: 20, variables: { retriever: [] }, outputVariables: [], inputVariables: [] },
      { nodeId: 'n2', componentType: 'QUERY', xPosition: 0, yPosition: 0, outputVariables: [], inputVariables: [] }
    ],
    otherNodeConfigList: [
      { componentType: 'QUERY_ENGINE', variables: { queryengine: { operator: 'BlendedQueryEngine' } } }
    ],
    ...overrides
  }
}

beforeEach(() => {
  apiMocks.getFlowConfig = vi.fn()
  apiMocks.saveFlowConfig = vi.fn()
  apiMocks.exportWorkFlow = vi.fn()
  apiMocks.checkSaveFlowConfig = vi.fn()
  apiMocks.download = vi.fn()
  workflowState.ragWorkflowType = ''
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reloadAdvancedFlow', () => {
  it('先清场（选中态/朝向缓存/画布）再取数，归属与标题一并重置', () => {
    const graph = { clearCells: vi.fn() }
    const ctx = createCtx({
      graph,
      selectedEdge: { id: 'e1' },
      portSideCache: { a: {} },
      graphAppId: 'flow-1',
      workflowName: '旧名',
      workflowId: 'old',
      version: 9,
      workflowPublishType: 2,
      queryEngineType: 'BlendedQueryEngine',
      nodeLoaded: true,
      getAdvancedFlowConfig: vi.fn()
    })
    methods.reloadAdvancedFlow.call(ctx)
    expect(ctx.cancelConnection).toHaveBeenCalled()
    expect(ctx.selectedEdge).toBeNull()
    expect(ctx.clearNodeSelection).toHaveBeenCalled()
    expect(ctx.portSideCache).toEqual({})
    expect(graph.clearCells).toHaveBeenCalled()
    expect(ctx.graphAppId).toBe('')
    expect(ctx.workflowName).toBe('')
    expect(ctx.workflowId).toBe('')
    expect(ctx.version).toBe(1)
    expect(ctx.workflowPublishType).toBe(0)
    expect(ctx.queryEngineType).toBe('')
    expect(ctx.nodeLoaded).toBe(false)
    expect(ctx.getAdvancedFlowConfig).toHaveBeenCalled()
  })
})

describe('getAdvancedFlowConfig', () => {
  it('有草稿：DTO 换成画布形状、importGraph、引擎与结构化标志写入', async () => {
    const res = flowResponse()
    apiMocks.getFlowConfig.mockReturnValue(Promise.resolve(res))
    const ctx = createCtx({
      importGraph: vi.fn(),
      checkIsStructKnowledgeFlow: vi.fn(() => true)
    })
    methods.getAdvancedFlowConfig.call(ctx, false)
    await drain()

    expect(apiMocks.getFlowConfig).toHaveBeenCalledWith('flow-1', { skipErrorMessage: true })
    expect(ctx.version).toBe(3)
    expect(ctx.workflowName).toBe('检索流')
    expect(ctx.workflowId).toBe('flow-1')
    expect(ctx.workflowPublishType).toBe(2)
    // DTO → 画布节点形状
    expect(ctx.jsonDTO[0]).toMatchObject({ id: 'n1', shape: 'RETRIEVER', position: { x: 10, y: 20 } })
    expect(ctx.importGraph).toHaveBeenCalledWith(false)
    expect(ctx.graphAppId).toBe('flow-1')
    expect(ctx.queryEngineType).toBe('BlendedQueryEngine')
    expect(workflowState.ragWorkflowType).toBe('BlendedQueryEngine')
    expect(ctx.$store.state.ragWorkflowIsStructKnowledge).toBe(true)
    expect(ctx.loading).toBe(false)
  })

  it('没有草稿（新工作流）：按模板推引擎并补默认节点', async () => {
    apiMocks.getFlowConfig.mockReturnValue(Promise.resolve(flowResponse({
      nodeConfigDTOList: [], name: '新流', template: 'Conditional', publishType: 0
    })))
    const ctx = createCtx({ importGraph: vi.fn() })
    methods.getAdvancedFlowConfig.call(ctx)
    await Promise.resolve()
    await Promise.resolve()

    expect(ctx.queryEngineType).toBe('ConditionalQueryEngine')
    expect(workflowState.ragWorkflowType).toBe('ConditionalQueryEngine')
    expect(ctx.initDefaultNode).toHaveBeenCalled()
    expect(ctx.graphAppId).toBe('flow-1')
    expect(ctx.nodeLoaded).toBe(false)
  })

  it('路由已切走：旧返回直接丢弃，不渲染也不补默认节点', async () => {
    apiMocks.getFlowConfig.mockReturnValue(Promise.resolve(flowResponse()))
    const ctx = createCtx({ importGraph: vi.fn() })
    methods.getAdvancedFlowConfig.call(ctx)
    // 响应落地之前路由已经切到另一个流：旧返回必须丢弃
    ctx.$route = { params: { id: 'flow-2' } }
    await drain()
    expect(ctx.importGraph).not.toHaveBeenCalled()
    expect(ctx.initDefaultNode).not.toHaveBeenCalled()
    expect(ctx.loading).toBe(false)
  })

  it('401：交给会话层处理，不补默认节点', async () => {
    apiMocks.getFlowConfig.mockReturnValue(Promise.reject({ status: 401 }))
    const ctx = createCtx()
    methods.getAdvancedFlowConfig.call(ctx)
    await drain()
    expect(ctx.$message.error).not.toHaveBeenCalled()
    expect(ctx.initDefaultNode).not.toHaveBeenCalled()
    expect(ctx.$router.replace).not.toHaveBeenCalled()
  })

  it('404：提示并回列表，不渲染「看似可编辑」的空画布', async () => {
    apiMocks.getFlowConfig.mockReturnValue(Promise.reject({ status: 404 }))
    const ctx = createCtx()
    methods.getAdvancedFlowConfig.call(ctx)
    await drain()
    expect(ctx.$message.error).toHaveBeenCalledWith('modules.workflow.flowNotFound')
    expect(ctx.$router.replace).toHaveBeenCalledWith({ name: 'flow' })
    expect(ctx.initDefaultNode).not.toHaveBeenCalled()
  })

  it('其它错误：提示加载失败并初始化空画布；路由已切走则跳过', async () => {
    apiMocks.getFlowConfig.mockReturnValue(Promise.reject(new Error('boom')))
    const ctx = createCtx()
    methods.getAdvancedFlowConfig.call(ctx)
    await drain()
    expect(ctx.$message.error).toHaveBeenCalledWith('modules.workflow.loadFailed')
    expect(ctx.initDefaultNode).toHaveBeenCalled()
    expect(ctx.graphAppId).toBe('flow-1')

    // 路由切走：不再往画布上补节点
    apiMocks.getFlowConfig.mockReturnValue(Promise.reject(new Error('boom')))
    const ctx2 = createCtx()
    methods.getAdvancedFlowConfig.call(ctx2)
    ctx2.$route = { params: { id: 'flow-9' } }
    await drain()
    expect(ctx2.initDefaultNode).not.toHaveBeenCalled()
  })
})

describe('engineOfTemplate / 结构化知识库标志', () => {
  it('模板 → 引擎：未知/缺省回落顺序引擎', () => {
    const ctx = createCtx()
    expect(methods.engineOfTemplate.call(ctx, 'Sequential')).toBe('SequentialQueryEngine')
    expect(methods.engineOfTemplate.call(ctx, 'Blended')).toBe('BlendedQueryEngine')
    expect(methods.engineOfTemplate.call(ctx, 'Conditional')).toBe('ConditionalQueryEngine')
    expect(methods.engineOfTemplate.call(ctx, 'Whatever')).toBe('SequentialQueryEngine')
    expect(methods.engineOfTemplate.call(ctx, undefined)).toBe('SequentialQueryEngine')
  })

  it('isSqlOperatorVariables：只认 SQL 检索算子', () => {
    const ctx = createCtx()
    expect(methods.isSqlOperatorVariables.call(ctx, {
      retriever: [{ operator: 'VectorRetriever' }]
    })).toBe(false)
    expect(methods.isSqlOperatorVariables.call(ctx, {
      retriever: [{ operator: 'SqlRetriever' }]
    })).toBe(true)
    expect(methods.isSqlOperatorVariables.call(ctx, {
      retriever: [{ operator: 'SqlExecutorOperator' }]
    })).toBe(true)
    expect(methods.isSqlOperatorVariables.call(ctx, { retriever: 'not-array' })).toBe(false)
    expect(methods.isSqlOperatorVariables.call(ctx, null)).toBe(false)
  })

  it('checkIsStructKnowledgeFlow / refreshStructKnowledgeFlag', () => {
    const ctx = createCtx()
    expect(methods.checkIsStructKnowledgeFlow.call(ctx, [
      { variables: { retriever: [{ operator: 'VectorRetriever' }] } },
      {}
    ])).toBe(false)
    expect(methods.checkIsStructKnowledgeFlow.call(ctx, [
      { variables: { postretriever: [{ operator: 'SqlRetrieverOperator' }] } }
    ])).toBe(true)
    expect(methods.checkIsStructKnowledgeFlow.call(ctx, null)).toBe(false)

    // 从画布节点刷新（data.data.variables 或 data.variables 两处都可能存）
    const sqlNode = { store: { data: { data: { variables: { retriever: [{ operator: 'SqlExecutor' }] } } } } }
    ctx.graph = { getNodes: () => [sqlNode] }
    methods.refreshStructKnowledgeFlag.call(ctx)
    expect(ctx.$store.state.ragWorkflowIsStructKnowledge).toBe(true)

    const plainNode = { store: { data: { variables: { retriever: [{ operator: 'VectorRetriever' }] } } } }
    ctx.graph = { getNodes: () => [plainNode] }
    methods.refreshStructKnowledgeFlag.call(ctx)
    expect(ctx.$store.state.ragWorkflowIsStructKnowledge).toBe(false)

    ctx.graph = { getNodes: () => [] }
    methods.refreshStructKnowledgeFlag.call(ctx)
    expect(ctx.$store.state.ragWorkflowIsStructKnowledge).toBe(false)
  })
})

describe('保存链路（saveConfigHandler → exportGraph）', () => {
  it('saveConfigHandler：关闭工具抽屉、按 800ms 防抖导出；再次点击取消上一次', async () => {
    vi.useFakeTimers()
    const ctx = createCtx({ toolsOpen: true, exportGraph: vi.fn(), $route: { params: { id: 'flow-1' } } })
    methods.saveConfigHandler.call(ctx)
    expect(ctx.toolsOpen).toBe(false)
    expect(ctx.saveAppId).toBe('flow-1')
    expect(ctx.loading).toBe(true)
    expect(ctx.exportGraph).not.toHaveBeenCalled()

    methods.saveConfigHandler.call(ctx)
    await vi.advanceTimersByTimeAsync(800)
    expect(ctx.exportGraph).toHaveBeenCalledTimes(1)
  })

  it('graphAppId 与 saveAppId 不一致（保存途中切走）：放弃本次保存', () => {
    const ctx = createCtx({ graphAppId: '', saveAppId: 'flow-1', graph: { toJSON: vi.fn() } })
    methods.exportGraph.call(ctx)
    expect(ctx.loading).toBe(false)
    expect(ctx.graph.toJSON).not.toHaveBeenCalled()
  })

  function buildGraphCtx (extra = {}) {
    const node1 = {
      id: 'n1',
      shape: 'RETRIEVER',
      position: { x: 1, y: 2 },
      store: { data: { data: { variables: { retriever: [] } } } }
    }
    const node2 = {
      id: 'n2',
      shape: 'QUERY',
      position: { x: 0, y: 0 },
      store: { data: { data: { variables: {} } } }
    }
    const cellById = {
      n1: node1,
      n2: node2
    }
    const graph = {
      toJSON: () => ({
        cells: [
          { id: 'n1', shape: 'RETRIEVER', position: { x: 1, y: 2 }, ...{} },
          { id: 'n2', shape: 'QUERY', position: { x: 0, y: 0 } },
          { shape: 'edge', source: { cell: 'n2', port: 'q-out' }, target: { cell: 'n1', port: 'r-in' }, data: { preview: true } },
          { shape: 'edge', source: { cell: 'n2', port: 'q-out' }, target: { cell: 'n1', port: 'r-in' } }
        ]
      }),
      getCellById: id => cellById[id] || null
    }
    // 让 toJSON 的 cells 与 graph.getCellById 的节点共享数据（节点带上 label）
    cellById.n2.store.data.label = '开始'
    return createCtx({
      graph,
      graphAppId: 'flow-1',
      saveAppId: 'flow-1',
      version: 5,
      queryEngineType: 'SequentialQueryEngine',
      getAdvancedFlowConfig: vi.fn(),
      notifySaveSuccess: vi.fn(),
      ...extra
    })
  }

  it('check 通过：直接保存，成功后刷新；保存失败只复位 loading', async () => {
    // 注：成功分支的 loading 由被 mock 掉的 getAdvancedFlowConfig().finally 复位；
    // 这里钉住「保存失败时 exportGraph 自己负责复位」的兜底。

    const ctx = buildGraphCtx()
    apiMocks.checkSaveFlowConfig.mockReturnValue(Promise.resolve({ success: true }))
    apiMocks.saveFlowConfig.mockReturnValue(Promise.resolve({}))
    methods.exportGraph.call(ctx)
    await drain()
    await drain()

    // DTO 形状：节点补 nodeId/componentType/坐标/变量；非预览边写进 input/output
    expect(apiMocks.checkSaveFlowConfig).toHaveBeenCalledWith('flow-1', expect.objectContaining({
      flowType: 'workflow',
      version: 5
    }))
    const params = apiMocks.checkSaveFlowConfig.mock.calls[0][1]
    expect(params.nodeConfigDTOList).toHaveLength(2)
    expect(params.nodeConfigDTOList[0]).toMatchObject({
      nodeId: 'n1', componentType: 'RETRIEVER', xPosition: 1, yPosition: 2
    })
    expect(params.nodeConfigDTOList[0].inputVariables).toEqual([
      { key: 'q-out', sourceNode: 'n2', label: '开始' }
    ])
    expect(params.nodeConfigDTOList[1].outputVariables).toEqual([
      { key: 'q-out', targetNode: 'n1' }
    ])
    expect(params.otherNodeConfigList).toEqual([
      { componentType: 'QUERY_ENGINE', inputVariables: [], variables: { queryengine: { operator: 'SequentialQueryEngine' } } },
      { componentType: 'EDGES', inputVariables: [], variables: { edges: [{ source: 'n2', target: 'n1' }] } }
    ])
    expect(apiMocks.saveFlowConfig).toHaveBeenCalledWith('flow-1', params)
    expect(ctx.notifySaveSuccess).toHaveBeenCalled()
    expect(ctx.getAdvancedFlowConfig).toHaveBeenCalled()

    // 保存接口失败：不再弹确认框，只把 loading 复位（错误提示由拦截器统一弹）
    apiMocks.saveFlowConfig.mockReturnValue(Promise.reject(new Error('save failed')))
    apiMocks.checkSaveFlowConfig.mockReturnValue(Promise.resolve({ success: true }))
    const retryCtx = buildGraphCtx()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    methods.exportGraph.call(retryCtx)
    await drain()
    await drain()
    expect(retryCtx.$confirm).not.toHaveBeenCalled()
    expect(retryCtx.loading).toBe(false)
    errorSpy.mockRestore()
  })

  it('check 不通过：弹二次确认，确认后保存；取消则留在页面', async () => {
    apiMocks.checkSaveFlowConfig.mockReturnValue(Promise.resolve({ success: false, message: '引擎不可执行' }))
    apiMocks.saveFlowConfig.mockReturnValue(Promise.resolve({}))

    const confirmedCtx = buildGraphCtx({ $confirm: vi.fn(() => Promise.resolve()) })
    methods.exportGraph.call(confirmedCtx)
    await Promise.resolve()
    expect(confirmedCtx.$confirm.mock.calls[0][0]).toBe('引擎不可执行')
    await drain()
    await drain()
    expect(apiMocks.saveFlowConfig).toHaveBeenCalled()
    expect(confirmedCtx.notifySaveSuccess).toHaveBeenCalled()

    apiMocks.checkSaveFlowConfig.mockReturnValue(Promise.resolve({ success: false }))
    apiMocks.saveFlowConfig.mockClear()
    const cancelledCtx = buildGraphCtx({ $confirm: vi.fn(() => Promise.reject(new Error('cancel'))) })
    methods.exportGraph.call(cancelledCtx)
    await Promise.resolve()
    await drain()
    await drain()
    expect(apiMocks.saveFlowConfig).not.toHaveBeenCalled()
    expect(cancelledCtx.loading).toBe(false)
  })

  it('check 抛错：loading 复位，不弹确认框', async () => {
    const ctx = buildGraphCtx()
    apiMocks.checkSaveFlowConfig.mockReturnValue(Promise.reject(new Error('network')))
    methods.exportGraph.call(ctx)
    await drain()
    await drain()
    expect(ctx.$confirm).not.toHaveBeenCalled()
    expect(ctx.loading).toBe(false)
  })

  it('保存成功后的提示：未发布=保存成功；已发布=只存草稿并同步发布态', () => {
    const ctx = createCtx({ workflowPublishType: 0 })
    methods.notifySaveSuccess.call(ctx)
    expect(ctx.$message).toHaveBeenCalledWith({ type: 'success', message: 'public.saveSuccess' })
    expect(ctx.workflowPublishType).toBe(0)

    ctx.workflowPublishType = 1
    methods.notifySaveSuccess.call(ctx)
    expect(ctx.$message).toHaveBeenCalledWith({
      type: 'success',
      message: 'modules.workflow.saveDraftOnlySuccess'
    })
    expect(ctx.workflowPublishType).toBe(2)
  })
})

describe('exportWorkflow / undoChanges', () => {
  it('exportWorkflow：拿导出结果交给 download', async () => {
    const ctx = createCtx()
    apiMocks.exportWorkFlow.mockReturnValue(Promise.resolve('blob-data'))
    methods.exportWorkflow.call(ctx)
    await Promise.resolve()
    expect(apiMocks.exportWorkFlow).toHaveBeenCalledWith('flow-1')
    expect(apiMocks.download).toHaveBeenCalledWith('blob-data', '', '')
  })

  it('undoChanges：清连线/选中态后重新拉取（不重排）', () => {
    const ctx = createCtx({
      toolsOpen: true,
      selectedEdge: { id: 'e' },
      getAdvancedFlowConfig: vi.fn()
    })
    methods.undoChanges.call(ctx)
    expect(ctx.toolsOpen).toBe(false)
    expect(ctx.cancelConnection).toHaveBeenCalled()
    expect(ctx.selectedEdge).toBeNull()
    expect(ctx.clearNodeSelection).toHaveBeenCalled()
    expect(ctx.getAdvancedFlowConfig).toHaveBeenCalledWith(false)
  })
})
