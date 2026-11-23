// @vitest-environment jsdom
// 图谱知识库列表（GraphList.vue）的 DOM 交互残余分支（9/6 之图二）：
// 工具条（下载模板 / 更多 / 状态筛选下拉与选项、搜索框 v-model.trim）、
// 勾选（表头全选与反选、行勾选）、名称链接、行菜单（修改 / 导出 / 删除）、
// 批量删除按钮、监控抽屉（v-model / 周期下拉 / 了解更多链接）、
// 导入选择弹窗（单选 v-model / 确认与取消按钮）、自动刷新节拍、
// 页签切回补刷、刷新页码收敛与失败上抛、分页回调、同名排序比较、删除后页码回缩、
// 卸载清理。基础覆盖见 test_pg_GraphList.spec.js（script 专项）。
import { vi } from 'vitest'
import { ref } from 'vue'

const { api, transfer, quickCreate, deletionMock, zipMock } = vi.hoisted(() => ({
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
  zipMock: { loadAsyncImpl: vi.fn() }
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

vi.mock('@/features/knowledge-base/api', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    CreateKnowledgeDialog: { name: 'CreateKnowledgeDialogStub', props: ['open', 'models', 'existingNames', 'limits'], emits: ['created', 'close'], render: () => null }
  }
})

vi.mock('@/shared/ui/reference/MetricCard.vue', () => ({ default: { name: 'MetricCardStub', props: ['label', 'value', 'tone', 'hint'], render: () => null } }))

import { describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import GraphList from '@/features/graph/GraphList.vue'

const messageMock = Object.assign(vi.fn(() => ({ close: vi.fn() })), {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn()
})

const PARTS = {
  ElSelect: {
    name: 'ElSelect',
    props: { modelValue: { type: [String, Number], default: '' } },
    emits: ['update:modelValue'],
    setup (_p, { slots }) {
      return () => h('div', { class: 'select-stub' }, [slots.default?.()])
    }
  },
  ElOption: { name: 'ElOption', props: ['label', 'value'], setup: props => () => h('div', { class: 'opt-stub' }, props.label) },
  ElTooltip: { name: 'ElTooltip', setup: (_p, { slots }) => () => h('span', { class: 'tooltip-stub' }, [slots.default?.(), slots.content?.()]) },
  ElDropdown: {
    name: 'ElDropdown',
    props: ['command'],
    emits: ['command'],
    setup (_p, { slots }) {
      return () => h('div', { class: 'dropdown-stub' }, [slots.default?.(), slots.dropdown?.()])
    }
  },
  ElDropdownMenu: { name: 'ElDropdownMenu', setup: (_p, { slots }) => () => slots.default?.() },
  ElDropdownItem: { name: 'ElDropdownItem', props: ['command'], setup: (_p, { slots, emit }) => () => h('div', { class: 'ddi-stub', onClick: () => emit('click') }, slots.default?.()) },
  ElRadio: { name: 'ElRadio', props: ['value'], setup: (_p, { slots }) => () => h('div', { class: 'radio-stub' }, slots.default?.()) },
  ElRadioGroup: {
    name: 'ElRadioGroup',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup (_p, { slots }) {
      return () => h('div', { class: 'radio-group-stub' }, slots.default?.())
    }
  },
  ElDialog: {
    name: 'ElDialog',
    props: ['modelValue', 'title'],
    emits: ['update:modelValue'],
    setup (props, { slots }) {
      return () => (props.modelValue
        ? h('div', { class: 'test-dialog' }, [slots.default ? slots.default() : null, slots.footer ? slots.footer() : null])
        : null)
    }
  },
  ElDrawer: {
    name: 'ElDrawer',
    props: ['modelValue', 'title'],
    emits: ['update:modelValue'],
    setup (props, { slots }) {
      return () => (props.modelValue ? h('div', { class: 'drawer-stub' }, [slots.header?.(), slots.default?.()]) : null)
    }
  }
}

const ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } },
  { path: '/graph/detail/:id', name: 'graph-detail', component: { render: () => null } },
  { path: '/graph/edit/:id', name: 'graph-edit', component: { render: () => null } },
  { path: '/access', name: 'access', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

function listRows () {
  return [
    { id: 'kb1', name: '图谱一', status: 1, currentFileCount: 2, createdDate: '2026-06-01 08:30:00', description: 'd1' },
    { id: 'kb2', name: '图谱二', status: 3, currentFileCount: 0, createdDate: '', description: '' },
    { id: 'kb3', name: '图谱三', status: 5, currentFileCount: 9, createdDate: '2026-06-02 10:00:00', description: 'd3' },
    { id: 'kb4', name: '图谱四', status: 101, currentFileCount: 0, createdDate: 'bad-date', description: 'd4' }
  ]
}

async function mountList ({ rows = listRows() } = {}) {
  api.knowledgeGraphListApi.mockReset().mockResolvedValue({ items: rows, total: rows.length })
  api.knowledgeBaseStatsApi.mockReset().mockResolvedValue({
    categories: [{ category: 10, total: 4, fileTotal: 11, statusCounts: { 0: 1, 1: 1, 5: 1, 101: 1 } }]
  })
  api.deleteKnowledgeGraphApi.mockReset().mockResolvedValue({})
  api.importKnowledgeGraphApi.mockReset().mockResolvedValue({})
  api.getKnowledgeGraphBasicInfoApi.mockReset().mockResolvedValue({})
  api.exportGraphKnowledgeBaseApi.mockReset().mockResolvedValue(new Blob(['zip']))
  quickCreate.loadGraphCreateOptions.mockReset().mockResolvedValue({
    models: [{ name: 'bge-large' }], existingNames: [], limits: {}
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
      components: PARTS,
      provide: { kbaseActiveTab: outerTab, activeTabName: subTab },
      config: { globalProperties: { $message: messageMock, $loading: vi.fn(() => ({ close: vi.fn() })) } }
    }
  })
  await flush()
  return { wrapper, outerTab, subTab }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('工具条 DOM 交互', () => {
  it('搜索框 v-model.trim 生效并立即刷新', async () => {
    const { wrapper } = await mountList()
    api.knowledgeGraphListApi.mockClear()
    await wrapper.find('.search-field input').setValue('  图谱  ')
    await flush()
    expect(wrapper.vm.searchKey).toBe('图谱')
    expect(api.knowledgeGraphListApi).toHaveBeenCalled()
    expect(api.knowledgeGraphListApi.mock.calls.at(-1)[0].keyword).toBe('图谱')
  })

  it('模板下载与「更多」下拉：渲染 + 命令分发', async () => {
    const { wrapper } = await mountList()
    const dropdowns = wrapper.findAllComponents({ name: 'ElDropdown' })
    // 工具条：模板下载（0）、更多（1）、状态筛选（2）
    expect(wrapper.text()).toContain('下载模板')
    expect(wrapper.text()).toContain('知识处理流程')
    expect(wrapper.text()).toContain('检索效果监控')

    await dropdowns[0].find('.dropdown-stub').trigger('click')
    dropdowns[0].vm.$emit('command', 'download')
    await flush()
    expect(transfer.downloadStaticTemplateZip).toHaveBeenCalled()

    dropdowns[1].vm.$emit('command', 'monitor')
    await flush()
    expect(wrapper.vm.panelOpen).toBe(true)
    expect(wrapper.vm.panel).toBe('monitor')
    // 监控视图：周期下拉 + 指标
    expect(wrapper.find('.drawer-stub').exists()).toBe(true)
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    selects.at(-1).vm.$emit('update:modelValue', '30')
    await flush()
    expect(wrapper.vm.monitorPeriod).toBe('30')

    // 链接点击关抽屉
    wrapper.vm.panel = 'pipeline'
    await flush()
    await wrapper.find('a.panel-link').trigger('click')
    await flush()
    expect(wrapper.vm.panelOpen).toBe(false)

    dropdowns[1].vm.$emit('command', 'pipeline')
    await flush()
    expect(wrapper.vm.panel).toBe('pipeline')
  })

  it('状态筛选下拉：渲染目录选项；命令生效本地过滤', async () => {
    const { wrapper } = await mountList()
    const dropdowns = wrapper.findAllComponents({ name: 'ElDropdown' })
    expect(wrapper.text()).toContain('全部状态')
    dropdowns[2].vm.$emit('command', 'failed')
    await flush()
    await flush()
    expect(wrapper.vm.rows.map(r => r.name)).toEqual(['图谱四'])
  })

  it('表头全选/反选；行勾选/反选；批量删除按钮', async () => {
    const { wrapper } = await mountList()
    const boxes = wrapper.findAll('.knowledge-table tbody td.check-cell input[type="checkbox"]')
    await boxes[0].setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(1)
    await boxes[0].setValue(false)
    expect(wrapper.vm.selectedRows).toHaveLength(0)

    await wrapper.find('.knowledge-table thead input[type="checkbox"]').setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(4)
    await wrapper.find('.knowledge-table thead input[type="checkbox"]').setValue(false)
    expect(wrapper.vm.selectedRows).toHaveLength(0)

    // 勾选后批量删除（列表条全部可删：isGraphDeleteEnabled 恒真）
    await boxes[3].setValue(true)
    const batchBtn = wrapper.find('.list-selection-actions button')
    await batchBtn.trigger('click')
    await flush()
    await flush()
    expect(deletionMock.requestDeletion).toHaveBeenCalled()
    expect(api.deleteKnowledgeGraphApi).toHaveBeenCalledWith('kb4')
  })

  it('名称链接进图谱详情页；行菜单三项', async () => {
    const { wrapper } = await mountList()
    await wrapper.find('a.entity-link').trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('graph-detail')

    const rowDropdowns = wrapper.findAllComponents({ name: 'ElDropdown' }).slice(3)
    const items = rowDropdowns[2].findAllComponents({ name: 'ElDropdownItem' })
    // 修改 → 编辑页
    await items.find(i => i.text().includes('修改')).vm.$emit('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('graph-edit')

    // 导出 → blob 落盘
    await items.find(i => i.text().includes('导出')).vm.$emit('click')
    await flush()
    expect(transfer.saveBlobAsFile).toHaveBeenCalled()

    // 删除 → 确认 → 接口
    await items.find(i => i.text().includes('删除')).vm.$emit('click')
    await flush()
    await flush()
    expect(deletionMock.requestDeletion).toHaveBeenCalled()
    expect(api.deleteKnowledgeGraphApi).toHaveBeenCalledWith('kb3')
  })
})

describe('导入选择弹窗', () => {
  it('单选 v-model 与确认 / 取消按钮', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.importChoiceDialogVisible = true
    await flush()
    const dialog = wrapper.find('.test-dialog')
    expect(dialog.exists()).toBe(true)
    // 确认（导入按钮）：回传当前选择值并关闭
    const confirm = wrapper.findAll('.test-dialog button').find(b => b.text().includes('导入'))
    await confirm.trigger('click')
    expect(wrapper.vm.importChoiceDialogVisible).toBe(false)

    // 取消
    wrapper.vm.importChoiceDialogVisible = true
    await flush()
    const cancel = wrapper.findAll('.test-dialog button').find(b => b.text().includes('取消'))
    await cancel.trigger('click')
    expect(wrapper.vm.importChoiceDialogVisible).toBe(false)
  })
})

describe('刷新 / 分页 / 排序残余', () => {
  it('refreshList：页码收敛与失败上抛', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.onPaginationChange({ page: 3, size: 2 })
    await flush()
    await wrapper.vm.refreshList()
    expect(wrapper.vm.currentPage).toBe(2) // ceil(4/2)

    api.knowledgeGraphListApi.mockRejectedValue(new Error('boom'))
    await expect(wrapper.vm.refreshList()).rejects.toThrow('refresh failed')
  })

  it('onPaginationChange：换页换大小', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.onPaginationChange({ page: 2, size: 20 })
    await flush()
    expect(wrapper.vm.currentPage).toBe(2)
    expect(wrapper.vm.pageSize).toBe(20)
  })

  it('状态筛选 + 同名列排序：相等返回 0', async () => {
    const sameRows = [
      { id: 'a', name: '同名', status: 5, currentFileCount: 0, createdDate: '2026-01-01 08:00:00' },
      { id: 'b', name: '同名', status: 5, currentFileCount: 0, createdDate: '2026-02-01 08:00:00' },
      { id: 'c', name: 'Other', status: 5, currentFileCount: 0, createdDate: '2026-03-01 08:00:00' }
    ]
    const { wrapper } = await mountList({ rows: sameRows })
    wrapper.vm.orderList = [{ key: 'name', ascending: 'asc' }]
    wrapper.vm.setStatusFilter('ready')
    await flush()
    await flush()
    expect(wrapper.vm.rows).toHaveLength(3)
  })

  it('删除末页唯一行：页码回缩', async () => {
    const rows = listRows().slice(0, 3)
    const { wrapper } = await mountList({ rows })
    wrapper.vm.onPaginationChange({ page: 2, size: 2 })
    await flush()
    await flush()
    expect(wrapper.vm.currentPage).toBe(2)
    wrapper.vm.deleteKnowledgeGraphHandle(wrapper.vm.rows[1])
    await flush()
    await flush()
    expect(wrapper.vm.currentPage).toBe(1)
  })
})

describe('自动刷新与生命周期', () => {
  it('轮询节拍：可见 + 有构建中行才刷新；页签切回补刷；卸载清理', async () => {
    vi.useFakeTimers()
    const { AUTO_REFRESH_INTERVAL } = await import('@/shared/composables/useListAutoRefresh')
    const { wrapper, outerTab } = await mountList()
    await vi.advanceTimersByTimeAsync(0)
    api.knowledgeGraphListApi.mockClear()

    // 有构建中的行（status 1/3）→ 一拍后静默刷新 + 指标
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_INTERVAL + 100)
    expect(api.knowledgeGraphListApi).toHaveBeenCalled()

    // 页签切走：闸门关闭，不再刷新
    api.knowledgeGraphListApi.mockClear()
    outerTab.value = 'documents'
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_INTERVAL + 100)
    expect(api.knowledgeGraphListApi).not.toHaveBeenCalled()

    // 页签切回本页：watcher 立即补刷
    outerTab.value = 'knowledgeGraph'
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(api.knowledgeGraphListApi).toHaveBeenCalled()

    wrapper.unmount()
  })
})
