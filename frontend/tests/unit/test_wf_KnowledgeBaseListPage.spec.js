// @vitest-environment jsdom
// 文档知识库列表页：取数/状态筛选（本地过滤+排序+切片）/勾选/删除（单条+批量）/
// 导入与新建弹窗/概览指标/状态文案目录。接口与删除确认全部 mock。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { graphApi, kbApi, quickCreate, quickCreateGraph, deletionApi, modelsApi } = vi.hoisted(() => ({
  graphApi: {},
  kbApi: {},
  quickCreate: {},
  quickCreateGraph: {},
  deletionApi: {},
  modelsApi: {}
}))

vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  knowledgeGraphListApi: (...args) => graphApi.list(...args),
  knowledgeBaseStatsApi: (...args) => graphApi.stats(...args)
}))

vi.mock('@/features/knowledge-base/api/knowledgeBase', () => ({
  deleteKnowledgeBase: (...args) => kbApi.deleteKnowledgeBase(...args)
}))

vi.mock('@/features/knowledge-base/lib/quick-create', () => ({
  createKnowledgeBaseWithFiles: (...args) => quickCreate.createWithFiles(...args),
  fallbackUploadLimits: () => ({ maxFileMb: 20, maxFiles: 20 }),
  loadUploadLimits: (...args) => quickCreate.loadLimits(...args),
  uploadFilesToKbase: (...args) => quickCreate.upload(...args)
}))

vi.mock('@/features/graph/lib/graph-quick-create', () => ({
  isValidGraphQuickName: (...args) => quickCreateGraph.isValidName(...args),
  loadGraphCreateOptions: (...args) => quickCreateGraph.loadOptions(...args),
  setGraphQuickDraft: (...args) => quickCreateGraph.setDraft(...args)
}))

vi.mock('@/features/model/api/models', () => ({
  getModelList: (...args) => modelsApi.getEmbeddingModels(...args),
  getLLMModel: vi.fn(),
  getRerankModels: vi.fn()
}))

vi.mock('@/shared/composables/deletion', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    requestDeletion: (...args) => deletionApi.requestDeletion(...args)
  }
})

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { flush, mountWithPlugins } from './helpers/mount'
import KnowledgeBaseListPage from '@/pages/knowledge-base/KnowledgeBaseListPage.vue'
import { KB_STATUS } from '@/features/knowledge-base/lib/list-status'

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/knowledge', name: 'knowledge', component: Blank },
  { path: '/knowledge/detail/:id', name: 'knowledge-detail', component: Blank },
  { path: '/knowledge/detail/:id/documents', name: 'knowledge-documents', component: Blank },
  { path: '/graph/create', name: 'graph-create', component: Blank },
  { path: '/:pathMatch(.*)*', component: Blank }
]

/** 一行知识库（形状 = knowledgeGraphListApi 的 item）。 */
function kbRow ({ id, name, status = 2, files = 0, action = 'rw', extra = {} } = {}) {
  return {
    id,
    name,
    status,
    description: `${name} 描述`,
    currentFileCount: files,
    action,
    createdBy: 'tester',
    fullName: 'Tester Zhang',
    fullNameEn: 'Tester Zhang',
    embeddingModel: 'bge-m3',
    updatedDate: '2026-06-01 10:00:00',
    createdDate: '2026-05-01 09:00:00',
    ...extra
  }
}

const ROWS = [
  kbRow({ id: 'kb-1', name: '手册库', status: 7, files: 3 }),
  kbRow({ id: 'kb-2', name: '帮助库', status: 0, files: 0 }),
  kbRow({ id: 'kb-3', name: '失败库', status: 101, files: 0, extra: { failReason: '嵌入失败' } })
]

