// @vitest-environment jsdom
/**
 * GraphList.vue（图谱知识库 · 图谱列表，1595 行的最大残余）—— script 逻辑专项：
 * - 取数：getTableDataApi 的两条路（直查 / 状态筛选取全量后本地过滤 + 排序 + 分页）、
 *   extractRows 的五种响应形态、refreshList 的页码收敛、指标卡聚合与失败静默；
 * - 勾选：单行/全选/跨页同步/清空；自动刷新闸门：页面可见 + 有构建中行才打点；
 * - 导入 ZIP 全流程：desc.json 缺失/坏 JSON/无 id 直导/有 id 查存在性 →
 *   选择框（取消 / 增量 / 全量覆盖=先删后导）/ 目标不存在直导；
 * - 删除：单条确认删除、批量（按状态放行 + 跳过提示 + allSettled 计数）；
 * - 导出（blob 校验）、新建弹窗（连点闸门）、模板包下载、状态文案与时间格式化。
 *
 * knowledge-base 出口只把 CreateKnowledgeDialog 换成桩（状态目录用真实现），
 * JSZip / 传输 lib / 删除确认 / 四个共享 UI 件为替身。
 */
import { vi } from 'vitest'
import { ref } from 'vue'

const { api, transfer, quickCreate, deletionMock, zipMock, uiStubs } = vi.hoisted(() => ({
  api: {
    knowledgeGraphListApi: vi.fn(),
    knowledgeBaseStatsApi: vi.fn(),
    deleteKnowledgeGraphApi: vi.fn(),
    importKnowledgeGraphApi: vi.fn(),
    getKnowledgeGraphBasicInfoApi: vi.fn(),
    exportGraphKnowledgeBaseApi: vi.fn()
  },
  transfer: {
    downloadStaticTemplateZip: vi.fn(),
    localizedTemplateFileName: vi.fn((locale, names) => names[locale] || names.zh),
    saveBlobAsFile: vi.fn()
  },
  quickCreate: { loadGraphCreateOptions: vi.fn() },
  deletionMock: { requestDeletion: vi.fn() },
  zipMock: { loadAsyncImpl: vi.fn() },
  uiStubs: { createOptions: vi.fn() }
}))

vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  knowledgeGraphListApi: (...args) => api.knowledgeGraphListApi(...args),
  knowledgeBaseStatsApi: (...args) => api.knowledgeBaseStatsApi(...args),
  deleteKnowledgeGraphApi: (...args) => api.deleteKnowledgeGraphApi(...args),
  importKnowledgeGraphApi: (...args) => api.importKnowledgeGraphApi(...args),
  getKnowledgeGraphBasicInfoApi: (...args) => api.getKnowledgeGraphBasicInfoApi(...args),
  exportGraphKnowledgeBaseApi: (...args) => api.exportGraphKnowledgeBaseApi(...args)
}))
vi.mock('@/features/graph/lib/graphTransfer', () => ({
  downloadStaticTemplateZip: (...args) => transfer.downloadStaticTemplateZip(...args),
  localizedTemplateFileName: (...args) => transfer.localizedTemplateFileName(...args),
  saveBlobAsFile: (...args) => transfer.saveBlobAsFile(...args)
}))
vi.mock('@/features/graph/lib/graph-quick-create', () => ({
  loadGraphCreateOptions: (...args) => quickCreate.loadGraphCreateOptions(...args)
}))
vi.mock('@/shared/composables/deletion', async importOriginal => ({
  ...await importOriginal(),
  requestDeletion: (...args) => deletionMock.requestDeletion(...args)
}))
vi.mock('jszip', () => ({
  default: class { loadAsync (...args) { return zipMock.loadAsyncImpl(...args) } }
}))

// knowledge-base 出口：保留真状态目录/指标整形，只换掉弹窗组件（拉 Element Plus 表单太重）
vi.mock('@/features/knowledge-base/api', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    CreateKnowledgeDialog: { name: 'CreateKnowledgeDialogStub', props: ['open', 'models', 'existingNames', 'limits'], emits: ['created', 'close'], render: () => null }
  }
})

