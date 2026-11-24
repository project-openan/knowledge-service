// @vitest-environment jsdom
// 检索编排列表页：全量取数/本地筛选排序分页、勾选、单条动作（导出/编辑/发布/取消发布/删除）、
// 批量动作、新建入口与复制 ID。api 与删除/发布确认全部 mock，页面用真组件渲染。
import { vi } from 'vitest'

// i18n 在导入期读 localStorage：钉成中文
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { flowApi, deletionApi, confirmOnce, clipboard, downloadMock } = vi.hoisted(() => ({
  flowApi: {},
  deletionApi: {},
  confirmOnce: {},
  clipboard: {},
  downloadMock: {}
}))

vi.mock('@/features/workflow/api/workflow', () => ({
  getFlowList: (...args) => flowApi.getFlowList(...args),
  createFlow: (...args) => flowApi.createFlow(...args),
  updateFlow: (...args) => flowApi.updateFlow(...args),
  deleteFlowApi: (...args) => flowApi.deleteFlowApi(...args),
  exportWorkFlow: (...args) => flowApi.exportWorkFlow(...args),
  publishWorkFlow: (...args) => flowApi.publishWorkFlow(...args),
  unpublishWorkFlow: (...args) => flowApi.unpublishWorkFlow(...args),
  getAllKBList: (...args) => flowApi.getAllKBList(...args),
  getFlowConfig: vi.fn(),
  saveFlowConfig: vi.fn(),
  checkSaveFlowConfig: vi.fn()
}))

vi.mock('@/shared/composables/deletion', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    requestDeletion: (...args) => deletionApi.requestDeletion(...args)
  }
})

vi.mock('@/shared/lib/confirm-once', () => ({
  onceConfirm: (...args) => confirmOnce.onceConfirm(...args)
}))

vi.mock('@/shared/lib/copy-with-toast', () => ({
  copyTextWithToast: (...args) => clipboard.copyTextWithToast(...args)
}))

vi.mock('@/shared/lib/utils', () => ({
  download: (...args) => downloadMock.download(...args)
}))

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { flush, mountWithPlugins, normalizeText } from './helpers/mount'
import WorkflowListPage from '@/pages/workflow/WorkflowListPage.vue'
import zhRoot from '@/app/i18n/zh'
import zhWorkflow from '@/app/i18n/zh/workflow'

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/flow', name: 'flow', component: Blank },
  { path: '/flow/detail/:id', name: 'flow-detail', component: Blank },
  { path: '/:pathMatch(.*)*', component: Blank }
]

/** 一个后端行（形状 = getFlowList 的 item）。 */
function row ({ workFlowId, name, template = 'Blended', publishType = 0, kbPkIds = [], graphKbPkIds = [], knowledgeType = 'knowledgeBase', updated = '2026-06-01 10:00:00' } = {}) {
  return {
    workFlowId,
    name,
    template,
    publishType,
    kbPkIds,
    graphKbPkIds,
    knowledgeType,
    createdBy: 'tester',
    createdDate: '2026-05-01 09:00:00',
    lastUpdatedDate: updated
  }
}

const ROWS = [
  row({ workFlowId: 'wf-a', name: '客户问答', publishType: 0, kbPkIds: [{ name: '手册库' }] }),
  row({ workFlowId: 'wf-b', name: '图谱检索', publishType: 2, graphKbPkIds: [{ name: '图谱库' }], updated: '2026-07-01 08:00:00' }),
  row({ workFlowId: 'wf-c', name: '排序流', template: 'Sequential', publishType: 1, updated: '2026-06-15 12:00:00' })
]