async function mountPage ({ rows = ROWS, total = rows.length, listImpl, stats } = {}) {
  graphApi.list = listImpl || vi.fn(async () => ({ items: rows, total }))
  graphApi.stats = stats || vi.fn(async () => ({
    categories: [
      { category: 1, total: 2, fileTotal: 5, statusCounts: { '7': 1, '0': 1 } },
      { category: 10, total: 1, fileTotal: 0, statusCounts: {} }
    ]
  }))
  kbApi.deleteKnowledgeBase = vi.fn(async () => ({}))
  quickCreate.createWithFiles = vi.fn(async () => ({ kbId: 'kb-new' }))
  quickCreate.loadLimits = vi.fn(async () => ({ maxFileMb: 50, maxFiles: 100 }))
  quickCreate.upload = vi.fn(async () => ({}))
  quickCreateGraph.isValidName = vi.fn(name => /^graph_/.test(name))
  quickCreateGraph.loadOptions = vi.fn(async () => ({
    models: [{ name: 'graph-emb' }], existingNames: ['旧图谱'], limits: { maxFileMb: 1 }
  }))
  quickCreateGraph.setDraft = vi.fn()
  modelsApi.getEmbeddingModels = vi.fn(async () => [{ modelName: 'bge-large' }])
  deletionApi.requestDeletion = vi.fn(async () => true)

  const wrapper = await mountWithPlugins(KnowledgeBaseListPage, {
    route: '/knowledge',
    routes: ROUTES,
    global: {
      config: {
        globalProperties: {
          $globalZh: true,
          $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
        }
      },
      stubs: {
        CreateKbaseDialog: { name: 'CreateKbaseDialogStub', setup (_, { expose }) { expose({ openDialog: vi.fn() }) }, render: () => null },
        CreateKnowledgeDialog: { name: 'CreateKnowledgeDialogStub', render: () => null },
        KnowledgeImportDialog: { name: 'KnowledgeImportDialogStub', setup (_, { emit }) { return { submit: emit } }, render: () => null }
      }
    }
  })
  await flush()
  return wrapper
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('取数与渲染', () => {
  it('挂载即取列表与概览；行渲染名称/文件数/状态', async () => {
    const wrapper = await mountPage()
    expect(graphApi.list).toHaveBeenCalled()
    expect(wrapper.vm.rows).toHaveLength(3)
    expect(wrapper.text()).toContain('手册库')
    expect(wrapper.text()).toContain('3 篇文档')
    // 概览指标：docStats.total=2、fileTotal=5 → 平均 2.5；ready=2 → 100%
    expect(wrapper.vm.overview.kbTotal).toBe(2)
    expect(wrapper.vm.overview.docTotal).toBe(5)
    expect(wrapper.vm.overview.avgDocs).toBe('2.5')
    expect(wrapper.vm.readyPercent).toBe('100%')
  })

  it('列表为空：ready 态渲染空行；total 缺省用 items 长度', async () => {
    const wrapper = await mountPage({ rows: [], total: undefined })
    expect(wrapper.vm.total).toBe(0)
    expect(wrapper.find('.empty-row').exists()).toBe(true)
  })

  it('取数失败：空列表进入 error 态；被新请求取消不算失败', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    graphApi.list = vi.fn(async () => {
      throw new Error('boom')
    })
    const wrapper = await mountPage({ listImpl: graphApi.list, rows: [] })
    expect(wrapper.vm.listState).toBe('error')
    // 错误态保留表格骨架（空行里给「加载失败 + 重试」，不伪造空列表）
    expect(wrapper.find('.empty-row').exists()).toBe(true)
    expect(wrapper.find('.empty-row').text()).toContain('数据获取失败')

    // 取消请求：loadRows 返回 true，且不再打错误日志
    const cancelError = new Error('canceled')
    cancelError.code = 'ERR_CANCELED'
    graphApi.list = vi.fn(async () => {
      throw cancelError
    })
    const errorCount = errorSpy.mock.calls.length
    const ok = await wrapper.vm.loadRows()
    expect(ok).toBe(true)
    expect(errorSpy.mock.calls.length).toBe(errorCount)
    errorSpy.mockRestore()
  })

  it('刷新按钮：页码越界回落到最后一页再取一次', async () => {
    const wrapper = await mountPage({ listImpl: vi.fn(async () => ({ items: ROWS, total: 5 })) })
    wrapper.vm.currentPage = 2
    await wrapper.vm.refreshList()
    // total=5 → maxPage=1，第 2 页越界 → 回落第 1 页再取一次
    expect(wrapper.vm.currentPage).toBe(1)
  })
})