// 共享 UI 件：与断言无关的展示件换哑件，避免拖入 EP 表格
vi.mock('@/shared/ui/reference/MetricCard.vue', () => ({ default: { name: 'MetricCardStub', props: ['label', 'value', 'tone', 'hint'], render: () => null } }))
vi.mock('@/shared/ui/reference/TablePagination.vue', () => ({ default: { name: 'TablePaginationStub', props: ['total', 'page', 'size'], emits: ['change'], render: () => null } }))
vi.mock('@/shared/ui/reference/TableRefreshButton.vue', () => ({ default: { name: 'TableRefreshStub', emits: ['refresh'], render: () => null } }))
vi.mock('@/shared/ui/ListSelectionBar.vue', () => ({ default: { name: 'ListSelectionBarStub', props: ['count'], emits: ['remove', 'clear'], render: () => null } }))

import { describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElMessageBox } from 'element-plus'
import GraphList from '@/features/graph/GraphList.vue'

const closeMock = vi.fn()
const messageMock = Object.assign(vi.fn(() => ({ close: closeMock })), {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn()
})
const loadingMock = vi.fn(() => ({ close: closeMock }))

const ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } },
  { path: '/graph/detail/:id', name: 'graph-detail', component: { render: () => null } },
  { path: '/graph/edit/:id', name: 'graph-edit', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

/** 列表行：status 覆盖 已创建0 / 构建1-4 / 就绪5 / 失败101 */
function listRows () {
  return [
    { id: 'kb1', name: '图谱一', status: 1, currentFileCount: 2, createdDate: '2026-06-01 08:30:00', description: 'd1' },
    { id: 'kb2', name: '图谱二', status: 3, currentFileCount: 0, createdDate: '', description: '' },
    { id: 'kb3', name: '图谱三', status: 5, currentFileCount: 9, createdDate: '2026-06-02 10:00:00', description: 'd3' },
    { id: 'kb4', name: '图谱四', status: 101, currentFileCount: 0, createdDate: 'bad-date', description: 'd4' }
  ]
}

async function mountList ({ rows = listRows(), stats = { categories: [{ category: 10, total: 4, fileTotal: 11, statusCounts: { 0: 1, 1: 1, 5: 1, 101: 1 } }] } } = {}) {
  api.knowledgeGraphListApi.mockReset().mockResolvedValue({ items: rows, total: rows.length })
  api.knowledgeBaseStatsApi.mockReset().mockResolvedValue(stats)
  api.deleteKnowledgeGraphApi.mockReset().mockResolvedValue({})
  api.importKnowledgeGraphApi.mockReset().mockResolvedValue({})
  api.getKnowledgeGraphBasicInfoApi.mockReset().mockResolvedValue({})
  api.exportGraphKnowledgeBaseApi.mockReset().mockResolvedValue(new Blob(['zip']))
  quickCreate.loadGraphCreateOptions.mockReset().mockResolvedValue({
    models: [{ name: 'bge-large' }],
    existingNames: ['图谱一'],
    limits: { maxSizeMap: { pdf: 10 }, number: 5, totalSize: 100 }
  })
  deletionMock.requestDeletion.mockReset().mockResolvedValue(true)
  transfer.downloadStaticTemplateZip.mockReset().mockResolvedValue(undefined)
  transfer.saveBlobAsFile.mockReset()
  zipMock.loadAsyncImpl.mockReset()

  const outerTab = ref('knowledgeGraph')
  const subTab = ref('knowledgeGraph')

  const wrapper = await mountWithPlugins(GraphList, {
    route: '/graph',
    routes: ROUTES,
    global: {
      provide: { kbaseActiveTab: outerTab, activeTabName: subTab },
      config: { globalProperties: { $message: messageMock, $loading: loadingMock } }
    }
  })
  await flush()
  return { wrapper, outerTab, subTab }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('取数：直查 / 状态筛选 / 响应形态', () => {
  it('默认直查：请求带 categories=10 + 当前关键词，返回 items/total', async () => {
    const { wrapper } = await mountList()
    expect(wrapper.vm.rows).toHaveLength(4)
    expect(wrapper.vm.total).toBe(4)
    const req = api.knowledgeGraphListApi.mock.calls[0][0]
    expect(req.categories).toEqual([10])
    expect(req.keyword).toBe('')
  })

  it('extractRows 吃五种响应形态，其余回空数组', async () => {
    const { wrapper } = await mountList()
    expect(wrapper.vm.extractRows(null)).toEqual([])
    expect(wrapper.vm.extractRows([{ id: 1 }])).toEqual([{ id: 1 }])
    expect(wrapper.vm.extractRows({ data: [{ id: 2 }] })).toEqual([{ id: 2 }])
    expect(wrapper.vm.extractRows({ data: { data: [{ id: 3 }] } })).toEqual([{ id: 3 }])
    expect(wrapper.vm.extractRows({ items: [{ id: 4 }] })).toEqual([{ id: 4 }])
    expect(wrapper.vm.extractRows({ data: { items: [{ id: 5 }] } })).toEqual([{ id: 5 }])
    expect(wrapper.vm.extractRows({ nope: 1 })).toEqual([])
  })

  it('状态筛选：取全量（pageSize=500）→ 本地过滤 → 排序 → 本地分页', async () => {
    const { wrapper } = await mountList()
    api.knowledgeGraphListApi.mockClear()
    wrapper.vm.setStatusFilter('ready') // 5=就绪
    await flush()

    const req = api.knowledgeGraphListApi.mock.calls[0][0]
    expect(req.pageSize).toBe(500)
    expect(req.currentPage).toBe(1)
    expect(wrapper.vm.rows.map(r => r.id)).toEqual(['kb3'])
    expect(wrapper.vm.total).toBe(1)
    expect(wrapper.vm.selectedMap.size).toBe(0) // 切筛选清勾选

    // 排序 + 分页：orderList 里带 key/ascending
    wrapper.vm.refreshTableData([{ key: 'name', ascending: 'desc' }])
    await flush()
    expect(wrapper.vm.orderList).toEqual([{ key: 'name', ascending: 'desc' }])
    // 第一页 2 条（4 行过滤后只有 kb3？——全部状态码不在 ready 桶的被滤掉）
  })

  it('processing 桶：构建中四阶段都命中，并可按列排序', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.setStatusFilter('processing') // 1 / 3 都在「处理中」桶
    await flush()
    expect(wrapper.vm.total).toBe(2)
    expect(wrapper.vm.rows.map(r => r.id)).toEqual(['kb1', 'kb2'])

    // 过滤结果再按名称降序
    wrapper.vm.refreshTableData([{ key: 'name', ascending: 'desc' }])
    await flush()
    expect(wrapper.vm.orderList).toEqual([{ key: 'name', ascending: 'desc' }])
    expect(wrapper.vm.rows.map(r => r.name)).toEqual(['图谱二', '图谱一'])
  })

  it('列表接口失败：抛给刷新逻辑（后台刷新不清表）', async () => {
    const { wrapper } = await mountList()
    api.knowledgeGraphListApi.mockRejectedValue(new Error('net'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(wrapper.vm.getTableDataApi({ currentPage: 1, pageSize: 10 })).rejects.toThrow('net')
    await expect(wrapper.vm.loadRows()).resolves.toBe(false)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('refreshList：删除末页数据后页码收敛并重取', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.currentPage = 1
    wrapper.vm.total = 4
    wrapper.vm.pageSize = 10
    await wrapper.vm.refreshAfterMutation(4) // 全删光 → maxPage=1
    expect(wrapper.vm.currentPage).toBe(1)
    expect(api.knowledgeGraphListApi).toHaveBeenCalled()
  })

  it('loadOverviewStats：聚合字段整形 + 平均文档数；失败保持 0', async () => {
    const { wrapper } = await mountList({ stats: { categories: [{ category: 10, total: 4, fileTotal: 0, statusCounts: { 5: 4 } }] } })
    expect(wrapper.vm.overview.graphTotal).toBe(4)
    expect(wrapper.vm.readyPercent).toBe('100%')
    expect(wrapper.vm.overview.ready).toBe(4)

    api.knowledgeBaseStatsApi.mockRejectedValue(new Error('x'))
    await wrapper.vm.loadOverviewStats()
    expect(wrapper.vm.overview.graphTotal).toBe(4) // 失败保持旧值

    wrapper.vm.overview.graphTotal = 0
    expect(wrapper.vm.readyPercent).toBe('0%')
  })

  it('搜索：立即刷新 + 清勾选；输入中只标记不打请求', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.toggleRow(wrapper.vm.rows[0], true)
    expect(wrapper.vm.selectedMap.size).toBe(1)

    api.knowledgeGraphListApi.mockClear()
    wrapper.vm.handleSearchInput()
    expect(wrapper.vm.isUserTyping).toBe(true)

    wrapper.vm.searchKey = '图谱三'
    wrapper.vm.search()
    await flush()
    expect(wrapper.vm.isUserTyping).toBe(false)
    expect(wrapper.vm.selectedMap.size).toBe(0) // 搜索清勾选
    expect(api.knowledgeGraphListApi.mock.calls.at(-1)[0].keyword).toBe('图谱三') // 关键词发给后端
  })
})

describe('勾选与自动刷新闸门', () => {
  it('toggleRow / toggleAll / syncSelectedRows / allSelected', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.toggleAll(true)
    expect(wrapper.vm.selectedMap.size).toBe(4)
    expect(wrapper.vm.allSelected).toBe(true)

    wrapper.vm.toggleRow(wrapper.vm.rows[0], false)
    expect(wrapper.vm.allSelected).toBe(false)
    expect(wrapper.vm.selectedRows).toHaveLength(3)

    // 跨页同步：新数据里被勾选的行刷新为最新字段
    const fresh = listRows().map(r => ({ ...r, currentFileCount: 99 }))
    wrapper.vm.syncSelectedRows(fresh)
    expect(wrapper.vm.selectedRows[0].currentFileCount).toBe(99)

    // 无 id 的行不入勾选
    wrapper.vm.toggleRow({ name: 'no-id' }, true)
    expect(wrapper.vm.selectedMap.size).toBe(3)
    wrapper.vm.clearSelection()
    expect(wrapper.vm.selectedMap.size).toBe(0)
  })

  it('hasBuildingGraphRows / isSurfaceVisible 的闸门组合', async () => {
    const { wrapper, outerTab, subTab } = await mountList()
    expect(wrapper.vm.hasBuildingGraphRows()).toBe(true) // kb2 status=1

    wrapper.vm.rows = [{ id: 'kb9', status: 5 }]
    expect(wrapper.vm.hasBuildingGraphRows()).toBe(false)

    expect(wrapper.vm.isSurfaceVisible()).toBe(true)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    expect(wrapper.vm.isSurfaceVisible()).toBe(false)
    hidden.mockRestore()

    outerTab.value = 'doc'
    expect(wrapper.vm.isSurfaceVisible()).toBe(false)
    outerTab.value = 'knowledgeGraph'
    subTab.value = 'knowledgeGraphTemplate'
    expect(wrapper.vm.isSurfaceVisible()).toBe(false)
    subTab.value = 'knowledgeGraph'
    expect(wrapper.vm.isSurfaceVisible()).toBe(true)
  })
})

describe('ZIP 导入全流程', () => {
  function zipWithDesc (descContent, files = { 'desc.json': true }) {
    const entries = {}
    Object.keys(files).forEach(name => {
      entries[name] = { async: async () => (name === 'desc.json' ? descContent : 'binary') }
    })
    return { files: entries }
  }

  it('缺 desc.json / 坏 JSON：抛错并提示', async () => {
    const { wrapper } = await mountList()
    zipMock.loadAsyncImpl.mockResolvedValue({ files: {} })
    const loading = { close: closeMock }
    await expect(wrapper.vm.processImportFile(new File(['x'], 'a.zip'))).rejects.toThrow(
      wrapper.vm.$t('modules.kb.missingDescJson')
    )
    expect(closeMock).toHaveBeenCalled() // loading 被关闭

    zipMock.loadAsyncImpl.mockResolvedValue(zipWithDesc('{broken'))
    await expect(wrapper.vm.processImportFile(new File(['x'], 'a.zip'))).rejects.toThrow(
      wrapper.vm.$t('modules.kb.invalidDescJsonFormat')
    )
  })

  it('desc.json 无 id：不查存在性，直接导入', async () => {
    const { wrapper } = await mountList()
    zipMock.loadAsyncImpl.mockResolvedValue(zipWithDesc(JSON.stringify({ name: '无id' })))
    await wrapper.vm.processImportFile(new File(['x'], 'a.zip'))
    expect(api.getKnowledgeGraphBasicInfoApi).not.toHaveBeenCalled()
    expect(api.importKnowledgeGraphApi).toHaveBeenCalledTimes(1)
    expect(messageMock.success).toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled()
  })

  it('desc.json 有 id（带 graph_ 前缀）且库不存在：直接导入', async () => {
    const { wrapper } = await mountList()
    zipMock.loadAsyncImpl.mockResolvedValue(zipWithDesc(JSON.stringify({ id: 'graph_kb9' })))
    api.getKnowledgeGraphBasicInfoApi.mockRejectedValue(new Error('不存在'))
    await wrapper.vm.processImportFile(new File(['x'], 'a.zip'))
    expect(api.getKnowledgeGraphBasicInfoApi).toHaveBeenCalledWith('kb9') // 前缀被剥掉
    expect(api.importKnowledgeGraphApi).toHaveBeenCalledTimes(1)
    expect(api.deleteKnowledgeGraphApi).not.toHaveBeenCalled()
  })

  it('库已存在：弹选择框——取消什么都不做', async () => {
    const { wrapper } = await mountList()
    zipMock.loadAsyncImpl.mockResolvedValue(zipWithDesc(JSON.stringify({ id: 'kb1' })))
    const promise = wrapper.vm.processImportFile(new File(['x'], 'a.zip'))
    await flush()
    expect(wrapper.vm.importChoiceDialogVisible).toBe(true)
    wrapper.vm.handleImportChoiceCancel()
    await promise
    expect(wrapper.vm.importChoiceDialogVisible).toBe(false)
    expect(api.importKnowledgeGraphApi).not.toHaveBeenCalled()
    expect(api.deleteKnowledgeGraphApi).not.toHaveBeenCalled()
  })

  it('库已存在：选「增量更新」直接导；选「全量覆盖」先删后导', async () => {
    const { wrapper } = await mountList()
    zipMock.loadAsyncImpl.mockResolvedValue(zipWithDesc(JSON.stringify({ id: 'kb1' })))

    // 增量：重置默认值 update
    const p1 = wrapper.vm.processImportFile(new File(['x'], 'a.zip'))
    await flush()
    wrapper.vm.handleImportChoiceConfirm() // importChoiceValue 默认 'update'
    await p1
    expect(api.importKnowledgeGraphApi).toHaveBeenCalledTimes(1)
    expect(api.deleteKnowledgeGraphApi).not.toHaveBeenCalled()

    // 覆盖：先删现有库再导入
    const p2 = wrapper.vm.processImportFile(new File(['x'], 'a.zip'))
    await flush()
    wrapper.vm.importChoiceValue = 'overwrite'
    wrapper.vm.handleImportChoiceConfirm()
    await p2
    expect(api.deleteKnowledgeGraphApi).toHaveBeenCalledWith('kb1')
    expect(api.importKnowledgeGraphApi).toHaveBeenCalledTimes(2)
    expect(closeMock).toHaveBeenCalled()
  })

  it('覆盖导入失败：关闭 loading 并提示（带后端 detail/message 兜底）', async () => {
    const { wrapper } = await mountList()
    api.deleteKnowledgeGraphApi.mockRejectedValue(Object.assign(new Error('冲突'), { detail: 'D' }))
    zipMock.loadAsyncImpl.mockResolvedValue(zipWithDesc(JSON.stringify({ id: 'kb1' })))
    const promise = wrapper.vm.processImportFile(new File(['x'], 'a.zip'))
    await flush()
    wrapper.vm.importChoiceValue = 'overwrite'
    wrapper.vm.handleImportChoiceConfirm()
    await promise
    expect(messageMock.error).toHaveBeenCalledWith(expect.stringContaining('D'))
    expect(closeMock).toHaveBeenCalled()
  })

  it('导入接口本身失败：静默（拦截器已提示），loading 与输入框复位', async () => {
    const { wrapper } = await mountList()
    api.importKnowledgeGraphApi.mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const input = wrapper.find('input[type="file"]')
    await wrapper.vm.importKnowledgeGraphFile(new File(['x'], 'a.zip'), null)
    expect(error).toHaveBeenCalled()
    expect(input.element.value).toBe('')
    expect(closeMock).toHaveBeenCalled()
    error.mockRestore()
  })

  it('文件选择入口：非 zip / 超大拒绝；合法则走解析流程', async () => {
    const { wrapper } = await mountList()
    await wrapper.vm.onImportFileChange({ target: { files: [] } })
    expect(zipMock.loadAsyncImpl).not.toHaveBeenCalled()

    await wrapper.vm.onImportFileChange({ target: { files: [{ name: 'a.rar', size: 1 }] } })
    expect(messageMock.error).toHaveBeenCalledTimes(1)

    await wrapper.vm.onImportFileChange({ target: { files: [{ name: 'a.zip', size: 600 * 1024 * 1024 }] } })
    expect(zipMock.loadAsyncImpl).not.toHaveBeenCalled()

    zipMock.loadAsyncImpl.mockResolvedValue({ files: {} })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.onImportFileChange({ target: { files: [{ name: 'a.zip', size: 1 }] } })
    expect(zipMock.loadAsyncImpl).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})

describe('删除：单条与批量', () => {
  it('单条：确认后删 + 清勾选 + 提示 + 刷新；取消不动', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.toggleRow(wrapper.vm.rows[0], true)

    deletionMock.requestDeletion.mockResolvedValue(false)
    await wrapper.vm.deleteKnowledgeGraphHandle(wrapper.vm.rows[0])
    expect(api.deleteKnowledgeGraphApi).not.toHaveBeenCalled()

    deletionMock.requestDeletion.mockResolvedValue(true)
    await wrapper.vm.deleteKnowledgeGraphHandle(wrapper.vm.rows[0])
    expect(api.deleteKnowledgeGraphApi).toHaveBeenCalledWith('kb1')
    expect(wrapper.vm.selectedMap.has('kb1')).toBe(false)
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('批量：空勾选拦截；全可删汇总；未确认不发起请求', async () => {
    const { wrapper } = await mountList()
    // 图谱页的删除放行规则恒为 true（isGraphDeleteEnabled）→ “拦截”只发生在空勾选
    await wrapper.vm.removeSelectedGraphs()
    expect(messageMock.warning).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.deleteGraphBlocked'))
    expect(api.deleteKnowledgeGraphApi).not.toHaveBeenCalled()

    wrapper.vm.toggleAll(true)
    await wrapper.vm.removeSelectedGraphs()
    expect(api.deleteKnowledgeGraphApi).toHaveBeenCalledTimes(4)
    expect(messageMock.success).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.deleteGraphBatchSuccess', { count: 4 }))
    expect(wrapper.vm.selectedMap.size).toBe(0)

    // 未确认（取消删除弹窗）：不发起任何请求
    wrapper.vm.toggleAll(true)
    deletionMock.requestDeletion.mockResolvedValue(false)
    await wrapper.vm.removeSelectedGraphs()
    expect(api.deleteKnowledgeGraphApi).toHaveBeenCalledTimes(4)
  })

  it('批量删除部分失败：只清成功的勾选，提示失败数', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.toggleRow(wrapper.vm.rows[0], true)
    wrapper.vm.toggleRow(wrapper.vm.rows[2], true)
    api.deleteKnowledgeGraphApi.mockRejectedValueOnce(new Error('409')) // kb1 失败，kb3 成功
    await wrapper.vm.removeSelectedGraphs()
    expect(messageMock.success).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.deleteGraphBatchSuccess', { count: 1 }))
    expect(wrapper.vm.selectedMap.has('kb1')).toBe(true) // 失败的保留勾选
    expect(wrapper.vm.selectedMap.has('kb3')).toBe(false) // 成功的移出勾选
  })
})

describe('导出 / 新建 / 下载 / 路由跳转', () => {
  it('导出：blob 直接落盘 graph_{id}_{ts}.zip；非 blob 抛「导出失败」', async () => {
    const { wrapper } = await mountList()
    await wrapper.vm.handleExportGraph(wrapper.vm.rows[0])
    expect(transfer.saveBlobAsFile).toHaveBeenCalledWith(expect.any(Blob), expect.stringContaining('graph_kb1_'))
    expect(messageMock.success).toHaveBeenCalled()

    api.exportGraphKnowledgeBaseApi.mockResolvedValue({ data: new Blob(['inner']) })
    await wrapper.vm.handleExportGraph(wrapper.vm.rows[0])
    expect(transfer.saveBlobAsFile).toHaveBeenCalledTimes(2)

    api.exportGraphKnowledgeBaseApi.mockResolvedValue({ nope: 1 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.handleExportGraph(wrapper.vm.rows[0])
    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.exportGraphFailed'))
    error.mockRestore()
  })

  it('新建：取选项期间连点被闸门拦下；就绪后打开弹窗；建好提示并双刷新', async () => {
    const { wrapper } = await mountList()
    quickCreate.loadGraphCreateOptions.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ models: [], existingNames: [], limits: {} }), 20)))
    const p1 = wrapper.vm.handleCreateKnowledgeGraph()
    const p2 = wrapper.vm.handleCreateKnowledgeGraph() // 连点
    await flush()
    await p1
    await p2
    expect(quickCreate.loadGraphCreateOptions).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.createOpen).toBe(true)
    expect(wrapper.vm.createModels).toEqual([])

    api.knowledgeGraphListApi.mockClear()
    wrapper.vm.handleGraphCreated()
    await flush()
    expect(messageMock.success).toHaveBeenCalled()
    expect(api.knowledgeGraphListApi).toHaveBeenCalled()
    expect(api.knowledgeBaseStatsApi).toHaveBeenCalled()
  })

  it('下载模板包：按语言选文件；失败提示', async () => {
    const { wrapper } = await mountList()
    await wrapper.vm.handleDownloadTemplate()
    expect(transfer.downloadStaticTemplateZip).toHaveBeenCalledWith('import_graph_template_ZH.zip')
    expect(transfer.localizedTemplateFileName).toHaveBeenCalledWith('zh', expect.any(Object))

    transfer.downloadStaticTemplateZip.mockRejectedValue(new Error('404'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.handleDownloadTemplate()
    expect(messageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    error.mockRestore()
  })

  it('导入按钮：触发隐藏 input；名称/修改跳详情与编辑页', async () => {
    const { wrapper } = await mountList()
    const input = wrapper.find('input[type="file"]')
    const clickSpy = vi.spyOn(input.element, 'click').mockImplementation(() => {})
    wrapper.vm.handleImportKnowledgeGraph()
    expect(clickSpy).toHaveBeenCalled()

    wrapper.vm.handleNameClick(wrapper.vm.rows[0])
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('graph-detail')
    expect(wrapper.router.currentRoute.value.params.id).toBe('kb1')

    wrapper.vm.handleModify(wrapper.vm.rows[1])
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('graph-edit')
  })

  it('更多面板：docs 弹说明；pipeline / monitor 切面板；模板命令走下载', async () => {
    const alertSpy = vi.spyOn(ElMessageBox, 'alert').mockResolvedValue('ok')
    const { wrapper } = await mountList()

    wrapper.vm.openPanel('docs')
    expect(alertSpy).toHaveBeenCalledTimes(1)

    wrapper.vm.openPanel('monitor')
    expect(wrapper.vm.panelOpen).toBe(true)
    expect(wrapper.vm.panel).toBe('monitor')
    expect(wrapper.vm.monitoring).toHaveLength(4)

    wrapper.vm.openPanel('pipeline')
    expect(wrapper.vm.panel).toBe('pipeline')

    wrapper.vm.handleTemplateCommand('download')
    expect(transfer.downloadStaticTemplateZip).toHaveBeenCalled()
    wrapper.vm.handleTemplateCommand('other')
    expect(transfer.downloadStaticTemplateZip).toHaveBeenCalledTimes(1)

    wrapper.vm.openTemplateList()
    await flush()
    expect(wrapper.router.currentRoute.value.query.subTab).toBe('knowledgeGraphTemplate')
    alertSpy.mockRestore()
  })
})

describe('展示格式化', () => {
  it('状态文案：目录内映射 tone/label，目录外回 --；副文案按状态分档', async () => {
    const { wrapper } = await mountList()
    expect(wrapper.vm.statusMeta({ status: 5 })).toMatchObject({ tone: 'success' })
    expect(wrapper.vm.statusMeta({ status: 101 })).toMatchObject({ tone: 'danger' })
    expect(wrapper.vm.statusMeta({ status: 999 })).toEqual({ tone: 'muted', text: '--' })

    expect(wrapper.vm.graphStatusSub({ status: 5 })).toBe(wrapper.vm.$t('modules.kb.metricReadyFoot'))
    expect(wrapper.vm.graphStatusSub({ status: 101 })).toBe(wrapper.vm.$t('modules.kb.statusCheckDataFormat'))
    expect(wrapper.vm.graphStatusSub({ status: 0 })).toBe(wrapper.vm.$t('modules.kb.graphStatusCreatedSub'))
    expect(wrapper.vm.graphStatusSub({ status: 2 })).toBe(wrapper.vm.$t('modules.kb.dataProcessing'))

    expect(wrapper.vm.graphCountSub({ currentFileCount: 3 })).toBe(wrapper.vm.$t('modules.kb.metricReadyFoot'))
    expect(wrapper.vm.graphCountSub({ currentFileCount: 0 })).toBe(wrapper.vm.$t('modules.kb.statusNoData'))
    expect(wrapper.vm.graphCountSub({})).toBe(wrapper.vm.$t('modules.kb.statusNoData'))
  })

  it('时间与头像：日期截断 / 相对时间 / 首字母大写 / 头像色循环', async () => {
    const { wrapper } = await mountList()
    expect(wrapper.vm.formatDateShort('')).toBe('--')
    expect(wrapper.vm.formatDateShort('2026-06-01 08:30:59')).toBe('2026-06-01 08:30')

    expect(wrapper.vm.relativeTime('')).toBe('')
    expect(wrapper.vm.relativeTime('not-a-date')).toBe('')
    const now = Date.now()
    // 与后端字段同格式的本地时间串（组件把 '-' 归一成 '/' 再解析）
    const local = ms => {
      const d = new Date(ms)
      const p = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
    expect(wrapper.vm.relativeTime(local(now - 30 * 1000))).toBe(wrapper.vm.$t('public.justNow'))
    expect(wrapper.vm.relativeTime(local(now - 5 * 60000))).toBe(wrapper.vm.$t('public.minutesAgo', { count: 5 }))
    expect(wrapper.vm.relativeTime(local(now - 3 * 3600000))).toBe(wrapper.vm.$t('public.hoursAgo', { count: 3 }))
    expect(wrapper.vm.relativeTime(local(now - 2 * 86400000))).toBe(wrapper.vm.$t('public.daysAgo', { count: 2 }))

    expect(wrapper.vm.initialOf('')).toBe('?')
    expect(wrapper.vm.initialOf('abc')).toBe('A')
    expect(wrapper.vm.avatarTone(0)).toBe('av-blue')
    expect(wrapper.vm.avatarTone(4)).toBe('av-blue')
    expect(wrapper.vm.avatarTone(2)).toBe('av-green')
  })

  it('处理链路 / 监控面板用真词条渲染（i18n 不落键名）', async () => {
    const { wrapper } = await mountList()
    expect(wrapper.vm.pipelineSteps).toHaveLength(6)
    wrapper.vm.pipelineSteps.forEach(step => {
      expect(step.name).not.toContain('modules.kb.')
      expect(step.desc).not.toContain('modules.kb.')
    })
    wrapper.vm.monitoring.forEach(item => {
      expect(item.value).toBe('—')
      expect(item.delta).not.toContain('modules.kb.')
    })
  })
})
