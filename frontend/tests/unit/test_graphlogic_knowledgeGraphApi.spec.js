// 图谱 api 层（features/graph/api/knowledgeGraph.js）的契约单测。
// mock 掉 shared/api/client，只断言「方法 / 路径 / 参数组装 / 响应整形」——
// 拦截器与错误通道由 api.base.spec.js 走真链路覆盖，这里不重复。
// ⚠️ vi.mock 工厂会被提升：桩对象必须在工厂内联创建，再 import 回来断言。
import { vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/shared/api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/app/i18n/i18n.js', () => ({ $t: (key) => key }))

import client from '@/shared/api/client'
const axios = client

import {
  knowledgeGraphListApi,
  knowledgeBaseStatsApi,
  getKbaseFileLimitApi,
  deleteKnowledgeGraphApi,
  getKnowledgeGraphBasicInfoApi,
  getOperatorListApi,
  knowledgeGraphTemplateListApi,
  getLlmListApi,
  extractKnowledgeGraphApi,
  deleteKnowledgeGraphTemplateApi,
  uploadKnowledgeGraphTemplateApi,
  getKnowledgeGraphFileListApi,
  updateKnowledgeGraphExtractApi,
  getGraphQueryApi,
  updateEntityApi,
  deleteEntityApi,
  updateEdgeApi,
  deleteEdgeApi,
  createEdgeApi,
  createEntityApi,
  importKnowledgeGraphApi,
  getLlmOptionsApi,
  createGraphSchemaTemplate,
  exportGraphKnowledgeBaseApi,
  getGraphSchemaTemplateDetail,
  updateGraphSchemaTemplate
} from '@/features/graph/api/knowledgeGraph'

beforeEach(() => {
  axios.get.mockReset().mockResolvedValue({})
  axios.post.mockReset().mockResolvedValue({})
  axios.put.mockReset().mockResolvedValue({})
  axios.patch.mockReset().mockResolvedValue({})
  axios.delete.mockReset().mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('knowledgeGraphListApi', () => {
  it('默认 page=1 size=10，GET /knowledge-bases', async () => {
    await knowledgeGraphListApi()
    const [url, config] = axios.get.mock.calls[0]
    expect(url.endsWith('/knowledge-bases')).toBe(true)
    expect(config.params).toEqual({ page: 1, size: 10 })
  })

  it('筛选参数：keyword / categories(含单值) / embeddingModel', async () => {
    await knowledgeGraphListApi({ keyword: '图谱', categories: [1, 10], embeddingModel: 'bge-m3' })
    expect(axios.get.mock.calls[0][1].params).toEqual({
      page: 1, size: 10, keyword: '图谱', categories: '1,10', embeddingModel: 'bge-m3'
    })
    await knowledgeGraphListApi({ categories: 10 })
    expect(axios.get.mock.calls[1][1].params).toEqual({ page: 1, size: 10, categories: '10' })
  })

  it('排序参数 key:asc|desc，过滤无效项', async () => {
    await knowledgeGraphListApi({
      orderList: [
        { key: 'updated_at', ascending: false },
        { key: 'name' },
        { key: '' },
        null
      ]
    })
    expect(axios.get.mock.calls[0][1].params.sort).toBe('updated_at:desc,name:asc')
    await knowledgeGraphListApi({ orderList: [] })
    expect(axios.get.mock.calls[1][1].params.sort).toBeUndefined()
  })

  it('page/size 兼容多种字段名', async () => {
    await knowledgeGraphListApi({ page: 3, size: 20 })
    expect(axios.get.mock.calls[0][1].params).toEqual({ page: 3, size: 20 })
    await knowledgeGraphListApi({ pageNum: 5, pageSize: 30 })
    expect(axios.get.mock.calls[1][1].params).toEqual({ page: 5, size: 30 })
  })

  it('透传 config（如 skipErrorHandler）', async () => {
    await knowledgeGraphListApi({}, { skipErrorHandler: true })
    expect(axios.get.mock.calls[0][1].skipErrorHandler).toBe(true)
  })
})

describe('knowledgeBaseStatsApi / getKbaseFileLimitApi', () => {
  it('stats：categories 逗号拼接，可省略', async () => {
    await knowledgeBaseStatsApi({ categories: [1, 2] })
    expect(axios.get.mock.calls[0][0].endsWith('/knowledge-bases/stats')).toBe(true)
    expect(axios.get.mock.calls[0][1].params).toEqual({ categories: '1,2' })
    await knowledgeBaseStatsApi()
    expect(axios.get.mock.calls[1][1].params).toEqual({})
  })

  it('file-size-limits 带 category 查询参数', async () => {
    await getKbaseFileLimitApi(10)
    const [url, config] = axios.get.mock.calls[0]
    expect(url.endsWith('/system/file-size-limits')).toBe(true)
    expect(config.params).toEqual({ category: 10 })
  })
})

describe('删除 / 详情 / 模版等简单转发', () => {
  it('deleteKnowledgeGraphApi DELETE /knowledge-bases/{id}', async () => {
    await deleteKnowledgeGraphApi('kb-9')
    const [url, config] = axios.delete.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-9')).toBe(true)
    expect(config).toEqual({})
  })

  it('getKnowledgeGraphBasicInfoApi 强制 skipErrorHandler', async () => {
    await getKnowledgeGraphBasicInfoApi('kb-1')
    const [url, config] = axios.get.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/graph')).toBe(true)
    expect(config.skipErrorHandler).toBe(true)
  })

  it('模版列表 / LLM 列表不带查询参数', async () => {
    await knowledgeGraphTemplateListApi()
    expect(axios.get.mock.calls[0][0].endsWith('/graph-schemas')).toBe(true)
    await getLlmListApi()
    expect(axios.get.mock.calls[1][0].endsWith('/system/llm-models')).toBe(true)
    await getLlmOptionsApi()
    expect(axios.get.mock.calls[2][0].endsWith('/system/llm-models')).toBe(true)
  })

  it('模版详情 / 删除模版', async () => {
    await getGraphSchemaTemplateDetail('schema-1', { skipErrorHandler: true })
    const [getUrl, getConfig] = axios.get.mock.calls[0]
    expect(getUrl.endsWith('/graph-schemas/schema-1')).toBe(true)
    expect(getConfig.skipErrorHandler).toBe(true)
    await deleteKnowledgeGraphTemplateApi('schema-1')
    expect(axios.delete.mock.calls[0][0].endsWith('/graph-schemas/schema-1')).toBe(true)
  })

  it('导出图谱库为 blob 响应', async () => {
    await exportGraphKnowledgeBaseApi('kb-2')
    const [url, config] = axios.get.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-2/graph/export')).toBe(true)
    expect(config.responseType).toBe('blob')
  })
})

describe('getOperatorListApi（算子全量翻页）', () => {
  const urlOf = call => call[0]
  const paramsOf = call => call[1].params

  it('一页拿满即停', async () => {
    axios.get.mockResolvedValue({ items: [{ id: 1 }, { id: 2 }], total: 2 })
    const items = await getOperatorListApi()
    expect(items).toEqual([{ id: 1 }, { id: 2 }])
    expect(axios.get).toHaveBeenCalledTimes(1)
    expect(urlOf(axios.get.mock.calls[0]).endsWith('/operators')).toBe(true)
    expect(paramsOf(axios.get.mock.calls[0])).toEqual({ module: 'graph_extract', page: 1, size: 500 })
  })

  it('total 大于首页时继续翻页直至取满', async () => {
    axios.get
      .mockResolvedValueOnce({ items: [{ id: 1 }, { id: 2 }], total: 3 })
      .mockResolvedValueOnce({ items: [{ id: 3 }], total: 3 })
    const items = await getOperatorListApi('text_split')
    expect(items.map(i => i.id)).toEqual([1, 2, 3])
    expect(paramsOf(axios.get.mock.calls[1])).toEqual({ module: 'text_split', page: 2, size: 500 })
    expect(axios.get).toHaveBeenCalledTimes(2)
  })

  it('空页兜底停止（total 缺省按 items 长度计）', async () => {
    axios.get.mockResolvedValue({ items: [], total: undefined })
    const items = await getOperatorListApi()
    expect(items).toEqual([])
    expect(axios.get).toHaveBeenCalledTimes(1)
  })

  it('后端一直返回满页时按 maxPages 上限截断', async () => {
    axios.get.mockResolvedValue({ items: [{ id: 1 }], total: Infinity })
    const items = await getOperatorListApi()
    expect(items).toHaveLength(20)
    expect(axios.get).toHaveBeenCalledTimes(20)
  })
})

describe('生成 / 更新图谱（multipart）', () => {
  it('extractKnowledgeGraphApi 强制 multipart 头并透传 config', async () => {
    const fd = new FormData()
    await extractKnowledgeGraphApi(fd, { headers: { 'X-Extra': '1' }, timeout: 5000 })
    const [url, body, config] = axios.post.mock.calls[0]
    expect(url.endsWith('/graph-extractions')).toBe(true)
    expect(body).toBe(fd)
    expect(config.headers['Content-Type']).toBe('multipart/form-data')
    expect(config.headers['X-Extra']).toBe('1')
    expect(config.timeout).toBe(5000)
  })

  it('updateKnowledgeGraphExtractApi PUT multipart；config.headers 会整体覆盖默认头（现状行为）', async () => {
    await updateKnowledgeGraphExtractApi('kb-1', { a: 1 }, { headers: { 'X-K': 'V' } })
    const [url, body, config] = axios.put.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/graph')).toBe(true)
    expect(body).toEqual({ a: 1 })
    // 源码里 `...config` 排在 headers 之后：传入带 headers 的 config 会把 multipart 默认头整体覆盖
    expect(config.headers).toEqual({ 'X-K': 'V' })
    // 不传 headers 时保留 multipart 默认头
    await updateKnowledgeGraphExtractApi('kb-1', { b: 2 })
    expect(axios.put.mock.calls[1][2].headers).toEqual({ 'Content-Type': 'multipart/form-data' })
  })

  it('importKnowledgeGraphApi 包 file 字段', async () => {
    const file = new Blob(['graph-data'])
    await importKnowledgeGraphApi(file)
    const [url, body, config] = axios.post.mock.calls[0]
    expect(url.endsWith('/graph-imports')).toBe(true)
    expect(body.get('file').size).toBe(10)
    expect(config.headers['Content-Type']).toBe('multipart/form-data')
  })
})

describe('uploadKnowledgeGraphTemplateApi（响应整形 + 错误兜底）', () => {
  it('导入默认 5 分钟超时、全状态放行、multipart', async () => {
    axios.post.mockResolvedValue({ successCount: 1 })
    const file = new Blob(['schema-bytes'])
    await uploadKnowledgeGraphTemplateApi(file)
    const [url, body, config] = axios.post.mock.calls[0]
    expect(url.endsWith('/graph-schemas/import')).toBe(true)
    expect(body.get('schema_file').size).toBe(12)
    expect(config.timeout).toBe(300000)
    expect(config.validateStatus()).toBe(true)
    expect(config.headers['Content-Type']).toBe('multipart/form-data')
  })

  it('成功响应整形为 {success:true,data}', async () => {
    axios.post.mockResolvedValue({ successCount: 2, failedCount: 0, failedDetails: [] })
    const result = await uploadKnowledgeGraphTemplateApi({})
    expect(result).toEqual({
      success: true,
      data: { successCount: 2, failedCount: 0, failedDetails: [] }
    })
  })

  it('success===false 或带 message 时按数据错误整形', async () => {
    axios.post.mockResolvedValue({
      success: false,
      message: '格式不对',
      successCount: 1,
      failedCount: 2,
      failedDetails: ['a', 'b']
    })
    const result = await uploadKnowledgeGraphTemplateApi({})
    expect(result).toEqual({
      success: false,
      message: '格式不对',
      data: { successCount: 1, failedCount: 2, failedDetails: ['a', 'b'] }
    })

    // 只有 message（如 4xx 全放行后的业务错误体）也走数据错误分支
    axios.post.mockResolvedValue({ message: 'oops' })
    const second = await uploadKnowledgeGraphTemplateApi({})
    expect(second.success).toBe(false)
    expect(second.message).toBe('oops')
    expect(second.data).toEqual({ successCount: 0, failedCount: 0, failedDetails: [] })
  })

  it('axios 响应体包一层 data 时先拆包再整形', async () => {
    axios.post.mockResolvedValue({ data: { successCount: 3 } })
    const result = await uploadKnowledgeGraphTemplateApi({})
    expect(result).toEqual({
      success: true,
      data: { successCount: 3, failedCount: 0, failedDetails: [] }
    })
  })

  it('无信息错误兜底为网络失败文案：不抛出，返回统一失败结构', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // 没有 code / detail / message 的错误 → 网络失败文案
    axios.post.mockRejectedValue({})
    const result = await uploadKnowledgeGraphTemplateApi({})
    expect(errorSpy).toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      message: 'modules.commonUi.knowledgeGraphApi.networkFailed',
      data: { successCount: 0, failedCount: 1, failedDetails: ['modules.commonUi.knowledgeGraphApi.networkFailed'] }
    })
  })

  it('超时（ECONNABORTED）走超时文案', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const timeoutError = new Error('timeout')
    timeoutError.code = 'ECONNABORTED'
    axios.post.mockRejectedValue(timeoutError)
    const result = await uploadKnowledgeGraphTemplateApi({})
    expect(result.message).toBe('modules.commonUi.knowledgeGraphApi.timeout')
    expect(result.data.failedDetails).toEqual(['modules.commonUi.knowledgeGraphApi.timeout'])
  })

  it('带 detail / message 的错误优先透出原文', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const detailError = new Error('ignored')
    detailError.detail = 'schema 不合法'
    axios.post.mockRejectedValue(detailError)
    expect((await uploadKnowledgeGraphTemplateApi({})).message).toBe('schema 不合法')

    axios.post.mockRejectedValue(new Error('plain message'))
    expect((await uploadKnowledgeGraphTemplateApi({})).message).toBe('plain message')
  })

  it('config 可覆盖默认 timeout / validateStatus', async () => {
    axios.post.mockResolvedValue({})
    await uploadKnowledgeGraphTemplateApi({}, { timeout: 1 })
    expect(axios.post.mock.calls[0][2].timeout).toBe(1)
  })
})