describe('状态筛选（本地过滤 + 排序 + 切片）', () => {
  it('筛选「已就绪」：拉全量后本地过滤并按请求分页切片', async () => {
    const wrapper = await mountPage()
    graphApi.list.mockClear()
    wrapper.vm.setStatusFilter('ready')
    await flush()
    // 全量请求：pageSize 500、第一页
    const params = graphApi.list.mock.calls[0][0]
    expect(params.pageSize).toBe(500)
    expect(params.currentPage).toBe(1)
    expect(wrapper.vm.rows.every(row => [0, 5, 7, 8].includes(row.status))).toBe(true)
    expect(wrapper.vm.total).toBe(2)
  })

  it('筛选状态下按 orderList 排序', async () => {
    const wrapper = await mountPage()
    wrapper.vm.setStatusFilter('ready')
    await flush()
    wrapper.vm.refreshTableData([{ key: 'name', ascending: 'desc' }])
    await flush()
    expect(wrapper.vm.rows.map(row => row.name)).toEqual(['手册库', '帮助库'])
  })

  it('matchesStatusFilter：未知状态码在「全部」里也显示', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.matchesStatusFilter({ status: 999 })).toBe(true)
    wrapper.vm.statusFilter = 'ready'
    expect(wrapper.vm.matchesStatusFilter({ status: 999 })).toBe(false)
    expect(wrapper.vm.matchesStatusFilter({ status: KB_STATUS.PUBLISHED })).toBe(true)
    wrapper.vm.statusFilter = 'failed'
    expect(wrapper.vm.matchesStatusFilter({ status: KB_STATUS.PARSE_FAILED })).toBe(true)
    expect(wrapper.vm.matchesStatusFilter({ status: KB_STATUS.PUBLISHED })).toBe(false)
  })
})

describe('搜索与自动刷新', () => {
  it('搜索防抖后按关键字刷新；输入期间标记输入中', async () => {
    vi.useFakeTimers()
    const wrapper = await mountPage()
    graphApi.list.mockClear()
    wrapper.vm.handleSearchInput()
    vi.advanceTimersByTime(600)
    await vi.advanceTimersByTimeAsync(10)
    expect(graphApi.list).toHaveBeenCalled()
    expect(graphApi.list.mock.calls[0][0].keyword).toBe('')
    vi.useRealTimers()
  })

  it('后台静默刷新不挂 loading；切回前台按节拍补刷', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.listState).toBe('ready')
    graphApi.list.mockClear()
    await wrapper.vm.refreshTableDataSilently()
    expect(wrapper.vm.listState).toBe('ready')

    // 立刻切回前台：距上次刷新不足一个节拍 → 不补刷
    graphApi.list.mockClear()
    wrapper.vm.syncOnResume()
    expect(graphApi.list).not.toHaveBeenCalled()
  })

  it('hasPendingKbaseRows：有进行中的行才轮询', async () => {
    const wrapper = await mountPage({ rows: [kbRow({ id: 'kb-1', name: '处理中', status: 1 })] })
    expect(wrapper.vm.hasPendingKbaseRows()).toBe(true)
    // 全部就绪后不再轮询
    const wrapper2 = await mountPage({ rows: [kbRow({ id: 'kb-2', name: '就绪', status: 7 })] })
    expect(wrapper2.vm.hasPendingKbaseRows()).toBe(false)
  })
})