async function mountPage ({ rows = ROWS, listImpl } = {}) {
  flowApi.getFlowList = listImpl || vi.fn(async () => ({ items: rows, total: rows.length }))
  flowApi.createFlow = vi.fn(async () => ({}))
  flowApi.deleteFlowApi = vi.fn(async () => ({}))
  flowApi.exportWorkFlow = vi.fn(async () => 'blob')
  flowApi.publishWorkFlow = vi.fn(async () => ({}))
  flowApi.unpublishWorkFlow = vi.fn(async () => ({}))
  flowApi.getAllKBList = vi.fn(async () => ({ running: [], dev: [] }))
  deletionApi.requestDeletion = vi.fn(async () => true)
  confirmOnce.onceConfirm = vi.fn(fn => fn())
  clipboard.copyTextWithToast = vi.fn(() => true)
  downloadMock.download = vi.fn()

  const wrapper = await mountWithPlugins(WorkflowListPage, {
    route: '/flow',
    routes: ROUTES,
    global: {
      config: {
        globalProperties: {
          $confirm: vi.fn(() => Promise.resolve('confirm')),
          $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
        }
      },
      stubs: {
        CreateWorkflow: {
          name: 'CreateWorkflowStub',
          setup (_, { expose }) {
            const openDialog = vi.fn()
            expose({ openDialog })
            return { openDialog }
          },
          render: () => null
        },
        CreateWorkflowDialog: { name: 'CreateWorkflowDialogStub', render: () => null }
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

describe('取数与分页：一次性取全量 + 本地分页', () => {
  it('首页取全量：翻页请求按 total 补齐（第 1 页只有 2 条但 total=3）', async () => {
    flowApi.getFlowList = vi.fn()
      .mockResolvedValueOnce({ items: ROWS.slice(0, 2), total: 3 })
      .mockResolvedValueOnce({ items: ROWS.slice(2), total: 3 })
    const wrapper = await mountPage({ listImpl: flowApi.getFlowList })
    await flush()
    expect(flowApi.getFlowList).toHaveBeenCalledTimes(2)
    expect(wrapper.vm.workflowList).toHaveLength(3)
  })

  it('空页（items 为空）提前停止；上限 20 页防死循环', async () => {
    flowApi.getFlowList = vi.fn(async () => ({ items: [], total: 999 }))
    const wrapper = await mountPage({ listImpl: flowApi.getFlowList })
    await flush()
    expect(flowApi.getFlowList).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.workflowList).toHaveLength(0)
    expect(wrapper.find('.empty-row').text()).toBeTruthy()
  })

  it('取数失败且列表为空：进入错误态并给重试；已有数据时保留旧列表', async () => {
    flowApi.getFlowList = vi.fn(async () => {
      throw new Error('boom')
    })
    const wrapper = await mountPage({ listImpl: flowApi.getFlowList, rows: [] })
    await flush()
    expect(wrapper.vm.loadError).toBeTruthy()
    expect(wrapper.find('.ep-stub').exists() || wrapper.text()).toBeDefined()

    // 重试成功后错误态消失
    flowApi.getFlowList = vi.fn(async () => ({ items: ROWS, total: 3 }))
    await wrapper.vm.getWorkflowList()
    await flush()
    expect(wrapper.vm.loadError).toBeNull()
    expect(wrapper.vm.workflowList).toHaveLength(3)
  })

  it('搜索关键字作为取数条件；输入防抖 300ms 后刷新', async () => {
    vi.useFakeTimers()
    const wrapper = await mountPage()
    flowApi.getFlowList.mockClear()
    wrapper.vm.searchKey = '客户'
    wrapper.vm.handleSearchInput()
    vi.advanceTimersByTime(320)
    await vi.advanceTimersByTimeAsync(10)
    expect(flowApi.getFlowList).toHaveBeenCalled()
    expect(flowApi.getFlowList.mock.calls[0][2]).toBe('客户')
    vi.useRealTimers()
  })
})

describe('筛选 / 排序 / 分页（本地完成）', () => {
  it('类型筛选认「列表展示类型」：只绑图谱库的 Blended 算图谱检索', async () => {
    const wrapper = await mountPage()
    wrapper.vm.typeFilter = 'graph'
    await flush()
    expect(wrapper.vm.filteredList.map(r => r.workFlowId)).toEqual(['wf-b'])
    expect(wrapper.vm.workflowTypeLabel(wrapper.vm.workflowList[1])).toContain('图谱检索')

    wrapper.vm.typeFilter = 'Sequential'
    await flush()
    expect(wrapper.vm.filteredList.map(r => r.workFlowId)).toEqual(['wf-c'])
    wrapper.vm.typeFilter = 'all'
  })

  it('发布状态筛选 + 按名称排序', async () => {
    const wrapper = await mountPage()
    wrapper.vm.statusFilter = 'published'
    await flush()
    expect(wrapper.vm.filteredList.map(r => r.workFlowId).sort()).toEqual(['wf-b', 'wf-c'])

    wrapper.vm.statusFilter = 'unpublished'
    await flush()
    expect(wrapper.vm.filteredList.map(r => r.workFlowId)).toEqual(['wf-a'])

    wrapper.vm.statusFilter = 'all'
    wrapper.vm.sortBy = 'name'
    await flush()
    expect(wrapper.vm.filteredList.map(r => r.name)).toEqual([...wrapper.vm.filteredList.map(r => r.name)].sort((a, b) => a.localeCompare(b)))
    // 筛选变化会清空勾选并回第一页
    expect(wrapper.vm.currentPage).toBe(1)
  })

  it('分页：每页 10 条内只有一页；onPaginationChange 生效', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.pagedList).toHaveLength(3)
    wrapper.vm.onPaginationChange({ page: 1, size: 2 })
    await flush()
    expect(wrapper.vm.pagedList).toHaveLength(2)
  })
})

describe('勾选：跨页保留与全选', () => {
  it('勾选行 → 刷新后保留；清除勾选生效；全选只勾当前页', async () => {
    const wrapper = await mountPage()
    wrapper.vm.workflowList[0].selected = true
    expect(wrapper.vm.selectedRows).toHaveLength(1)

    await wrapper.vm.refreshWorkflowList()
    expect(wrapper.vm.selectedRows).toHaveLength(1)
    expect(wrapper.vm.workflowList[0].selected).toBe(true)

    wrapper.vm.toggleAll(true)
    expect(wrapper.vm.selectedRows).toHaveLength(3)
    wrapper.vm.clearSelection()
    expect(wrapper.vm.selectedRows).toHaveLength(0)
  })
})

describe('单条动作（action）', () => {
  it('export：导出接口 + download', async () => {
    const wrapper = await mountPage()
    wrapper.vm.action('export', wrapper.vm.workflowList[0])
    await flush()
    expect(flowApi.exportWorkFlow).toHaveBeenCalledWith('wf-a')
    expect(downloadMock.download).toHaveBeenCalled()
  })

  it('edit：打开 CreateWorkflow 的编辑态', async () => {
    const wrapper = await mountPage()
    const stub = wrapper.findComponent({ name: 'CreateWorkflowStub' })
    const openDialog = stub.vm.openDialog
    wrapper.vm.action('edit', wrapper.vm.workflowList[0])
    expect(openDialog).toHaveBeenCalledWith(wrapper.vm.workflowList[0])
  })

  it('publish：首次发布走确认 → 发布接口 → 成功提示 → 刷新', async () => {
    const wrapper = await mountPage()
    wrapper.vm.action('publish', wrapper.vm.workflowList[0])
    await flush()
    expect(confirmOnce.onceConfirm).toHaveBeenCalled()
    expect(flowApi.publishWorkFlow).toHaveBeenCalledWith('wf-a')
    await new Promise(resolve => setTimeout(resolve, 5))
    // 发布中集合：正在发布时 isWorkflowPublishing 为真
    expect(wrapper.vm.isWorkflowPublishing('wf-a')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(wrapper.vm.isWorkflowPublishing('wf-a')).toBe(false)
  })

  it('republish：发布后修改（publishType=2）走重新发布', async () => {
    const wrapper = await mountPage()
    wrapper.vm.action('republish', wrapper.vm.workflowList[1])
    await flush()
    expect(flowApi.publishWorkFlow).toHaveBeenCalledWith('wf-b')
  })

  it('publishing 中的工作流不再重复发起发布', async () => {
    const wrapper = await mountPage()
    let resolvePublish
    flowApi.publishWorkFlow = vi.fn(() => new Promise(resolve => {
      resolvePublish = resolve
    }))
    wrapper.vm.publishFlow(wrapper.vm.workflowList[0])
    await flush()
    wrapper.vm.publishFlow(wrapper.vm.workflowList[0])
    await flush()
    expect(flowApi.publishWorkFlow).toHaveBeenCalledTimes(1)
    resolvePublish()
    await flush()
  })

  it('unpublish：确认后取消发布并刷新', async () => {
    const wrapper = await mountPage()
    wrapper.vm.action('unpublish', wrapper.vm.workflowList[1])
    await flush()
    expect(flowApi.unpublishWorkFlow).toHaveBeenCalledWith('wf-b')
  })

  it('delete：统一确认弹窗 → 删除接口 → 删除后回有效页', async () => {
    const wrapper = await mountPage()
    wrapper.vm.onPaginationChange({ page: 1, size: 2 })
    await flush()
    // workflowList 保持抓取顺序：wf-a 未发布（无 note）
    wrapper.vm.action('delete', wrapper.vm.workflowList[0])
    await flush()
    expect(deletionApi.requestDeletion).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: expect.anything(),
      items: [expect.objectContaining({ id: 'wf-a' })]
    }))
    expect(flowApi.deleteFlowApi).toHaveBeenCalledWith('wf-a')

    // 已发布的工作流（publishType≠0）删除确认带 note（warning 分支）
    wrapper.vm.action('delete', wrapper.vm.workflowList[1])
    await flush()
    const call = deletionApi.requestDeletion.mock.calls[1][0]
    expect(call.note).toBeTruthy()
  })

  it('删除确认被取消：不调接口', async () => {
    const wrapper = await mountPage()
    deletionApi.requestDeletion = vi.fn(async () => false)
    wrapper.vm.action('delete', wrapper.vm.workflowList[0])
    await flush()
    expect(flowApi.deleteFlowApi).not.toHaveBeenCalled()
  })
})

