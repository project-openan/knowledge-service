// @vitest-environment jsdom
// 各 feature 的 api 出口（覆盖率 0% / 25%）的契约：出口文件基本是 re-export，
// import 即覆盖；这里逐个断言「导出完整性 + 包装函数确实转发到共享通道」。
// axios / stream 全部 mock，不发起真请求。
import { describe, expect, it, beforeEach, vi } from 'vitest'

const env = vi.hoisted(() => {
  process.env.VUE_APP_KBASE_BASE = '/kbase-api'
  process.env.VUE_APP_WORKFLOW_BASE = '/workflow-api'
  process.env.VUE_APP_QUERY_BASE = '/query-api'
  return {}
})

const { client, streamPost } = vi.hoisted(() => ({
  client: {
    get: vi.fn(() => Promise.resolve({})),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve({}))
  },
  streamPost: vi.fn(() => Promise.resolve({ ok: true }))
}))

vi.mock('@/shared/api/client', () => ({ default: client }))
vi.mock('@/shared/api/stream', () => ({ streamPost }))

import { chatQueryStream } from '@/features/chat/api/chat'
import {
  getSupportOperatorApi,
  uploadFileAndSplitConfigApi,
  getFileSizeInfoApi,
  checkAISEnvironmentApi,
  checkEnvironmentApi
} from '@/features/knowledge-base/api/kbaseApi'
import {
  createKnowledgeBase,
  searchKbasesByName,
  deleteKnowledgeBase,
  getKnowledgeBaseInfo,
  updatedKnowledgeBaseInfo,
  getDatasetList,
  getFileDatasetApi
} from '@/features/knowledge-base/api/knowledgeBase'
import { getCustomOperatorListApi } from '@/features/operators/api/operators'
import * as workflowApi from '@/features/workflow/api'
import * as graphApi from '@/features/graph/api'
import * as kbApi from '@/features/knowledge-base/api'

beforeEach(() => {
  client.get.mockReset().mockResolvedValue({})
  client.post.mockReset().mockResolvedValue({})
  client.put.mockReset().mockResolvedValue({})
  client.patch.mockReset().mockResolvedValue({})
  client.delete.mockReset().mockResolvedValue({})
  streamPost.mockReset().mockResolvedValue({ ok: true })
})

describe('chat/api/chat.js（对话测试流式出口）', () => {
  it('chatQueryStream 转发到 streamPost，路径 = QUERY_BASE + /query', async () => {
    const handlers = { onDelta: vi.fn() }
    const result = await chatQueryStream({ question: 'hi' }, handlers)

    expect(streamPost).toHaveBeenCalledTimes(1)
    expect(streamPost.mock.calls[0][0]).toBe('/query-api/query')
    expect(streamPost.mock.calls[0][1]).toEqual({ question: 'hi' })
    expect(streamPost.mock.calls[0][2]).toBe(handlers)
    expect(result).toEqual({ ok: true })
  })
})

describe('knowledge-base/api/kbaseApi.js', () => {
  it('getSupportOperatorApi：module 必带，formats 逐个 append，keyword 可选', async () => {
    await getSupportOperatorApi({ module: 'qa', formats: ['a', 'b'], keyword: 'pdf' })
    const [url] = client.get.mock.calls[0]
    expect(url).toContain('/kbase-api/operators/available?')
    expect(url).toContain('module=qa')
    // URLSearchParams 会把重复的 format 编码成 format=a&format=b
    expect(decodeURIComponent(url)).toContain('format=a')
    expect(decodeURIComponent(url)).toContain('format=b')
    expect(url).toContain('keyword=pdf')

    await getSupportOperatorApi()
    const [fallbackUrl] = client.get.mock.calls[1]
    expect(decodeURIComponent(fallbackUrl)).toContain('module=')
    expect(fallbackUrl).not.toContain('keyword=')
  })

  it('uploadFileAndSplitConfigApi：POST 文档上传，config 原样透传', async () => {
    const config = { headers: { 'x-a': '1' } }
    await uploadFileAndSplitConfigApi('kb1', { file: 'f' }, config)
    expect(client.post).toHaveBeenCalledWith('/kbase-api/knowledge-bases/kb1/documents', { file: 'f' }, config)
  })

  it('getFileSizeInfoApi：默认 category=1，调用方的 params 并入', async () => {
    await getFileSizeInfoApi()
    expect(client.get.mock.calls[0][1].params).toEqual({ category: 1 })

    await getFileSizeInfoApi({ params: { category: 2, extra: 'e' } })
    expect(client.get.mock.calls[1][1].params).toEqual({ category: 2, extra: 'e' })
  })

  it('环境检查两条路径：AIS 环境与部署方式（同一端点）', async () => {
    await checkAISEnvironmentApi()
    expect(client.get).toHaveBeenCalledWith('/kbase-api/system/info')
    await checkEnvironmentApi()
    expect(client.get).toHaveBeenCalledWith('/kbase-api/system/info')
  })
})

