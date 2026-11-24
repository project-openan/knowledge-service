// 编排模块的纯逻辑层：calculatePort（X6 端口几何）、store.js（feature 本地单例）、
// api/workflow.js（REST 包装）。三者都不碰组件树：calculatePort 用假 target/graph
// 驱动，api 层 mock 掉 axios client 断言 URL/方法/参数。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── calculatePort.js ─────────────────────────────────────────────────────────
import calculatePort from '@/features/workflow/calculatePort'
import {
  Preretriever,
  Retriever,
  OUTPUT_INTERVAL
} from '@/features/workflow/lib/workflow'

/** mixin 形状的 ctx：data() 给映射，graph 换成假件。 */
function createPortCtx (incomingEdges = []) {
  return {
    ...calculatePort.data(),
    graph: { getIncomingEdges: vi.fn(() => incomingEdges) }
  }
}

/** 假 X6 节点：store.data.shape 决定查哪张端口表，portProp 记录调用。 */
function makeTarget (shape = 'PRE_RETRIEVER') {
  return {
    id: 'node-1',
    store: { data: { shape } },
    portProp: vi.fn()
  }
}

describe('calculatePort：单输出口随入边数下移', () => {
  it('target 缺失或 shape 不在映射里：不动端口', () => {
    const ctx = createPortCtx()
    calculatePort.methods.updateOuputPortForSingleOutput.call(ctx, null)
    calculatePort.methods.updateOuputPortForSingleOutput.call(ctx, makeTarget('QUERY'))
    expect(ctx.graph.getIncomingEdges).not.toHaveBeenCalled()
  })

  it('无入边：output.y 取基准值', () => {
    const ctx = createPortCtx([])
    const target = makeTarget('PRE_RETRIEVER')
    calculatePort.methods.updateOuputPortForSingleOutput.call(ctx, target)
    expect(ctx.graph.getIncomingEdges).toHaveBeenCalledWith('node-1')
    expect(target.portProp).toHaveBeenCalledWith('preretriever_output', {
      group: 'out',
      args: { x: Preretriever.output.x, y: Preretriever.output.y }
    })
  })

  it('getIncomingEdges 返回 undefined：同无入边', () => {
    const ctx = createPortCtx(undefined)
    const target = makeTarget('RETRIEVER')
    calculatePort.methods.updateOuputPortForSingleOutput.call(ctx, target)
    expect(target.portProp).toHaveBeenCalledWith('retriever_output', {
      group: 'out',
      args: { x: Retriever.output.x, y: Retriever.output.y }
    })
  })

  it('1 条入边：用 output_with_1_incoming_edge.y', () => {
    const ctx = createPortCtx([{ id: 'e1' }])
    const target = makeTarget('RETRIEVER')
    calculatePort.methods.updateOuputPortForSingleOutput.call(ctx, target)
    expect(target.portProp).toHaveBeenCalledWith('retriever_output', {
      group: 'out',
      args: { x: Retriever.output.x, y: Retriever.output_with_1_incoming_edge.y }
    })
  })

  it('多条入边：每多一条再下移一个 OUTPUT_INTERVAL', () => {
    const ctx = createPortCtx([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }])
    const target = makeTarget('POST_RETRIEVER')
    calculatePort.methods.updateOuputPortForSingleOutput.call(ctx, target)
    expect(target.portProp).toHaveBeenCalledWith('postretriever_output', {
      group: 'out',
      args: {
        x: Preretriever.output.x,
        y: Preretriever.output_with_1_incoming_edge.y + OUTPUT_INTERVAL * 2
      }
    })
  })
})

describe('calculatePort：换算子后同时校准输入/输出口', () => {
  it('target 缺失：不动端口', () => {
    // 注：该方法没有 shape 白名单闸门（与 updateOuputPortForSingleOutput 不同），
    // 未知 shape 会在 variables[undefined].length 处炸 —— 调用方保证只传四个业务节点。
    const ctx = createPortCtx()
    calculatePort.methods.updatePortAfterChangingOperators.call(ctx, null, {})
    expect(ctx.graph.getIncomingEdges).not.toHaveBeenCalled()
  })

  it('算子列表为空：口回到基准 y', () => {
    const ctx = createPortCtx()
    const target = makeTarget('RETRIEVER')
    calculatePort.methods.updatePortAfterChangingOperators.call(ctx, target, { retriever: [] })
    expect(target.portProp).toHaveBeenCalledTimes(2)
    expect(target.portProp).toHaveBeenNthCalledWith(1, 'retriever_output', {
      group: 'out',
      args: { x: Retriever.output.x, y: Retriever.output.y }
    })
    expect(target.portProp).toHaveBeenNthCalledWith(2, 'retriever_input', {
      group: 'in',
      args: { x: Retriever.input.x, y: Retriever.input.y }
    })
  })

  it('有 N 个算子：两口的 y 都按 24px 步进下移', () => {
    const ctx = createPortCtx()
    const target = makeTarget('RESPONSE_SYNTHESIZER')
    calculatePort.methods.updatePortAfterChangingOperators.call(
      ctx, target, { responsesynthesizer: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    expect(target.portProp).toHaveBeenCalledWith('responsesynthesizer_output', {
      group: 'out',
      args: { x: Preretriever.output.x, y: Preretriever.output.y + 24 * 2 }
    })
    expect(target.portProp).toHaveBeenCalledWith('responsesynthesizer_input', {
      group: 'in',
      args: { x: Preretriever.input.x, y: Preretriever.input.y + 24 * 2 }
    })
  })
})

// ── store.js ─────────────────────────────────────────────────────────────────
import { installLegacyWorkflowStateCompat, workflowState } from '@/features/workflow/store'

describe('workflow store：feature 本地 reactive 单例', () => {
  afterEach(() => {
    // 单例跨用例共享：把可写字段拨回初始值，别污染别的 spec
    workflowState.isAdvancedFlowEditMode = false
    workflowState.ragWorkflowType = ''
    workflowState.flow.userGuideVariables = {}
  })

  it('默认状态：非编辑态、引擎类型为空', () => {
    expect(workflowState.isAdvancedFlowEditMode).toBe(false)
    expect(workflowState.ragWorkflowType).toBe('')
    expect(workflowState.flow.userGuideVariables).toEqual({})
  })

  it('installLegacyWorkflowStateCompat：旧 $store 路径读写转发到同一份数据', () => {
    const rootState = {}
    installLegacyWorkflowStateCompat(rootState)
    expect(Object.keys(rootState)).toContain('ragWorkflowType') // enumerable

    rootState.ragWorkflowType = 'BlendedQueryEngine'
    expect(workflowState.ragWorkflowType).toBe('BlendedQueryEngine')

    workflowState.ragWorkflowType = 'SequentialQueryEngine'
    expect(rootState.ragWorkflowType).toBe('SequentialQueryEngine')
  })
})

// ── api/workflow.js ──────────────────────────────────────────────────────────
const axiosClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn()
}))