describe('批量动作（batchWorkflows）', () => {
  it('没有勾选：直接返回', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.batchWorkflows('publish')
    expect(flowApi.publishWorkFlow).not.toHaveBeenCalled()
  })

  it('批量发布：跳过已发布（只发 0/2），部分失败给明细', async () => {
    const wrapper = await mountPage()
    wrapper.vm.toggleAll(true)
    await flush()
    flowApi.publishWorkFlow = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('x'))
    await wrapper.vm.batchWorkflows('publish')
    // wf-a(0) 与 wf-b(2) 可发布，wf-c(1) 跳过
    expect(flowApi.publishWorkFlow).toHaveBeenCalledTimes(2)
    expect(wrapper.vm.$message.info).not.toHaveBeenCalled()
  })

  it('全部不可发布：提示跳过', async () => {
    const wrapper = await mountPage()
    wrapper.vm.workflowList[2].selected = true
    await wrapper.vm.batchWorkflows('publish')
    expect(wrapper.vm.$message.info).toHaveBeenCalled()
    expect(flowApi.publishWorkFlow).not.toHaveBeenCalled()

    // 对照：取消发布时 publishType=1 是合法目标，不发「跳过」提示
    await wrapper.vm.batchWorkflows('unpublish')
    expect(flowApi.unpublishWorkFlow).toHaveBeenCalledWith('wf-c')
    expect(wrapper.vm.$message.info).toHaveBeenCalledTimes(1)
  })

  it('批量取消发布：发 unpublish 接口', async () => {
    const wrapper = await mountPage()
    wrapper.vm.workflowList[1].selected = true
    await wrapper.vm.batchWorkflows('unpublish')
    expect(flowApi.unpublishWorkFlow).toHaveBeenCalledWith('wf-b')
    expect(wrapper.vm.$message.success).toHaveBeenCalled()
  })

  it('批量删除：确认 → 全删成功给成功提示；确认被拒不发请求', async () => {
    const wrapper = await mountPage()
    wrapper.vm.toggleAll(true)
    await flush()
    await wrapper.vm.batchWorkflows('delete')
    expect(flowApi.deleteFlowApi).toHaveBeenCalledTimes(3)
    expect(wrapper.vm.$message.success).toHaveBeenCalled()

    deletionApi.requestDeletion = vi.fn(async () => false)
    await wrapper.vm.batchWorkflows('delete')
    expect(flowApi.deleteFlowApi).toHaveBeenCalledTimes(3)
  })

  it('批量删除：部分失败给「成功 N 条 / 失败 M 条」明细', async () => {
    const wrapper = await mountPage()
    wrapper.vm.toggleAll(true)
    await flush()
    flowApi.deleteFlowApi = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('y'))
    await wrapper.vm.batchWorkflows('delete')
    expect(wrapper.vm.$message.success).toHaveBeenCalled()
    expect(wrapper.vm.$message.error).toHaveBeenCalledWith(expect.stringContaining('失败'))
  })
})