describe('knowledge-base/api/knowledgeBase.js', () => {
  it('createKnowledgeBase / deleteKnowledgeBase / getKnowledgeBaseInfo / updatedKnowledgeBaseInfo', async () => {
    await createKnowledgeBase({ name: 'kb' })
    expect(client.post).toHaveBeenCalledWith('/kbase-api/knowledge-bases', { name: 'kb' })

    await deleteKnowledgeBase('kb9')
    expect(client.delete).toHaveBeenCalledWith('/kbase-api/knowledge-bases/kb9')

    await getKnowledgeBaseInfo('kb9')
    expect(client.get).toHaveBeenCalledWith('/kbase-api/knowledge-bases/kb9')

    await updatedKnowledgeBaseInfo('kb9', { desc: 'd' })
    expect(client.patch).toHaveBeenCalledWith('/kbase-api/knowledge-bases/kb9', { desc: 'd' })
  })

  it('searchKbasesByName：文档知识库（categories=1）第一页模糊匹配', async () => {
    await searchKbasesByName('merge-verify')
    expect(client.get).toHaveBeenCalledWith('/kbase-api/knowledge-bases', {
      params: { categories: '1', page: 1, size: 50, keyword: 'merge-verify' }
    })
  })

  it('getDatasetList：kbaseId 拆路径，分页/关键词给默认值', async () => {
    await getDatasetList({ kbaseId: 'kb1' })
    expect(client.get).toHaveBeenCalledWith('/kbase-api/knowledge-bases/kb1/chunks', {
      params: { keyword: '', page: 1, size: 20 }
    })

    await getDatasetList({ kbaseId: 'kb1', currentPage: 3, pageSize: 5, keyword: 'k', filter: 'x' })
    expect(client.get.mock.calls[1][1].params).toEqual({ keyword: 'k', page: 3, size: 5, filter: 'x' })
  })

  it('getFileDatasetApi：搜索测试端点，rest 参数与 config 透传', async () => {
    const config = { signal: 'sig' }
    await getFileDatasetApi('file1', { kbaseId: 'kb1', currentPage: 2, keyword: 'q', tag: 't' }, config)
    const [url, callConfig] = client.get.mock.calls[0]
    expect(url).toBe('/kbase-api/knowledge-bases/kb1/documents/file1/chunks')
    expect(callConfig.params).toEqual({ keyword: 'q', page: 2, size: 10, tag: 't' })
    expect(callConfig.signal).toBe('sig')
  })
})

describe('operators/api/operators.js', () => {
  it('getCustomOperatorListApi：按环节（module）拉自定义算子', async () => {
    await getCustomOperatorListApi('graph')
    expect(client.get).toHaveBeenCalledWith('/kbase-api/operators/supported', {
      params: { module: 'graph' }
    })
  })
})

describe('workflow/api/workflow.js（13 个出口）', () => {
  it('草稿 / 已发布快照 / 画布知识库下拉', async () => {
    const config = { headers: { 'x-b': '2' } }
    await workflowApi.getFlowConfig('app1', config)
    expect(client.get).toHaveBeenCalledWith('/workflow-api/workflows/app1/flow', config)

    await workflowApi.getPublishedFlowConfig('app1')
    expect(client.get).toHaveBeenCalledWith('/workflow-api/workflows/app1/publication')

    await workflowApi.getAllStatusKbase({ scene: 'canvas' })
    expect(client.get).toHaveBeenCalledWith('/workflow-api/workflows/knowledge-bases', {
      params: { scene: 'canvas' }
    })

    await workflowApi.getAllKBList()
    expect(client.get).toHaveBeenCalledWith('/workflow-api/workflows/knowledge-bases', { params: {} })
  })

  it('校验 / 保存 / 导出 / 列表 / 创建', async () => {
    await workflowApi.checkSaveFlowConfig('app1', { nodes: [] }, { timeout: 1 })
    expect(client.post).toHaveBeenCalledWith('/workflow-api/workflows/app1/validate', { nodes: [] }, { timeout: 1 })

    await workflowApi.saveFlowConfig('app1', { nodes: [1] }, {})
    expect(client.put).toHaveBeenCalledWith('/workflow-api/workflows/app1/flow', { nodes: [1] }, {})

    await workflowApi.exportWorkFlow('app1')
    expect(client.get).toHaveBeenCalledWith('/workflow-api/workflows/app1/export', {
      responseType: 'blob'
    })

    await workflowApi.getFlowList(2, 10, 'rag')
    expect(client.get).toHaveBeenCalledWith('/workflow-api/workflows', {
      params: { page: 2, size: 10, keyword: 'rag' }
    })

    await workflowApi.getFlowList(1, 20)
    // 关键词缺省为空串（get 调用依次是 export / list / list）
    expect(client.get).toHaveBeenLastCalledWith('/workflow-api/workflows', {
      params: { page: 1, size: 20, keyword: '' }
    })

    await workflowApi.createFlow({ name: 'w' })
    expect(client.post).toHaveBeenCalledWith('/workflow-api/workflows', { name: 'w' }, {})
  })

  it('updateFlow：workFlowId / workflowId / appId 三种历史参数名都能定位', async () => {
    await workflowApi.updateFlow({ workFlowId: 'a', name: 'n' })
    expect(client.patch).toHaveBeenLastCalledWith('/workflow-api/workflows/a', { workFlowId: 'a', name: 'n' }, {})

    await workflowApi.updateFlow({ workflowId: 'b' })
    expect(client.patch).toHaveBeenLastCalledWith('/workflow-api/workflows/b', { workflowId: 'b' }, {})

    await workflowApi.updateFlow({ appId: 'c' })
    expect(client.patch).toHaveBeenLastCalledWith('/workflow-api/workflows/c', { appId: 'c' }, {})
  })

  it('删除 / 发布（auto-install 头）/ 取消发布', async () => {
    await workflowApi.deleteFlowApi('w1')
    expect(client.delete).toHaveBeenCalledWith('/workflow-api/workflows/w1')

    await workflowApi.publishWorkFlow('w1')
    expect(client.post).toHaveBeenCalledWith('/workflow-api/workflows/w1/publication', null, {
      headers: { 'auto-install': 'true' }
    })

    await workflowApi.unpublishWorkFlow('w1')
    expect(client.delete).toHaveBeenCalledWith('/workflow-api/workflows/w1/publication')
  })
})