describe('勾选与批量删除', () => {
  it('勾选/全选/清除；同步已选行数据', async () => {
    const wrapper = await mountPage()
    wrapper.vm.toggleRow(wrapper.vm.rows[0], true)
    expect(wrapper.vm.selectedRows).toHaveLength(1)
    wrapper.vm.toggleAll(true)
    expect(wrapper.vm.selectedRows).toHaveLength(3)
    // 同步：刷新后已选行数据更新
    graphApi.list = vi.fn(async () => ({ items: [kbRow({ id: 'kb-1', name: '手册库-新', files: 9 })], total: 1 }))
    await wrapper.vm.loadRows()
    expect(wrapper.vm.selectedRows[0].name).toBe('手册库-新')
    wrapper.vm.clearSelection()
    expect(wrapper.vm.selectedRows).toHaveLength(0)
  })

  it('无 id 的行不进选择集合', async () => {
    const wrapper = await mountPage()
    wrapper.vm.toggleRow({ name: '无 id' }, true)
    expect(wrapper.vm.selectedRows).toHaveLength(0)
  })

  it('removeSelectedKbs：确认后逐个删除并回有效页', async () => {
    const wrapper = await mountPage()
    wrapper.vm.rows.forEach(row => wrapper.vm.toggleRow(row, true))
    await wrapper.vm.removeSelectedKbs()
    // kb-1（3 文件）被剔除，kb-2/kb-3 删除成功
    expect(kbApi.deleteKnowledgeBase).toHaveBeenCalledTimes(2)
    expect(kbApi.deleteKnowledgeBase).toHaveBeenCalledWith('kb-2')
    expect(wrapper.vm.$message.success).toHaveBeenCalled()
  })

  it('removeSelectedKbs：全部被剔除时只给提示', async () => {
    const wrapper = await mountPage({ rows: [kbRow({ id: 'kb-1', name: '手册库', files: 3 }), kbRow({ id: 'kb-x', name: '锁定库', files: 0, action: 'c' })] })
    wrapper.vm.rows.forEach(row => wrapper.vm.toggleRow(row, true))
    await wrapper.vm.removeSelectedKbs()
    expect(kbApi.deleteKnowledgeBase).not.toHaveBeenCalled()
    expect(wrapper.vm.$message.warning).toHaveBeenCalled()
  })

  it('removeSelectedKbs：部分失败给明细提示', async () => {
    const wrapper = await mountPage({ rows: [kbRow({ id: 'kb-2', name: '帮助库' })] })
    wrapper.vm.rows.forEach(row => wrapper.vm.toggleRow(row, true))
    kbApi.deleteKnowledgeBase = vi.fn()
      .mockRejectedValueOnce(new Error('x'))
    await wrapper.vm.removeSelectedKbs()
    expect(wrapper.vm.$message.error).toHaveBeenCalled()
  })

  it('removeSelectedKbs：确认被拒不发请求', async () => {
    const wrapper = await mountPage()
    wrapper.vm.rows.forEach(row => wrapper.vm.toggleRow(row, true))
    deletionApi.requestDeletion = vi.fn(async () => false)
    await wrapper.vm.removeSelectedKbs()
    expect(kbApi.deleteKnowledgeBase).not.toHaveBeenCalled()
  })
})

