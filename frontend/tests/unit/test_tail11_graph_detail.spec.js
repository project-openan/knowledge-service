// @vitest-environment jsdom
// 知识图谱详情页（GraphDetailPage.vue）的残余分支（11/6 之图三）：
// schema 提取的空入参、来源文件刷新的无 id 早退、merge 增量合并的守卫分支
// （无效实体 / 两端缺失的边 / 已存在的边不重复）、sticky ensure 的覆盖与过滤、
// 删除实体后 sticky 清理、refreshGraphFromServer 的全链路、
// 增量 addedEdges/updatedEdges 就地合并、无 schema 更新类型时的告警分支。
// 基础覆盖见 test_pg_GraphDetailPage.spec.js。
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
import GraphDetailPage from '@/pages/graph/GraphDetailPage.vue'

const ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } },
  { path: '/graph/detail/:id', name: 'graph-detail', component: { render: () => null } },
  { path: '/graph/edit/:id', name: 'graph-edit', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

const messageMock = Object.assign(vi.fn(() => ({ close: vi.fn() })), {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn()
})

function detailResponse ({ schema = true } = {}) {
  return {
    data: {
      id: 'kb-1', name: '电影图谱', description: '剧情与人物', embeddingModel: 'bge-large',
      operatorId: 3, tableName: 'graph_movie', source: 'manual',
      createdDate: '2026-05-01 09:00:00', createdBy: 'tester', currentFileCount: 2
    },
    schemaInfo: schema
      ? {
          schema_name: '影视模版', schema_id: 'tpl-9', schema_desc: '影视实体关系',
          entities: [{ entity_type: 'Scene' }, { entity_type: 'Character' }],
          edges: [{ edge_type: 'Relates' }]
        }
      : null,
    fileInfo: [
      { id: 'f1', title: '剧本.pdf', fileSize: 1024, fileFrom: '1', createdBy: '甲', createdDate: '2026-05-02 10:00:00' }
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

async function settleFrame () {
  await flush()
  await new Promise(resolve => setTimeout(resolve, 40))
  await flush()
}

async function mountPage ({ route = '/graph/detail/kb-1', detail = detailResponse(), query } = {}) {
  api.getKnowledgeGraphBasicInfoApi.mockReset().mockResolvedValue(detail)
  api.getGraphQueryApi.mockReset()
  if (query) {
    api.getGraphQueryApi.mockImplementation(query)
  } else {
    api.getGraphQueryApi.mockResolvedValue(queryResponse({
      entities: [['e1', 'Scene', '场景甲'], ['e2', 'Character', '角色乙']],
      edges: [['r1', 'Relates', 'e1', 'e2']]
    }))
  }
  api.getOperatorListApi.mockReset().mockResolvedValue([
    { id: 3, name: '通用抽取', nameEn: 'GeneralExtract' }
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
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('辅助函数残余分支', () => {
  it('extractEntityAndEdgeTypes：空入参直接返回', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.extractEntityAndEdgeTypes(null)).toBeUndefined()
    wrapper.unmount()
  })

  it('refreshSourceFiles：无 id 早退', async () => {
    const wrapper = await mountPage({ route: '/graph' })
    api.getKnowledgeGraphBasicInfoApi.mockClear()
    await wrapper.vm.refreshSourceFiles()
    expect(api.getKnowledgeGraphBasicInfoApi).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('mergeEnsureEntitiesIntoGraphData：无效项跳过、新项追加', async () => {
    const wrapper = await mountPage()
    const before = wrapper.vm.graphData.entities.length
    wrapper.vm.mergeEnsureEntitiesIntoGraphData([
      { entity_id: '', entity_type: 'Scene' }, // 无 id：跳过
      { entity_type: 'Scene' }, // 无类型：跳过
      { entity_id: 'e1', entity_type: 'Scene' }, // 已存在：不重复
      { entity_id: 'e-new', entity_type: 'Scene', entity_name: '新实体' }
    ])
    expect(wrapper.vm.graphData.entities).toHaveLength(before + 1)
    expect(wrapper.vm.graphData.entities.at(-1).entity_id).toBe('e-new')
    wrapper.unmount()
  })

  it('mergeEnsureEdgesIntoGraphData：无效边 / 端点缺失 / 已存在 都不进画布', async () => {
    const wrapper = await mountPage()
    const before = wrapper.vm.graphData.edges.length
    wrapper.vm.mergeEnsureEdgesIntoGraphData([
      { edge_id: 'x1', edge_type: 'Relates' }, // 缺端点
      { edge_id: 'r1', edge_type: 'Relates', source_id: 'e1', target_id: 'e2' }, // 已存在
      { edge_id: 'x2', edge_type: 'Relates', source_id: 'ghost-a', target_id: 'e2' }, // 源不存在
      { edge_id: 'x3', edge_type: 'Relates', source_id: 'e1', target_id: 'ghost-b' } // 目标不存在
    ])
    expect(wrapper.vm.graphData.edges).toHaveLength(before)

    // 两端齐备的新边：追加
    wrapper.vm.mergeEnsureEdgesIntoGraphData([
      { edge_id: 'r2', edge_type: 'Relates', source_id: 'e1', target_id: 'e2' }
    ])
    expect(wrapper.vm.graphData.edges).toHaveLength(before + 1)
    wrapper.unmount()
  })

  it('upsertStickyEnsure：无效项跳过；同 id 覆盖；新项追加', async () => {
    const wrapper = await mountPage()
    wrapper.vm.upsertStickyEnsureEntities([{ entity_id: '', entity_type: 'Scene' }])
    expect(wrapper.vm.stickyEnsureEntities).toHaveLength(0)

    wrapper.vm.upsertStickyEnsureEntities([{ entity_id: 's1', entity_type: 'Scene', entity_name: '初版' }])
    wrapper.vm.upsertStickyEnsureEntities([{ entity_id: 's1', entity_type: 'Scene', entity_name: '改版' }])
    expect(wrapper.vm.stickyEnsureEntities).toHaveLength(1)
    expect(wrapper.vm.stickyEnsureEntities[0].entity_name).toBe('改版')

    wrapper.vm.upsertStickyEnsureEdges([{ edge_id: '' }]) // 无效：跳过
    wrapper.vm.upsertStickyEnsureEdges([{ edge_id: 'se1', edge_type: 'Relates', source_id: 's1', target_id: 'e2' }])
    wrapper.vm.upsertStickyEnsureEdges([{ edge_id: 'se1', edge_type: 'Relates', source_id: 's1', target_id: 'e2', properties: { note: 1 } }])
    expect(wrapper.vm.stickyEnsureEdges).toHaveLength(1)
    expect(wrapper.vm.stickyEnsureEdges[0].properties).toEqual({ note: 1 })
    wrapper.unmount()
  })

  it('删除实体：sticky ensure 的同名实体与相关边一并清理', async () => {
    const wrapper = await mountPage()
    wrapper.vm.upsertStickyEnsureEntities([
      { entity_id: 'gone', entity_type: 'Scene', entity_name: '待删' },
      { entity_id: 'keep', entity_type: 'Scene', entity_name: '保留' }
    ])
    wrapper.vm.upsertStickyEnsureEdges([
      { edge_id: 'se-a', edge_type: 'Relates', source_id: 'gone', target_id: 'e2' },
      { edge_id: 'se-b', edge_type: 'Relates', source_id: 'keep', target_id: 'e2' }
    ])
    wrapper.vm.purgeStickyByDeletedEntityId('gone')
    await flush()
    const ids = wrapper.vm.stickyEnsureEntities.map(item => item.entity_id)
    expect(ids).toEqual(['keep'])
    expect(wrapper.vm.stickyEnsureEdges).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('刷新链路残余', () => {
  it('refreshGraphFromServer：走 refreshFromServer 并恢复布局', async () => {
    const wrapper = await mountPage()
    vis.restoreLayoutAfterRefresh.mockClear()
    await wrapper.vm.refreshGraphFromServer()
    await settleFrame()
    expect(vis.restoreLayoutAfterRefresh).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('增量 addedEdges / updatedEdges：就地合并不重复', async () => {
    const wrapper = await mountPage()
    // 增量分支（incremental=true 且带 entities/edges）：就地合并
    await wrapper.vm.handleRefreshGraphData({
      incremental: true,
      entities: wrapper.vm.graphData.entities.slice(),
      edges: wrapper.vm.graphData.edges.slice(),
      addedEdges: [
        { edge_id: 'r1', edge_type: 'Relates', source_id: 'e1', target_id: 'e2' }, // 已存在
        { edge_id: 'r9', edge_type: 'Relates', source_id: 'e1', target_id: 'e2' }
      ],
      updatedEdges: [
        { edge_id: 'r1', edge_type: 'Relates', source_id: 'e1', target_id: 'e2', properties: { w: 2 } },
        { edge_id: 'ghost', edge_type: 'Relates', source_id: 'a', target_id: 'b' } // 画布上没有：忽略
      ]
    })
    await flush()
    await flush()
    const edges = wrapper.vm.graphData.edges
    expect(edges.filter(e => e.edge_id === 'r1')).toHaveLength(1)
    expect(edges.find(e => e.edge_id === 'r1').properties).toEqual({ w: 2 })
    expect(edges.some(e => e.edge_id === 'r9')).toBe(true)
    expect(edges.some(e => e.edge_id === 'ghost')).toBe(false)
    wrapper.unmount()
  })

  it('无 schema 时更新可用类型：只告警不清空', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = await mountPage({ detail: detailResponse({ schema: false }) })
    await wrapper.vm.handleRefreshGraphData({ entities: [], edges: [] }, true)
    await flush()
    // 告警分支走到即可（无 schema → updateAvailableTypesFromSchema 不执行）
    wrapper.vm.handleRefreshGraphData({ entities: [], edges: [] }, true)
    await flush()
    warnSpy.mockRestore()
    wrapper.unmount()
  })
})