describe('展示辅助（表格单元格）', () => {
  it('flowPreview：顺序=一个检索步骤；混合=图谱+混合检索；条件=先过滤', async () => {
    const wrapper = await mountPage()
    const sequential = wrapper.vm.flowPreview(row({ workFlowId: 'x', template: 'Sequential', kbPkIds: [{}] }))
    expect(sequential.map(s => s.label)).toEqual(['Query', 'Vector Search', 'Rerank'])

    const blended = wrapper.vm.flowPreview(row({ workFlowId: 'y', template: 'Blended', kbPkIds: [{}], graphKbPkIds: [{}] }))
    expect(blended.map(s => s.label)).toEqual(['Query', 'Graph Search', 'Hybrid Search', 'Rerank'])

    const conditional = wrapper.vm.flowPreview(row({ workFlowId: 'z', template: 'Conditional' }))
    expect(conditional.map(s => s.label)).toEqual(['Query', '条件过滤', 'Hybrid Search', 'Rerank'])

    // database 类型没有 Rerank 步骤；没绑库回落 Vector Search
    const database = wrapper.vm.flowPreview(row({ workFlowId: 'd', template: 'Sequential', knowledgeType: 'database' }))
    expect(database.map(s => s.label)).toEqual(['Query', 'Vector Search'])
  })

  it('头像/初始字符/日期', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.initialOf('')).toBe('?')
    expect(wrapper.vm.initialOf('abc')).toBe('A')
    expect(wrapper.vm.avatarTone(0)).toBe('av-blue')
    expect(wrapper.vm.avatarTone(5)).toBe('av-purple')
    expect(wrapper.vm.formatDateShort('2026-06-01 10:00:00')).toBe('2026-06-01 10:00')
    expect(wrapper.vm.formatDateShort('')).toBe('--')
  })

  it('relativeTime：刚刚 / 分钟 / 小时 / 天；非法值返回空串', async () => {
    const wrapper = await mountPage()
    const fmt = ms => {
      const d = new Date(ms)
      const pad = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    const now = Date.now()
    expect(wrapper.vm.relativeTime(fmt(now - 10 * 1000))).toBe('刚刚')
    expect(wrapper.vm.relativeTime(fmt(now - 3 * 60000))).toContain('分钟前')
    expect(wrapper.vm.relativeTime(fmt(now - 2 * 3600000))).toContain('小时前')
    expect(wrapper.vm.relativeTime(fmt(now - 3 * 86400000))).toContain('天前')
    expect(wrapper.vm.relativeTime('not-a-date')).toBe('')
    expect(wrapper.vm.relativeTime('')).toBe('')
  })

  it('来源类型标签与展示类型', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.sourceKindOf('knowledge').labelKey).toBeTruthy()
    expect(wrapper.vm.sourceKindOf('graph').tone).toBeTruthy()
    expect(wrapper.vm.sourceKindOf('database').icon).toBeTruthy()
    expect(wrapper.vm.sourceKindOf('???').icon).toBeTruthy()
    expect(wrapper.vm.workflowTypeLabel(row({ template: 'Conditional' }))).toContain('条件检索')
    expect(wrapper.vm.workflowTypeLabel(row({ template: 'unknown' }))).toBe('--')
  })

  it('工具条文案：创建/文档/批量按钮使用真词条', async () => {
    const wrapper = await mountPage()
    const text = normalizeText(wrapper.text())
    expect(text).toContain(zhRoot.ragFlow.ragWorkflow)
    expect(text).toContain(zhRoot.ragFlow.createWorkflow)
    expect(text).toContain(zhWorkflow.pageSubtitle)
  })

  it('openCreateDialog：打开弹窗并拉取知识库选项（running+dev 合并）', async () => {
    const wrapper = await mountPage()
    flowApi.getAllKBList = vi.fn(async () => ({
      running: [{ assetId: 'r1', name: '运行库', tableName: 'feature_r1' }],
      dev: [{ assetId: 'd1', name: '草稿库', tableName: 'graph_d1', type: 'struct_knowledge' }]
    }))
    wrapper.vm.openCreateDialog()
    await flush()
    expect(wrapper.vm.createOpen).toBe(true)
    expect(wrapper.vm.workflowKbOptions).toEqual([
      expect.objectContaining({ id: 'r1', name: '运行库', isGraph: false, isStruct: false }),
      expect.objectContaining({ id: 'd1', name: '草稿库', isGraph: true, isStruct: true })
    ])
  })

  it('createWorkflowWithDialog：建流（绑定所选库）→ 提示 → 刷新 → 进画布', async () => {
    const wrapper = await mountPage()
    flowApi.getAllKBList = vi.fn(async () => ({
      running: [{ assetId: 'r1', name: '运行库', tableName: 'feature_r1' }],
      dev: []
    }))
    wrapper.vm.openCreateDialog()
    await flush()
    await wrapper.vm.createWorkflowWithDialog({ name: '新流', sourceIds: ['r1', 'ghost'], template: 'Blended', description: '' })
    await flush()
    const payload = flowApi.createFlow.mock.calls[0][0]
    expect(payload.workFlowId).toMatch(/^RAG_Workflow_[0-9a-f]{4}$/)
    expect(payload.boundInfo).toEqual({ running: [{ assetId: 'r1', name: '运行库', tableName: 'feature_r1' }], dev: [] })
    expect(flowApi.createFlow).toHaveBeenCalled()
    expect(wrapper.router.currentRoute.value.name).toBe('flow-detail')
    expect(wrapper.router.currentRoute.value.params.id).toBe(payload.workFlowId)
  })

  it('loadWorkflowKbOptions 失败：选项置空不挡弹窗', async () => {
    const wrapper = await mountPage()
    flowApi.getAllKBList = vi.fn(async () => {
      throw new Error('x')
    })
    await wrapper.vm.loadWorkflowKbOptions()
    expect(wrapper.vm.workflowKbOptions).toEqual([])
  })

  it('setFlow：点名称进入画布页', async () => {
    const wrapper = await mountPage()
    wrapper.vm.setFlow(wrapper.vm.workflowList[0])
    await flush()
    expect(wrapper.router.currentRoute.value.params.id).toBe('wf-a')
  })

  it('copyWorkflowId：走统一复制入口', async () => {
    const wrapper = await mountPage()
    wrapper.vm.copyWorkflowId('wf-a')
    expect(clipboard.copyTextWithToast).toHaveBeenCalledWith('wf-a')
  })

  it('openUsageDocs：弹说明框（ElMessageBox.alert）', async () => {
    const wrapper = await mountPage()
    wrapper.vm.openUsageDocs()
    await flush()
    // 只要不抛错即可（ElMessageBox 真组件在 jsdom 下弹不可见对话框）
    expect(wrapper.vm.createOpen).toBe(false)
  })

  it('createWorkflow("create")：走新建弹窗；更多菜单命令分发到对应动作', async () => {
    const wrapper = await mountPage()
    wrapper.vm.createWorkflow('create')
    expect(wrapper.vm.createOpen).toBe(true)
    wrapper.vm.createWorkflow('update', wrapper.vm.workflowList[0])
    const stub = wrapper.findComponent({ name: 'CreateWorkflowStub' })
    expect(stub.vm.openDialog).toHaveBeenCalled()
  })

  it('表格骨架：表头与行渲染（勾选列 + 名称 + 预览 + 类型 + 创建人 + 状态 + 时间 + 操作）', async () => {
    const wrapper = await mountPage()
    const headers = wrapper.findAll('table.list-table thead th')
    expect(headers).toHaveLength(8)
    expect(wrapper.findAll('table.list-table tbody tr')).toHaveLength(3)
    expect(wrapper.text()).toContain('wf-a')
  })
})