describe('feature 出口的导出完整性', () => {
  it('workflow/api 出口转发 workflow.js 的全部命名导出', () => {
    for (const key of [
      'getFlowConfig', 'getPublishedFlowConfig', 'getAllStatusKbase', 'getAllKBList',
      'checkSaveFlowConfig', 'saveFlowConfig', 'exportWorkFlow', 'getFlowList',
      'createFlow', 'updateFlow', 'deleteFlowApi', 'publishWorkFlow', 'unpublishWorkFlow'
    ]) {
      expect(typeof workflowApi[key], `workflow 出口缺 ${key}`).toBe('function')
    }
  })

  it('graph/api 出口：knowledgeGraph.js 全量 + graph-build-config 纯函数', () => {
    for (const key of [
      'buildGraphExtractPayload', 'defaultBuildParams', 'isIntegerArg',
      'orderedOperatorArgs', 'validateBuildParams',
      'CHUNK_SIZE_MIN', 'CHUNK_SIZE_MAX', 'OVERLAP_MIN', 'OVERLAP_MAX'
    ]) {
      expect(key in graphApi, `graph 出口缺 ${key}`).toBe(true)
    }
    expect(graphApi.CHUNK_SIZE_MAX).toBeGreaterThan(graphApi.CHUNK_SIZE_MIN)
    expect(graphApi.OVERLAP_MAX).toBeGreaterThan(graphApi.OVERLAP_MIN)
  })

  it('knowledge-base/api 出口：api 三件套 + 建图弹窗 + 共享 lib', () => {
    expect(typeof kbApi.getSupportOperatorApi).toBe('function')
    expect(typeof kbApi.createKnowledgeBase).toBe('function')
    expect(kbApi.CreateKnowledgeDialog).toBeTruthy()
    expect(kbApi.KB_STATUS).toBeTruthy()
    expect(typeof kbApi.isDocKbPublishEnabled).toBe('function')
    expect(typeof kbApi.isGraphPublishEnabled).toBe('function')
    expect(typeof kbApi.normalizeStatsResponse).toBe('function')
    expect(typeof kbApi.overviewFor).toBe('function')
    expect(kbApi.DOC_KB_STATUS_FILTERS.length).toBeGreaterThan(0)
    expect(kbApi.GRAPH_STATUS_FILTERS.length).toBeGreaterThan(0)
    expect(kbApi.ALL_STATUS_FILTER).toBeTruthy()
    expect(typeof kbApi.findStatusFilterOption).toBe('function')
    expect(typeof kbApi.fallbackUploadLimits).toBe('function')
    expect(typeof kbApi.toUploadLimits).toBe('function')
    expect(typeof kbApi.toNum).toBe('function')
    expect(typeof kbApi.findStatusDefinition).toBe('function')
    expect(kbApi.DOC_KB_STATUS_DEFINITIONS.length).toBeGreaterThan(0)
    expect(kbApi.GRAPH_STATUS_DEFINITIONS.length).toBeGreaterThan(0)
  })
})