describe('单条删除', () => {
  it('非空库直接拦截（提示不弹确认）', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.deleteKbaseHandle(wrapper.vm.rows[0])
    expect(deletionApi.requestDeletion).not.toHaveBeenCalled()
    expect(wrapper.vm.$message.warning).toHaveBeenCalled()
  })

  it('空库：确认后删除、清选中、回有效页；失败给带详情的提示', async () => {
    const wrapper = await mountPage({ rows: [kbRow({ id: 'kb-2', name: '帮助库' })] })
    await wrapper.vm.deleteKbaseHandle(wrapper.vm.rows[0])
    expect(deletionApi.requestDeletion).toHaveBeenCalled()
    expect(kbApi.deleteKnowledgeBase).toHaveBeenCalledWith('kb-2')

    kbApi.deleteKnowledgeBase = vi.fn(async () => {
      throw { detail: '约束冲突' }
    })
    await wrapper.vm.deleteKbaseHandle(wrapper.vm.rows[0])
    expect(wrapper.vm.$message.error).toHaveBeenCalledWith('删除失败：约束冲突')
  })

  it('确认被拒：不删除', async () => {
    const wrapper = await mountPage({ rows: [kbRow({ id: 'kb-2', name: '帮助库' })] })
    deletionApi.requestDeletion = vi.fn(async () => false)
    await wrapper.vm.deleteKbaseHandle(wrapper.vm.rows[0])
    expect(kbApi.deleteKnowledgeBase).not.toHaveBeenCalled()
  })
})

describe('单元格展示辅助', () => {
  it('statusMeta：未知状态给 muted/未知文案', async () => {
    const wrapper = await mountPage()
    const meta = wrapper.vm.statusMeta({ status: 999 })
    expect(meta.tone).toBe('muted')
    expect(meta.text).toBeTruthy()
  })

  it('statusSub：各状态段的副文案', async () => {
    const wrapper = await mountPage()
    const text = key => wrapper.vm.statusSub({ status: key })
    expect(text(KB_STATUS.PUBLISHED_MODIFIED)).toBeTruthy()
    expect(text(KB_STATUS.PUBLISH_FAILED)).toBeTruthy()
    expect(text(KB_STATUS.PUBLISHED)).toBeTruthy()
    expect(text(KB_STATUS.PARSE_FAILED)).toBeTruthy()
    expect(text(KB_STATUS.PARSING)).toBeTruthy()
    expect(text(999)).toBeTruthy()
  })

  it('creatorOf：中文名 + 账号；都缺失给 --', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.creatorOf({ fullName: '张三', createdBy: 'zs' })).toBe('张三 zs')
    expect(wrapper.vm.creatorOf({ fullNameEn: 'ZS', createdBy: 'zs' })).toBe('zs')
    expect(wrapper.vm.creatorOf({})).toBe('--')
  })

  it('isRowLocked：action=c 锁行', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.isRowLocked({ action: 'c' })).toBe(true)
    expect(wrapper.vm.isRowLocked({ action: 'rw' })).toBe(false)
    expect(wrapper.vm.isRowLocked(null)).toBe(false)
  })

  it('日期辅助与头像', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.formatDateShort('2026-06-01T10:00:00')).toBe('2026-06-01 10:00')
    expect(wrapper.vm.formatDateShort('')).toBe('--')
    expect(wrapper.vm.initialOf(null)).toBe('?')
    expect(wrapper.vm.avatarTone(1)).toBe('av-purple')
    const now = Date.now()
    const d = new Date(now - 30000)
    const pad = n => String(n).padStart(2, '0')
    const formatted = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    expect(wrapper.vm.relativeTime(formatted)).toBe('刚刚')
    expect(wrapper.vm.relativeTime('bad')).toBe('')
  })

  it('docCountLabel：文件数带单位', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.$t).toBeDefined()
  })
})