vi.mock('@/shared/api/client', () => ({ default: axiosClient }))

import {
  checkSaveFlowConfig,
  createFlow,
  deleteFlowApi,
  exportWorkFlow,
  getAllKBList,
  getAllStatusKbase,
  getFlowConfig,
  getFlowList,
  getPublishedFlowConfig,
  publishWorkFlow,
  saveFlowConfig,
  unpublishWorkFlow,
  updateFlow
} from '@/features/workflow/api/workflow'

// 模块与 spec 用同一环境变量求值，URL 断言才不依赖部署配置
const WORKFLOW_BASE = process.env.VUE_APP_WORKFLOW_BASE
const workflows = `${WORKFLOW_BASE}/workflows`

describe('workflow api：REST 包装的 URL / 方法 / 参数', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getFlowConfig / getPublishedFlowConfig：草稿与已发布快照分开拉', () => {
    getFlowConfig('app-1', { params: { a: 1 } })
    expect(axiosClient.get).toHaveBeenCalledWith(`${workflows}/app-1/flow`, { params: { a: 1 } })

    getPublishedFlowConfig('app-2')
    expect(axiosClient.get).toHaveBeenCalledWith(`${workflows}/app-2/publication`)
  })

  it('getAllStatusKbase / getAllKBList：同一条知识库下拉路径', () => {
    getAllStatusKbase({ a: 1 })
    expect(axiosClient.get).toHaveBeenLastCalledWith(`${workflows}/knowledge-bases`, { params: { a: 1 } })

    getAllKBList()
    expect(axiosClient.get).toHaveBeenLastCalledWith(`${workflows}/knowledge-bases`, { params: {} })
  })

  it('checkSaveFlowConfig / saveFlowConfig：校验 POST、保存 PUT，透传 config', () => {
    checkSaveFlowConfig('app-1', { x: 1 })
    expect(axiosClient.post).toHaveBeenCalledWith(`${workflows}/app-1/validate`, { x: 1 }, {})

    saveFlowConfig('app-1', { y: 2 }, { headers: { h: 1 } })
    expect(axiosClient.put).toHaveBeenCalledWith(`${workflows}/app-1/flow`, { y: 2 }, { headers: { h: 1 } })
  })

  it('exportWorkFlow：按 blob 拉导出文件', () => {
    exportWorkFlow('app-3')
    expect(axiosClient.get).toHaveBeenCalledWith(`${workflows}/app-3/export`, { responseType: 'blob' })
  })

  it('getFlowList：分页 + 关键词（默认空串）', () => {
    getFlowList(2, 10, 'rag')
    expect(axiosClient.get).toHaveBeenCalledWith(workflows, {
      params: { page: 2, size: 10, keyword: 'rag' }
    })

    getFlowList(1, 20)
    expect(axiosClient.get).toHaveBeenLastCalledWith(workflows, {
      params: { page: 1, size: 20, keyword: '' }
    })
  })

  it('createFlow / deleteFlowApi', () => {
    createFlow({ name: 'w' })
    expect(axiosClient.post).toHaveBeenCalledWith(workflows, { name: 'w' }, {})

    deleteFlowApi('app-9')
    expect(axiosClient.delete).toHaveBeenCalledWith(`${workflows}/app-9`)
  })

  it('updateFlow：workflowId 兼容三种历史字段名', () => {
    updateFlow({ workFlowId: 'old', name: 'a' })
    expect(axiosClient.patch).toHaveBeenCalledWith(`${workflows}/old`, { workFlowId: 'old', name: 'a' }, {})

    updateFlow({ workflowId: 'mid' })
    expect(axiosClient.patch).toHaveBeenLastCalledWith(`${workflows}/mid`, { workflowId: 'mid' }, {})

    updateFlow({ appId: 'new' })
    expect(axiosClient.patch).toHaveBeenLastCalledWith(`${workflows}/new`, { appId: 'new' }, {})
  })

  it('publishWorkFlow 带 auto-install 头；unpublishWorkFlow 只删发布记录', () => {
    publishWorkFlow('app-1')
    expect(axiosClient.post).toHaveBeenCalledWith(`${workflows}/app-1/publication`, null, {
      headers: { 'auto-install': 'true' }
    })

    unpublishWorkFlow('app-1')
    expect(axiosClient.delete).toHaveBeenCalledWith(`${workflows}/app-1/publication`)
  })
})
