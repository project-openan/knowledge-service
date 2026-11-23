// @vitest-environment jsdom
/**
 * GraphDetailPage.vue（/graph/detail/:id 知识图谱详情页）—— script 逻辑分支专项：
 * - 详情装配：fetchDetailData 的四条出口（无 id / 成功 / 404 回列表 / 其他失败），
 *   schemaInfo 有无决定模版信息与类型筛选的填法，fileInfo 映射，stats 计数；
 * - 可视化取数：fetchGraphVisualizationData 的「详情未就绪不出手」「无模版报错」、
 *   手动查询按 payload 带条件、空查询 / 空结果 / 响应异常各自清画布并提示；
 * - 刷新链路：handleRefreshGraphData 的 loading 闸门、refreshFromServer（sticky
 *   补查 + 删除清理）、增量更新（added/updated 实体与关系）、全量替换、格式异常；
 * - 基本信息页派生数据：指标卡、算子名（中英回退）、可见类型、文件搜索分页与体积；
 * - 页壳动作：导出、去修改页、复制标识、tab 与路由 query 的双向映射、切 id 重载。
 *
 * GraphVisualization 换成可编程桩（expose 主文件会调的方法），api 全 mock，
 * WorkspaceShell 只透传插槽。
 */
import { vi } from 'vitest'
import { h } from 'vue'

const { api, vis } = vi.hoisted(() => ({
  api: {
    getKnowledgeGraphBasicInfoApi: vi.fn(),
    getGraphQueryApi: vi.fn(),
    getOperatorListApi: vi.fn()
  },
  vis: {
    restoreLayoutAfterRefresh: vi.fn(async () => {}),
    fitViewImmediate: vi.fn(),
    exitFullscreen: vi.fn()
  }
}))

vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  getKnowledgeGraphBasicInfoApi: (...args) => api.getKnowledgeGraphBasicInfoApi(...args),
  getGraphQueryApi: (...args) => api.getGraphQueryApi(...args),
  getOperatorListApi: (...args) => api.getOperatorListApi(...args)
}))

vi.mock('@/shared/lib/copy-with-toast', () => ({
  copyTextWithToast: vi.fn(() => true)
}))

// 画布组件：expose 页面会调的方法 + 可从用例 emit 事件
vi.mock('@/features/graph/components/GraphVisualization.vue', () => ({
  default: {
    name: 'GraphVisualizationStub',
    props: ['graphData', 'graphName', 'resetToken'],
    setup (_, { expose }) {
      expose({
        restoreLayoutAfterRefresh: vis.restoreLayoutAfterRefresh,
        fitViewImmediate: vis.fitViewImmediate,
        exitFullscreen: vis.exitFullscreen
      })
      return () => h('div', { class: 'graph-vis-stub' })
    }
  }
}))

vi.mock('@/app/layout/WorkspaceShell.vue', () => ({
  default: {
    name: 'WorkspaceShellStub',
    props: ['back', 'parent', 'context', 'title', 'icon', 'showFocusAction'],
    setup (_, { slots }) {
      return () => h('div', { class: 'workspace-shell-stub' }, [
        h('div', { class: 'stub-subtitle' }, slots.subtitle ? slots.subtitle() : []),
        h('div', { class: 'stub-actions' }, slots.actions ? slots.actions() : []),
        h('div', { class: 'stub-body' }, slots.default ? slots.default() : [])
      ])
    }
  }
}))

import { flush, mountWithPlugins } from './helpers/mount'
import { copyTextWithToast } from '@/shared/lib/copy-with-toast'
import GraphDetailPage from '@/pages/graph/GraphDetailPage.vue'

const ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } },
  { path: '/graph/detail/:id', name: 'graph-detail', component: { render: () => null } },
  { path: '/graph/edit/:id', name: 'graph-edit', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

const closeMock = vi.fn()
const messageMock = Object.assign(vi.fn(() => ({ close: closeMock })), {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn()
})

/** 一份「完整」详情接口返回：基本信息 + schema + 文件 + stats */
function detailResponse ({ schema = true } = {}) {
  return {
    data: {
      id: 'kb-1',
      name: '电影图谱',
      description: '剧情与人物',
      embeddingModel: 'bge-large',
      operatorId: 3,
      tableName: 'graph_movie',
      source: 'manual',
      createdDate: '2026-05-01 09:00:00',
      createdBy: 'tester',
      currentFileCount: 2
    },
    schemaInfo: schema
      ? {
          schema_name: '影视模版',
          schema_id: 'tpl-9',
          schema_desc: '影视实体关系',
          entities: [{ entity_type: 'Scene' }, { entity_type: 'Character' }],
          edges: [{ edge_type: 'Relates' }]
        }
      : null,
    fileInfo: [
      { id: 'f1', title: '剧本.pdf', fileSize: 1024 * 1024, fileFrom: '1', createdBy: '甲', createdDate: '2026-05-02 10:00:00' },
      { id: 'f2', title: '设定.docx', fileSize: 2048, fileFrom: '2', createdBy: '乙', createdDate: '2026-05-03 10:00:00' }
    ],
    stats: { entityCount: 120, edgeCount: 300 }
  }
}

function queryResponse ({ entities = [], edges = [], hasMore = false } = {}) {
  return {
    entities: entities.map(e => ({ entity_id: e[0], entity_type: e[1], entity_name: e[2] || e[0], properties: {} })),
    edges: edges.map(e => ({ edge_id: e[0], edge_type: e[1], source_id: e[2], target_id: e[3], properties: {} })),
    has_more: hasMore
  }
}

/** requestViewGraphData 里有 rAF + 双 nextTick：等一帧让挂载期的自动查询跑完。 */
async function settleFrame () {
  await flush()
  await new Promise(resolve => setTimeout(resolve, 40))
  await flush()
}

async function mountPage ({ route = '/graph/detail/kb-1', detail = detailResponse(), basicInfoImpl } = {}) {
  api.getKnowledgeGraphBasicInfoApi.mockReset()
  if (basicInfoImpl) {
    api.getKnowledgeGraphBasicInfoApi.mockImplementation(basicInfoImpl)
  } else {
    api.getKnowledgeGraphBasicInfoApi.mockResolvedValue(detail)
  }
  api.getGraphQueryApi.mockReset().mockResolvedValue(queryResponse({
    entities: [['e1', 'Scene', '场景甲'], ['e2', 'Character', '角色乙']],
    edges: [['r1', 'Relates', 'e1', 'e2']]
  }))
  api.getOperatorListApi.mockReset().mockResolvedValue([
    { id: 3, name: '通用抽取', nameEn: 'GeneralExtract' },
    { id: 4, name: '专业域', nameEn: 'Professional' }
  ])
  const wrapper = await mountWithPlugins(GraphDetailPage, {
    route,
    routes: ROUTES,
    attachTo: document.body,
    global: { config: { globalProperties: { $message: messageMock } } }
  })
  await settleFrame()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom 自带 createObjectURL：换成 spy 以便断言下载链路
  URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('详情装配（fetchDetailData 四条出口）', () => {
  it('无 id（列表路由）不出手请求', async () => {
    await mountPage({ route: '/graph' })
    expect(api.getKnowledgeGraphBasicInfoApi).not.toHaveBeenCalled()
  })

  it('成功 + schema：类型全选、模版信息回填、文件映射、stats 计数，随后自动查一次画布数据', async () => {
    const wrapper = await mountPage()

    expect(wrapper.vm.detailData.name).toBe('电影图谱')
    expect(wrapper.vm.detailData.tableName).toBe('graph_movie')
    expect(wrapper.vm.availableEntityTypes).toEqual(['Scene', 'Character'])
    expect(wrapper.vm.availableEdgeTypes).toEqual(['Relates'])
    expect(wrapper.vm.selectedEntityTypes).toEqual(['Scene', 'Character'])
    expect(wrapper.vm.schemaMapping).toHaveProperty('entity_meta')
    expect(wrapper.vm.detailData.files).toHaveLength(2)
    expect(wrapper.vm.detailData.files[0]).toMatchObject({ name: '剧本.pdf', size: 1024 * 1024 })
    expect(wrapper.vm.graphStats).toEqual({ entityCount: 120, edgeCount: 300 })
    expect(wrapper.vm.loadedDetailId).toBe('kb-1')
    // 详情就绪后自动查询一次
    expect(api.getGraphQueryApi).toHaveBeenCalledWith('kb-1', 50, 10, 'both', 'entity', [], '')
    expect(messageMock.success).toHaveBeenCalled()
    expect(wrapper.vm.graphResetToken).toBeGreaterThan(0)
  })

  it('成功但无 schema：模版信息清空、类型列表为空、画布查询报「模版不存在」', async () => {
    const wrapper = await mountPage({ detail: detailResponse({ schema: false }) })

    expect(wrapper.vm.availableEntityTypes).toEqual([])
    expect(wrapper.vm.detailData.templateName).toBe('')
    // fetch 仍会被 tab watcher 触发，但因 schemaInfo 为空只给警告
    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.noTemplateInfoForPreview'))
    expect(api.getGraphQueryApi).not.toHaveBeenCalled()
  })

  it('404：提示不存在并回列表', async () => {
    const notFound = Object.assign(new Error('nf'), { status: 404 })
    const wrapper = await mountPage({ basicInfoImpl: () => Promise.reject(notFound) })

    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.graphNotFound'))
    expect(wrapper.router.currentRoute.value.name).toBe('graph')
  })

  it('其他失败：提示获取详情失败，停留在当前页', async () => {
    const wrapper = await mountPage({ basicInfoImpl: () => Promise.reject(new Error('boom')) })

    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.getDetailFailed'))
    expect(wrapper.router.currentRoute.value.name).toBe('graph-detail')
    expect(wrapper.vm.loadedDetailId).toBe('')
  })
})

describe('切 id / tab / 页壳动作', () => {
  it('同一路由换 id：先清空旧图谱状态再重新取数', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.detailData.name).toBe('电影图谱')

    const second = detailResponse()
    second.data.name = '第二张图'
    api.getKnowledgeGraphBasicInfoApi.mockResolvedValue(second)
    await wrapper.router.push('/graph/detail/kb-2')
    await flush()
    await flush()

    expect(wrapper.vm.detailData.name).toBe('第二张图')
    expect(wrapper.vm.loadedDetailId).toBe('kb-2')
    expect(api.getGraphQueryApi).toHaveBeenCalled() // 新图谱自动重查一次
  })

  it('tab 与路由 query 双向映射：?tab=info 显示基本信息，页头动作退出画布全屏', async () => {
    const wrapper = await mountPage()
    wrapper.vm.activeTab = 'basicInfo'
    await flush()
    expect(wrapper.router.currentRoute.value.query.tab).toBe('info')
    expect(vis.exitFullscreen).toHaveBeenCalled()

    wrapper.vm.activeTab = 'viewGraph'
    await flush()
    await flush()
    expect(wrapper.router.currentRoute.value.query.tab).toBeUndefined()
    // 切回画布：详情已就绪 → 自动查询并递增 resetToken
    const token = wrapper.vm.graphResetToken
    expect(token).toBeGreaterThan(0)
    expect(api.getGraphQueryApi).toHaveBeenCalled()
  })

  it('去修改页：带 id 时 push graph-edit，无 id 不动作', async () => {
    const wrapper = await mountPage()
    wrapper.vm.goEditGraph()
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('graph-edit')
    wrapper.unmount()

    const listPage = await mountPage({ route: '/graph' })
    listPage.vm.goEditGraph()
    await flush()
    expect(listPage.router.currentRoute.value.name).toBe('graph')
  })

  it('导出：基础信息 + 当前画布数据打包成 JSON blob 下载', async () => {
    const wrapper = await mountPage()
    const payload = await new Promise(resolve => {
      const OriginalBlob = globalThis.Blob
      vi.stubGlobal('Blob', class {
        constructor (parts) {
          resolve({ text: parts[0], type: arguments[1] })
          this.size = parts[0].length
        }
      })
      wrapper.vm.exportGraph()
      vi.unstubAllGlobals()
      void OriginalBlob
    })
    const parsed = JSON.parse(payload.text)
    expect(parsed.graph.name).toBe('电影图谱')
    expect(Array.isArray(parsed.nodes)).toBe(true)
    expect(payload.type).toEqual({ type: 'application/json' })
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('复制标识与刷新按钮链路', async () => {
    const wrapper = await mountPage()
    wrapper.vm.copyText(wrapper.vm.graphIdentifier)
    expect(vi.mocked(copyTextWithToast)).toHaveBeenCalledWith('graph_movie')

    // 刷新来源文件 + 统计：成功后文件与 stats 同步
    api.getKnowledgeGraphBasicInfoApi.mockResolvedValue(detailResponse())
    await wrapper.vm.refreshSourceFiles()
    expect(wrapper.vm.detailData.files).toHaveLength(2)

    // 详情接口失败时 refreshSourceFiles 抛错（刷新按钮显示可重试）
    api.getKnowledgeGraphBasicInfoApi.mockRejectedValue(new Error('x'))
    await expect(wrapper.vm.refreshSourceFiles()).rejects.toThrow('x')
  })

  it('refreshGraphStats：失败静默（console.warn），不影响画布', async () => {
    const wrapper = await mountPage()
    api.getKnowledgeGraphBasicInfoApi.mockRejectedValue(new Error('stats'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await wrapper.vm.refreshGraphStats()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('可视化取数分支（fetchGraphVisualizationData）', () => {
  it('详情未就绪 / 无 id 时不出手查询', async () => {
    const wrapper = await mountPage()
    api.getGraphQueryApi.mockClear()
    wrapper.vm.loadedDetailId = ''
    await wrapper.vm.fetchGraphVisualizationData(null, false, [], [])
    expect(api.getGraphQueryApi).not.toHaveBeenCalled()
  })

  it('手动查询带条件：queryType / direction / filters / 关键词按 payload 透传', async () => {
    const wrapper = await mountPage()
    const payload = {
      queryType: 'subgraph',
      direction: 'out',
      filters: [{
        entity_type: ['Scene'],
        properties: { name: { op: 'eq', value: '第一幕' } }
      }]
    }
    await wrapper.vm.handleExecuteQuery(payload)
    expect(api.getGraphQueryApi).toHaveBeenCalledWith('kb-1', 50, 10, 'out', 'subgraph', payload.filters, '')
    expect(wrapper.vm.lastQueryPayload).toEqual(payload)
    expect(wrapper.vm.isManualQuery).toBe(true)
    expect(vis.restoreLayoutAfterRefresh).toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled() // loading 提示被关掉
  })

  it('手动查询无任何条件：走「空查询」分支（filters=[]），关键词也算条件', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.handleExecuteQuery({ queryType: 'entity', filters: [] })
    expect(api.getGraphQueryApi).toHaveBeenCalledWith('kb-1', 50, 10, 'both', 'entity', [], '')
  })

  it('关键词作为查询条件：带 keyword 的手动查询不再走空查询', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.handleExecuteQuery({ queryType: 'entity', filters: [], keyword: '法庭' })
    expect(api.getGraphQueryApi).toHaveBeenCalledWith('kb-1', 50, 10, 'both', 'entity', [], '法庭')
  })

  it('空结果：清画布 + 警告；has_more 透传；limit 按本地数量抬升', async () => {
    const wrapper = await mountPage()
    api.getGraphQueryApi.mockResolvedValue({ entities: [], edges: [], has_more: true })
    await wrapper.vm.fetchGraphVisualizationData(null, false, [], [])
    expect(wrapper.vm.graphData).toEqual({ entities: [], edges: [] })
    expect(wrapper.vm.graphResultHasMore).toBe(true)
    expect(messageMock.warning).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.queryDataEmpty'))

    // 结果数量超过 limit：limit 抬到本地数量（relation/subgraph 按 edges 对齐）
    api.getGraphQueryApi.mockResolvedValue(queryResponse({
      edges: [['r1', 'Relates', 'e1', 'e2'], ['r2', 'Relates', 'e2', 'e3']],
      entities: [['e1', 'Scene'], ['e2', 'Scene'], ['e3', 'Scene']]
    }))
    await wrapper.vm.fetchGraphVisualizationData(null, false, [], [], false)
    // limitValue 仍是 50（3 < 50）——用超过 50 的数据再验一次抬升
    const big = queryResponse({ entities: Array.from({ length: 60 }, (_, i) => [`e${i}`, 'Scene']) })
    api.getGraphQueryApi.mockResolvedValue(big)
    await wrapper.vm.fetchGraphVisualizationData(null, false, [], [])
    expect(wrapper.vm.limitValue).toBeGreaterThanOrEqual(60)
  })

  it('响应为空：提示无数据并清画布', async () => {
    const wrapper = await mountPage()
    api.getGraphQueryApi.mockResolvedValue(null)
    await wrapper.vm.fetchGraphVisualizationData(null, false, [], [])
    expect(wrapper.vm.graphData).toEqual({ entities: [], edges: [] })
    expect(wrapper.vm.graphResultHasMore).toBe(false)
    expect(messageMock.warning).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.knowledgeGraphPreviewNoData'))
  })

  it('查询抛错：清画布不弹错误（拦截器已提示）', async () => {
    const wrapper = await mountPage()
    api.getGraphQueryApi.mockRejectedValue(new Error('net'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.fetchGraphVisualizationData(null, false, [], [])
    expect(wrapper.vm.graphData).toEqual({ entities: [], edges: [] })
    error.mockRestore()
  })

  it('refreshFromServer：purge 被删实体/关系后按原条件重查，sticky 重新累计', async () => {
    const wrapper = await mountPage()
    api.getGraphQueryApi.mockResolvedValue(queryResponse({
      entities: [['e1', 'Scene'], ['e2', 'Scene']],
      edges: [['r1', 'Relates', 'e1', 'e2'], ['r2', 'Relates', 'e2', 'e1']]
    }))
    await wrapper.vm.fetchGraphVisualizationData(null, false, [], [])
    expect(wrapper.vm.graphData.entities).toHaveLength(2)

    wrapper.vm.upsertStickyEnsureEntities([{ entity_id: 'e2', entity_type: 'Scene' }])
    // 重查：服务端只剩 e1/r1（删除已生效）；sticky 里的 e2 已被 purge，不会合并回来
    api.getGraphQueryApi
      .mockResolvedValueOnce(queryResponse({
        entities: [['e1', 'Scene']],
        edges: [['r1', 'Relates', 'e1', 'e2']]
      }))
    await wrapper.vm.handleRefreshGraphData({
      refreshFromServer: true,
      deletedEntityId: 'e2',
      deletedEdgeId: 'r2'
    })
    await flush()
    expect(wrapper.vm.graphData.entities.map(e => e.entity_id)).toEqual(['e1'])
    expect(wrapper.vm.graphData.edges.map(e => e.edge_id)).toEqual(['r1'])
    expect(wrapper.vm.stickyEnsureEntities).toHaveLength(0)
  })

  it('refreshFromServer 沿用手动查询条件，ensure 实体经 merge 直接进画布与 sticky', async () => {
    const wrapper = await mountPage()
    const payload = { queryType: 'entity', filters: [{ entity_type: ['Scene'] }] }
    await wrapper.vm.handleExecuteQuery(payload)
    api.getGraphQueryApi.mockClear()

    api.getGraphQueryApi
      .mockResolvedValueOnce(queryResponse({ entities: [['e9', 'Scene', '新增九']] }))
    await wrapper.vm.handleRefreshGraphData({
      refreshFromServer: true,
      ensureEntity: { entity_id: 'e8', entity_type: 'Scene' }
    })
    // 主查询沿用手动条件
    expect(api.getGraphQueryApi.mock.calls[0][4]).toBe('entity')
    expect(api.getGraphQueryApi.mock.calls[0][5]).toEqual(payload.filters)
    // ensure 清单经 merge 进画布与 sticky；补查发现已存在，不再发请求
    expect(wrapper.vm.graphData.entities.map(e => e.entity_id)).toEqual(expect.arrayContaining(['e8', 'e9']))
    expect(wrapper.vm.stickyEnsureEntities.map(e => e.entity_id)).toEqual(['e8'])
    expect(api.getGraphQueryApi).toHaveBeenCalledTimes(1)
  })

  it('ensureEntityIncludedByCustomQuery：已存在不出手；带属性时先属性后类型的两轮候选', async () => {
    const wrapper = await mountPage()
    api.getGraphQueryApi.mockClear()
    // 画布已有 e1（挂载期自动查询带入）
    wrapper.vm.ensureEntityIncludedByCustomQuery({ entity_id: 'e1', entity_type: 'Scene' })
    await flush()
    expect(api.getGraphQueryApi).not.toHaveBeenCalled()

    // 两轮候选都查不到 → 发两轮请求后放弃
    api.getGraphQueryApi.mockClear()
    api.getGraphQueryApi
      .mockResolvedValueOnce(queryResponse())
      .mockResolvedValueOnce(queryResponse())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await wrapper.vm.ensureEntityIncludedByCustomQuery({ entity_id: 'zz', entity_type: 'Scene', properties: { name: '甲' } })
    expect(api.getGraphQueryApi).toHaveBeenCalledTimes(2)
    expect(api.getGraphQueryApi.mock.calls[0][5][0].properties).toHaveProperty('name') // 属性过滤在前
    expect(api.getGraphQueryApi.mock.calls[1][5][0].properties).toEqual({}) // 类型兜底在后

    // 无有效属性（空白值）→ 只走类型兜底一轮
    api.getGraphQueryApi.mockClear()
    api.getGraphQueryApi
      .mockResolvedValueOnce(queryResponse())
    await wrapper.vm.ensureEntityIncludedByCustomQuery({ entity_id: 'zz2', entity_type: 'Scene', properties: { name: '  ' } })
    expect(api.getGraphQueryApi).toHaveBeenCalledTimes(1)
    expect(api.getGraphQueryApi.mock.calls[0][5]).toHaveLength(1)

    // 第一轮就查到：合并实体与其边，并把 limit 抬到补查下限（200）
    api.getGraphQueryApi.mockClear()
    api.getGraphQueryApi
      .mockResolvedValueOnce(queryResponse({
        entities: [['e5', 'Scene', '第五幕']],
        edges: [['r5', 'Relates', 'e1', 'e5']]
      }))
    await wrapper.vm.ensureEntityIncludedByCustomQuery({ entity_id: 'e5', entity_type: 'Scene', properties: { name: '五' } })
    expect(api.getGraphQueryApi).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.graphData.entities.some(e => e.entity_id === 'e5')).toBe(true)
    expect(wrapper.vm.graphData.edges.some(e => e.edge_id === 'r5')).toBe(true)
    // 补查请求用「不小于 200」的恢复下限；画布 3 个实体 < 50，limitValue 不动
    expect(api.getGraphQueryApi.mock.calls[0][1]).toBe(200)
    expect(wrapper.vm.limitValue).toBe(50)

    // 补查失败吞掉异常，画布不受影响
    api.getGraphQueryApi.mockClear()
    api.getGraphQueryApi.mockRejectedValue(new Error('x'))
    await expect(wrapper.vm.ensureEntityIncludedByCustomQuery({ entity_id: 'e6', entity_type: 'Scene' })).resolves.toBeUndefined()
    expect(wrapper.vm.graphData.entities.every(e => e.entity_id !== 'e6')).toBe(true)
    warn.mockRestore()
  })

})


describe('handleRefreshGraphData：loading / 增量 / 全量', () => {
  it('startLoading / stopLoading 闸门', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.handleRefreshGraphData({ startLoading: true })
    expect(wrapper.vm.graphLoading).toBe(true)
    await wrapper.vm.handleRefreshGraphData({ stopLoading: true })
    expect(wrapper.vm.graphLoading).toBe(false)
  })

  it('增量更新：added/updated 实体与关系就地合并，不整表替换', async () => {
    const wrapper = await mountPage()
    api.getGraphQueryApi.mockResolvedValue(queryResponse({ entities: [['e1', 'Scene']] }))
    await wrapper.vm.fetchGraphVisualizationData(null, false, [], [])

    await wrapper.vm.handleRefreshGraphData({
      incremental: true,
      entities: [], edges: [],
      addedEntities: [{ entity_id: 'e2', entity_type: 'Scene', entity_name: '乙', properties: {} }],
      updatedEntities: [{ entity_id: 'e1', entity_type: 'Scene', entity_name: '甲改', properties: {} }],
      addedEdges: [{ edge_id: 'r1', edge_type: 'Relates', source_id: 'e1', target_id: 'e2', properties: {} }]
    })
    const names = wrapper.vm.graphData.entities.map(e => e.entity_name)
    expect(names).toEqual(expect.arrayContaining(['甲改', '乙']))
    expect(wrapper.vm.graphData.edges).toHaveLength(1)
    expect(wrapper.vm.stickyEnsureEntities.map(e => e.entity_id).sort()).toEqual(['e1', 'e2'])
  })

  it('全量更新：整表替换 + 提示；schema 存在时同步可用类型但不重置选择', async () => {
    const wrapper = await mountPage()
    wrapper.vm.selectedEntityTypes = ['Scene']
    await wrapper.vm.handleRefreshGraphData({
      entities: [{ entity_id: 'e9', entity_type: 'Character', properties: {} }],
      edges: []
    })
    expect(wrapper.vm.graphData.entities).toHaveLength(1)
    expect(wrapper.vm.availableEntityTypes).toEqual(['Scene', 'Character'])
    expect(wrapper.vm.selectedEntityTypes).toEqual(['Scene'])
    expect(messageMock.success).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.entityUpdateSuccessGraphRefreshed'))
  })

  it('格式异常：只记日志，不清画布', async () => {
    const wrapper = await mountPage()
    const before = JSON.stringify(wrapper.vm.graphData)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await wrapper.vm.handleRefreshGraphData({ foo: 1 })
    expect(JSON.stringify(wrapper.vm.graphData)).toBe(before)
    warn.mockRestore()
  })

  it('purgeStickyByDeletedEdgeId / upsert 的去重与覆盖语义', async () => {
    const wrapper = await mountPage()
    wrapper.vm.upsertStickyEnsureEdges([
      { edge_id: 'r1', edge_type: 'Relates', source_id: 'a', target_id: 'b', properties: {} },
      { edge_id: 'r1', edge_type: 'Relates', source_id: 'a', target_id: 'b', properties: { k: 1 } },
      { edge_id: 'r2', edge_type: 'Relates', source_id: 'b', target_id: 'c', properties: {} }
    ])
    expect(wrapper.vm.stickyEnsureEdges).toHaveLength(2)
    expect(wrapper.vm.stickyEnsureEdges[0].properties).toEqual({ k: 1 })

    wrapper.vm.purgeStickyByDeletedEdgeId('r1')
    expect(wrapper.vm.stickyEnsureEdges.map(e => e.edge_id)).toEqual(['r2'])

    // 无效入参直接返回（不做任何过滤）
    wrapper.vm.upsertStickyEnsureEntities([{ entity_type: 'Scene' }])
    expect(wrapper.vm.stickyEnsureEntities).toHaveLength(0)
    wrapper.vm.purgeStickyByDeletedEntityId(undefined)
    wrapper.vm.purgeStickyByDeletedEdgeId('')
  })
})

describe('控制面板与基本信息页派生数据', () => {
  it('类型 / 上限 / 深度 / 查询类型 / 搜索框的变化处理（含非法 limit）', async () => {
    const wrapper = await mountPage()
    wrapper.vm.handleEntityTypeChange(['Scene'])
    wrapper.vm.handleEdgeTypeChange(['Relates'])
    expect(wrapper.vm.selectedEntityTypes).toEqual(['Scene'])
    expect(wrapper.vm.selectedEdgeTypes).toEqual(['Relates'])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wrapper.vm.handleLimitChange(null)
    wrapper.vm.handleLimitChange(Number.NaN)
    expect(wrapper.vm.limitValue).toBe(50)
    warn.mockRestore()
    wrapper.vm.handleLimitChange(200)
    expect(wrapper.vm.limitValue).toBe(200)
    wrapper.vm.handleDepthChange(3)
    expect(wrapper.vm.depthValue).toBe(3)

    wrapper.vm.handleQueryTypeChange('')
    expect(wrapper.vm.currentQueryType).toBe('entity')
    wrapper.vm.handleQueryTypeChange('relation')
    expect(wrapper.vm.currentQueryType).toBe('relation')

    wrapper.vm.handleSearchInput(' keyword ')
    expect(wrapper.vm.searchKeyword).toBe(' keyword ')
    wrapper.vm.handleSearchClear()
    expect(wrapper.vm.searchKeyword).toBe('')
  })

  it('文件搜索会回到第一页；filteredFiles / pageFiles / 体积合计', async () => {
    const wrapper = await mountPage()
    // 造 12 个文件，验证本地分页
    const files = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`, title: `文件${i}.pdf`, fileSize: 1024, fileFrom: '1', createdBy: 'x', createdDate: ''
    }))
    const detail = detailResponse()
    detail.fileInfo = files
    api.getKnowledgeGraphBasicInfoApi.mockResolvedValue(detail)
    await wrapper.vm.refreshSourceFiles()
    expect(wrapper.vm.filteredFiles).toHaveLength(12)
    expect(wrapper.vm.pageFiles).toHaveLength(10)

    wrapper.vm.fileSearch = '文件3'
    await flush()
    expect(wrapper.vm.filePage).toBe(1)
    expect(wrapper.vm.filteredFiles.map(f => f.name)).toEqual(['文件3.pdf'])
    wrapper.vm.fileSearch = ''
    await flush()

    expect(wrapper.vm.fileTotalBytes).toBe(12 * 1024)
  })

  it('formatFileSize 的五档输出', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.formatFileSize(0)).toBe('0 B')
    expect(wrapper.vm.formatFileSize(-5)).toBe('0 B')
    expect(wrapper.vm.formatFileSize(512)).toBe('512 B')
    expect(wrapper.vm.formatFileSize(1024)).toBe('1 KB')
    expect(wrapper.vm.formatFileSize(1024 * 1024)).toBe('1 MB')
    expect(wrapper.vm.formatFileSize(3 * 1024 ** 3)).toBe('3 GB')
  })

  it('算子名：中英文回退；算子缺失时如实显示 #id；列表加载失败不阻塞', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.graphOperatorName).toBe('通用抽取')

    wrapper.vm.$i18n.locale = 'en'
    expect(wrapper.vm.graphOperatorName).toBe('GeneralExtract')
    wrapper.vm.$i18n.locale = 'zh'

    wrapper.vm.detailData.operatorId = 99
    expect(wrapper.vm.graphOperatorName).toBe('#99')
    wrapper.vm.detailData.operatorId = ''
    expect(wrapper.vm.graphOperatorName).toBe('')

    api.getOperatorListApi.mockRejectedValue(new Error('x'))
    await wrapper.vm.loadOperatorList()
    expect(wrapper.vm.operatorList).toEqual([])
  })

  it('指标卡：stats 缺失时回落到当前画布数量', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.infoMetrics.map(m => m.value)).toEqual([120, 300, 2])
    wrapper.vm.graphStats = null
    expect(wrapper.vm.infoMetrics.map(m => m.value)).toEqual([
      wrapper.vm.graphData.entities.length,
      wrapper.vm.graphData.edges.length,
      2
    ])
    expect(wrapper.vm.graphIdentifier).toBe('graph_movie')
  })

  it('visibleEntityTypes：有数据只展示数据里出现的类型，无数据展示模版全部', async () => {
    const wrapper = await mountPage()
    wrapper.vm.graphData = { entities: [{ entity_id: 'e1', entity_type: 'Scene', properties: {} }], edges: [] }
    await flush()
    expect(wrapper.vm.visibleEntityTypes.map(t => t.name)).toEqual(['Scene'])
    expect(wrapper.vm.visibleEntityTypes[0].tone).toBeTruthy()

    wrapper.vm.graphData = { entities: [], edges: [] }
    await flush()
    expect(wrapper.vm.visibleEntityTypes.map(t => t.name)).toEqual(['Scene', 'Character'])
  })

  it('setTemplateInfo(null)：模版字段全部清空', async () => {
    const wrapper = await mountPage()
    wrapper.vm.setTemplateInfo(null)
    expect(wrapper.vm.detailData.templateName).toBe('')
    expect(wrapper.vm.detailData.schemaId).toBe('')
    expect(wrapper.vm.detailData.templateDescription).toBe('')
  })

  it('setBasicInfo：空值兜底为 -- / 空串', async () => {
    const wrapper = await mountPage()
    wrapper.vm.setBasicInfo({}, 'kb-x')
    expect(wrapper.vm.detailData.name).toBe('--')
    expect(wrapper.vm.detailData.operatorId).toBe('')
    expect(wrapper.vm.detailData.id).toBe('kb-x')
    expect(wrapper.vm.detailData.fileCount).toBe(0)
  })

  it('schema 非法：报错并中止类型提取', async () => {
    const wrapper = await mountPage()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wrapper.vm.availableEntityTypes = ['stale']
    wrapper.vm.extractEntityAndEdgeTypes({ edges: [] })
    expect(messageMock.error).toHaveBeenCalled()
    expect(wrapper.vm.availableEntityTypes).toEqual(['stale']) // 非法 schema 不动旧列表
    // 空入参直接返回
    wrapper.vm.updateAvailableTypesFromSchema(null)
    error.mockRestore()
    warn.mockRestore()
  })
})