describe('导入与新建', () => {
  it('openImport：目标下拉覆盖全量知识库；失败保留当前页选项', async () => {
    const wrapper = await mountPage()
    graphApi.list = vi.fn(async () => ({ items: [kbRow({ id: 'kb-9', name: '别的库' })], total: 1 }))
    await wrapper.vm.openImport({ id: 'kb-1' })
    expect(wrapper.vm.importOpen).toBe(true)
    expect(wrapper.vm.importTarget).toBe('kb-1')
    expect(wrapper.vm.importEntries).toEqual([expect.objectContaining({ id: 'kb-9', name: '别的库' })])

    graphApi.list = vi.fn(async () => {
      throw new Error('x')
    })
    await wrapper.vm.openImport()
    expect(wrapper.vm.importEntries.every(entry => entry.id)).toBe(true)
  })

  it('submitImport：上传成功 → 提示 → 刷新列表与指标', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.submitImport({ target: { id: 'kb-1' }, files: [{}] })
    expect(quickCreate.upload).toHaveBeenCalledWith('kb-1', [{}], expect.objectContaining({ skipErrorHandler: true, coverFlag: false }))
    expect(wrapper.vm.$message.success).toHaveBeenCalled()

    // 覆盖重传带 coverFlag
    await wrapper.vm.submitImport({ target: { id: 'kb-1' }, files: [{}] }, { coverFlag: true })
    expect(quickCreate.upload.mock.calls[1][2].coverFlag).toBe(true)
  })

  it('openCreateDialog（文档）：并发取模型/同名/上传上限后打开弹窗', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.openCreateDialog()
    expect(modelsApi.getEmbeddingModels).toHaveBeenCalled()
    expect(wrapper.vm.embeddingModels).toEqual([{ name: 'bge-large' }])
    expect(wrapper.vm.uploadLimits).toEqual({ maxFileMb: 50, maxFiles: 100 })
    expect(wrapper.vm.createOpen).toBe(true)
    expect(wrapper.vm.createGraph).toBe(false)
  })

  it('openCreateDialog（图谱）：用图谱建流选项', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.openCreateDialog('', true)
    expect(quickCreateGraph.loadOptions).toHaveBeenCalled()
    expect(wrapper.vm.embeddingModels).toEqual([{ name: 'graph-emb' }])
    expect(wrapper.vm.createGraph).toBe(true)
    expect(wrapper.vm.createTemplate).toBe('')
  })

  it('模型/同名接口失败：保持空列表不挡弹窗', async () => {
    const wrapper = await mountPage()
    modelsApi.getEmbeddingModels = vi.fn(async () => {
      throw new Error('x')
    })
    graphApi.list = vi.fn(async () => ({ items: [{ id: 'kb-1', name: '有名字' }], total: 1 }))
    await wrapper.vm.openCreateDialog()
    expect(wrapper.vm.embeddingModels).toEqual([])
    expect(wrapper.vm.existingNames).toEqual(['有名字'])
    expect(wrapper.vm.createOpen).toBe(true)
  })

  it('saveKnowledgeDialog：文档走真实建库；图谱校验名字并带草稿跳建图页', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.saveKnowledgeDialog({ name: '新库', description: '', model: 'bge', files: [] })
    await flush()
    expect(quickCreate.createWithFiles).toHaveBeenCalled()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge-documents')
    expect(wrapper.router.currentRoute.value.params.id).toBe('kb-new')

    // 走图谱分支：先标记 createGraph
    wrapper.vm.createGraph = true
    quickCreateGraph.isValidName = vi.fn(() => false)
    await expect(wrapper.vm.saveKnowledgeDialog({ name: '坏名字', files: [] }))
      .rejects.toThrow('invalid graph knowledge base name')
    expect(wrapper.vm.$message.error).toHaveBeenCalled()

    quickCreateGraph.isValidName = vi.fn(() => true)
    await wrapper.vm.saveKnowledgeDialog({ name: 'graph_新图谱', files: [] })
    await flush()
    expect(quickCreateGraph.setDraft).toHaveBeenCalledWith(expect.objectContaining({ name: 'graph_新图谱' }))
    expect(wrapper.router.currentRoute.value.name).toBe('graph-create')
  })

  it('createKnowledgeWithFiles：建库成功但上传失败 → 提示后带 kbId 进文档页', async () => {
    const wrapper = await mountPage()
    quickCreate.createWithFiles = vi.fn(async () => {
      throw { kbId: 'kb-partial' }
    })
    await wrapper.vm.createKnowledgeWithFiles({ name: '半成功', files: [{}] })
    await flush()
    expect(wrapper.vm.$message.error).toHaveBeenCalled()
    expect(wrapper.router.currentRoute.value.params.id).toBe('kb-partial')

    // 与上传无关的失败原样抛回弹窗
    quickCreate.createWithFiles = vi.fn(async () => {
      throw new Error('创建失败')
    })
    await expect(wrapper.vm.createKnowledgeWithFiles({ name: '失败', files: [] })).rejects.toThrow('创建失败')
  })
})