describe('getKnowledgeGraphFileListApi', () => {
  it('默认分页参数', async () => {
    await getKnowledgeGraphFileListApi('kb-1')
    const [url, config] = axios.get.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/documents')).toBe(true)
    expect(config.params).toEqual({ keyword: '', page: 1, size: 50 })
  })

  it('覆盖分页与关键字', async () => {
    await getKnowledgeGraphFileListApi('kb-1', { currentPage: 2, pageSize: 20, keyword: '手册' })
    expect(axios.get.mock.calls[0][1].params).toEqual({ keyword: '手册', page: 2, size: 20 })
    await getKnowledgeGraphFileListApi('kb-1', { keyword: 'x' })
    expect(axios.get.mock.calls[1][1].params).toEqual({ keyword: 'x', page: 1, size: 50 })
  })
})

describe('getGraphQueryApi', () => {
  const URL = (kb) => `/knowledge-bases/${kb}/graph/query`

  it('queryType 映射 relation→edge、subgraph→sub_graph，其余原样', async () => {
    await getGraphQueryApi('kb-1', 100, 10, 'both', 'relation')
    expect(axios.post.mock.calls[0][1].query_type).toBe('edge')
    await getGraphQueryApi('kb-1', 100, 10, 'both', 'subgraph')
    expect(axios.post.mock.calls[1][1].query_type).toBe('sub_graph')
    await getGraphQueryApi('kb-1', 100, 10, 'both', 'entity')
    expect(axios.post.mock.calls[2][1].query_type).toBe('entity')
    await getGraphQueryApi('kb-1')
    expect(axios.post.mock.calls[3][1]).toEqual({
      limit: 100, depth: 10, direction: 'both', query_type: '', filters: []
    })
  })

  it('keyword 非空才带键且去除首尾空白', async () => {
    await getGraphQueryApi('kb-1', 10, 2, 'out', '', [], '  张三  ')
    const body = axios.post.mock.calls[0][1]
    expect(body.keyword).toBe('张三')
    await getGraphQueryApi('kb-1', 10, 2, 'out', '', [], '')
    expect('keyword' in axios.post.mock.calls[1][1]).toBe(false)
    await getGraphQueryApi('kb-1', 10, 2, 'out', '', [], '   ')
    expect('keyword' in axios.post.mock.calls[2][1]).toBe(false)
    expect(axios.post.mock.calls[0][0].endsWith(URL('kb-1'))).toBe(true)
  })

  it('filters 透传；config.headers 整体覆盖默认 JSON 头（现状行为）', async () => {
    const filters = [{ field: 'type', value: 'Term' }]
    await getGraphQueryApi('kb-1', 10, 2, 'both', '', filters, '', { headers: { 'X-T': '1' } })
    const [, body, config] = axios.post.mock.calls[0]
    expect(body.filters).toBe(filters)
    // 源码里 `...config` 排在 headers 之后：传入带 headers 的 config 会覆盖 Content-Type 默认头
    expect(config.headers).toEqual({ 'X-T': '1' })
    // 不传 headers 时保留 JSON 默认头
    await getGraphQueryApi('kb-1')
    expect(axios.post.mock.calls[1][2].headers).toEqual({ 'Content-Type': 'application/json' })
  })
})