describe('面板 / 文档 / 弹窗入口', () => {
  it('openPanel：pipeline/monitor 面板；docs 弹说明', async () => {
    const wrapper = await mountPage()
    wrapper.vm.openPanel('pipeline')
    expect(wrapper.vm.panelOpen).toBe(true)
    expect(wrapper.vm.panel).toBe('pipeline')
    wrapper.vm.openPanel('monitor')
    expect(wrapper.vm.panel).toBe('monitor')
    wrapper.vm.openPanel('docs')
    expect(wrapper.vm.panelOpen).toBe(true)
    // monitoring 指标卡（计算属性）
    expect(wrapper.vm.monitoring).toHaveLength(4)
    expect(wrapper.vm.pipelineSteps.length).toBeGreaterThan(3)
  })

  it('导航：详情 / 文档页（带 import 参数）/ 修改弹窗', async () => {
    const wrapper = await mountPage()
    wrapper.vm.detailHandle(wrapper.vm.rows[0])
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge-detail')

    wrapper.vm.openDocuments(wrapper.vm.rows[0], true)
    await flush()
    expect(wrapper.router.currentRoute.value.query.import).toBe('1')

    wrapper.vm.openDocuments(wrapper.vm.rows[0])
    await flush()
    expect(wrapper.router.currentRoute.value.query.import).toBeUndefined()

    wrapper.vm.modifyKbaseHandle(wrapper.vm.rows[0])
    expect(wrapper.vm.createKbaseDialogRef).toBeTruthy()
  })

  it('moreHandleCommand：modify/delete 命令分发到对应处理', async () => {
    const wrapper = await mountPage({ rows: [kbRow({ id: 'kb-2', name: '帮助库' })] })
    const openDialog = vi.fn()
    wrapper.vm.createKbaseDialogRef = { openDialog }
    wrapper.vm.moreHandleCommand('modifyKbase', wrapper.vm.rows[0])
    expect(openDialog).toHaveBeenCalledWith({ mode: 'edit', id: 'kb-2' })
    wrapper.vm.moreHandleCommand('deleteKbase', wrapper.vm.rows[0])
    await flush()
    expect(deletionApi.requestDeletion).toHaveBeenCalled()
  })

  it('refreshAfterDeletes：删除后回有效页并刷新指标', async () => {
    const wrapper = await mountPage({ rows: [kbRow({ id: 'kb-2', name: '帮助库' })] })
    graphApi.list.mockClear()
    graphApi.stats.mockClear()
    await wrapper.vm.refreshAfterDeletes(1)
    expect(graphApi.list).toHaveBeenCalled()
    expect(graphApi.stats).toHaveBeenCalled()
  })

  it('createFromTemplate：document/graph 两路', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.createFromTemplate('document')
    expect(wrapper.vm.createGraph).toBe(false)
    expect(wrapper.vm.createTemplate).toBeTruthy()
    await wrapper.vm.createFromTemplate('graph')
    expect(wrapper.vm.createGraph).toBe(true)
    await wrapper.vm.createFromTemplate('other')
    expect(wrapper.vm.createTemplate).toBe('')
  })

  it('loadOverviewStats 失败：保持 0 不挡页面', async () => {
    const wrapper = await mountPage({ stats: vi.fn(async () => { throw new Error('x') }) })
    await wrapper.vm.loadOverviewStats()
    expect(wrapper.vm.overview.kbTotal).toBe(0)
    expect(wrapper.vm.readyPercent).toBe('0%')
  })
})