describe('实体 / 边 CRUD', () => {
  it('updateEntityApi PATCH entities/{id}（id 走 encodeURIComponent）', async () => {
    await updateEntityApi('kb-1', 'e/1', 'Term', { name: 'x' }, { headers: { 'X-A': 'b' } })
    const [url, body, config] = axios.patch.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/graph/entities/e%2F1')).toBe(true)
    expect(body).toEqual({ entityType: 'Term', properties: { name: 'x' } })
    expect(config.headers['X-A']).toBe('b')
  })

  it('deleteEntityApi DELETE 带 entityType 查询参数', async () => {
    await deleteEntityApi('kb-1', 'e1', 'Term')
    const [url, config] = axios.delete.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/graph/entities/e1')).toBe(true)
    expect(config.params).toEqual({ entityType: 'Term' })
  })

  it('updateEdgeApi PATCH edges/{id}', async () => {
    await updateEdgeApi('kb-1', 'edge/9', 'WorksFor', { since: '2020' })
    const [url, body] = axios.patch.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/graph/edges/edge%2F9')).toBe(true)
    expect(body).toEqual({ edgeType: 'WorksFor', properties: { since: '2020' } })
  })

  it('deleteEdgeApi DELETE 带 edgeType 查询参数', async () => {
    await deleteEdgeApi('kb-1', 'e9', 'Owns')
    const [url, config] = axios.delete.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/graph/edges/e9')).toBe(true)
    expect(config.params).toEqual({ edgeType: 'Owns' })
  })

  it('createEdgeApi POST 边七元组', async () => {
    await createEdgeApi('kb-1', 'e1', 'Owns', { k: 1 }, 's1', 't1')
    const [url, body] = axios.post.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/graph/edges')).toBe(true)
    expect(body).toEqual({
      kbId: 'kb-1', edgeId: 'e1', edgeType: 'Owns', properties: { k: 1 }, sourceId: 's1', targetId: 't1'
    })
  })

  it('createEntityApi：带 / 不带 edgeInfo', async () => {
    await createEntityApi('kb-1', 'e2', 'Term', { name: 'n' }, { sourceId: 's' })
    expect(axios.post.mock.calls[0][1]).toEqual({
      kbId: 'kb-1', entityId: 'e2', entityType: 'Term', properties: { name: 'n' }, edgeInfo: { sourceId: 's' }
    })
    expect(axios.post.mock.calls[0][0].endsWith('/knowledge-bases/kb-1/graph/entities')).toBe(true)
    await createEntityApi('kb-1', 'e3', 'Term', {})
    expect(axios.post.mock.calls[1][1]).toEqual({
      kbId: 'kb-1', entityId: 'e3', entityType: 'Term', properties: {}
    })
  })
})

describe('模版建 / 改', () => {
  it('createGraphSchemaTemplate POST JSON', async () => {
    const data = { schema_name: 't', entities: [], edges: [] }
    await createGraphSchemaTemplate(data, { headers: { 'X-S': '1' } })
    const [url, body, config] = axios.post.mock.calls[0]
    expect(url.endsWith('/graph-schemas')).toBe(true)
    expect(body).toBe(data)
    // 同上：config.headers 会整体覆盖默认 JSON 头（现状行为）
    expect(config.headers).toEqual({ 'X-S': '1' })
    await createGraphSchemaTemplate(data)
    expect(axios.post.mock.calls[1][2].headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('updateGraphSchemaTemplate PATCH 到 schema_id', async () => {
    const data = { schema_id: 's9', schema_name: 't2', entities: [] }
    await updateGraphSchemaTemplate(data)
    const [url, body] = axios.patch.mock.calls[0]
    expect(url.endsWith('/graph-schemas/s9')).toBe(true)
    expect(body).toBe(data)
    expect(axios.patch.mock.calls[0][2]['Content-Type']).toBeUndefined()
    expect(axios.patch.mock.calls[0][2].headers['Content-Type']).toBe('application/json')
  })
})
