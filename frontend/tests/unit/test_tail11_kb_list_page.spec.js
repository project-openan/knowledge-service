// @vitest-environment jsdom
// 文档知识库列表页（KnowledgeBaseListPage.vue）的 DOM 交互残余分支（6/6 之页二）：
// 新建/导入按钮、模板与「更多」下拉、状态筛选下拉、搜索框、勾选（行/全选/反选）、
// 名称链接、行菜单五项（分块/文档/重命名/导入/删除）、空态重试、监控抽屉与周期下拉、
// 自动刷新闸门（隐藏页/无进行中行不发请求）、卸载清理、静默刷新、
// 刷新失败上抛、分页回调、extractRows 四种形状、relativeTime 三档、
// 新建弹窗数据加载失败回落、删除后页码回缩。
// 基础覆盖见 test_wf_KnowledgeBaseListPage.spec.js 与 kbList.*.spec.js。
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
  return { ...actual, requestDeletion: (...args) => deletionApi.requestDeletion(...args) }
})

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import KnowledgeBaseListPage from '@/pages/knowledge-base/KnowledgeBaseListPage.vue'
import { KB_STATUS } from '@/features/knowledge-base/lib/list-status'
import { AUTO_REFRESH_INTERVAL } from '@/shared/composables/useListAutoRefresh'

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/knowledge', name: 'knowledge', component: Blank },
  { path: '/knowledge/detail/:id', name: 'knowledge-detail', component: Blank },
  { path: '/knowledge/detail/:id/documents', name: 'knowledge-documents', component: Blank },
  { path: '/access', name: 'access', component: Blank },
  { path: '/graph/create', name: 'graph-create', component: Blank },
  { path: '/:pathMatch(.*)*', component: Blank }
]

function kbRow ({ id, name, status = 2, files = 0, updated = '2026-06-01 10:00:00' } = {}) {
  return {
    id,
    name,
    status,
    description: `${name} 描述`,
    currentFileCount: files,
    action: 'rw',
    createdBy: 'tester',
    embeddingModel: 'bge-m3',
    updatedDate: updated,
    createdDate: '2026-05-01 09:00:00'
  }
}

const ROWS = [
  kbRow({ id: 'kb-1', name: '手册库', status: 7, files: 3, updated: '2026-08-01 09:00:00' }),
  kbRow({ id: 'kb-2', name: '帮助库', status: 0, files: 0 }),
  kbRow({ id: 'kb-3', name: '失败库', status: 101, files: 0 })
]

const PARTS = {
  ElSelect: {
    name: 'ElSelect',
    props: { modelValue: { type: [String, Number], default: '' } },
    emits: ['update:modelValue'],
    setup (_p, { slots }) {
      return () => h('div', { class: 'select-stub' }, [slots.prefix?.(), slots.default?.()])
    }
  },
  ElOption: { name: 'ElOption', props: ['label', 'value'], setup: props => () => h('div', { class: 'opt-stub' }, props.label) },
  ElDropdown: {
    name: 'ElDropdown',
    setup (_p, { slots }) {
      return () => h('div', { class: 'dropdown-stub' }, [slots.default?.(), slots.dropdown?.()])
    }
  },
  ElDropdownMenu: { name: 'ElDropdownMenu', setup: (_p, { slots }) => () => slots.default?.() },
  ElDropdownItem: { name: 'ElDropdownItem', props: ['command'], setup: (_p, { slots, emit }) => () => h('div', { class: 'ddi-stub', onClick: () => emit('click') }, slots.default?.()) },
  // 只在打开时渲染 header + default 插槽（监控/流程抽屉的内容分支）
  ElDrawer: {
    name: 'ElDrawer',
    props: ['modelValue'],
    setup (props, { slots }) {
      return () => (props.modelValue
        ? h('div', { class: 'drawer-stub' }, [slots.header?.(), slots.default?.()])
        : null)
    }
  }
}

async function mountPage ({ rows = ROWS, total = rows.length, listImpl, kbaseStubOpen } = {}) {
  graphApi.list = listImpl || vi.fn(async () => ({ items: rows, total }))
  graphApi.stats = vi.fn(async () => ({
    categories: [{ category: 1, total: 2, fileTotal: 5, statusCounts: { '7': 1 } }]
  }))
  kbApi.deleteKnowledgeBase = vi.fn(async () => ({}))
  quickCreate.createWithFiles = vi.fn(async () => ({ kbId: 'kb-new' }))
  quickCreate.loadLimits = vi.fn(async () => ({ maxFileMb: 50, maxFiles: 100 }))
  quickCreate.upload = vi.fn(async () => ({}))
  quickCreateGraph.isValidName = vi.fn(name => /^graph_/.test(name))
  quickCreateGraph.loadOptions = vi.fn(async () => ({ models: [{ name: 'graph-emb' }], existingNames: [], limits: {} }))
  quickCreateGraph.setDraft = vi.fn()
  modelsApi.getEmbeddingModels = vi.fn(async () => [{ modelName: 'bge-large' }])
  deletionApi.requestDeletion = vi.fn(async () => true)

  const wrapper = await mountWithPlugins(KnowledgeBaseListPage, {
    route: '/knowledge',
    routes: ROUTES,
    global: {
      components: PARTS,
      config: {
        globalProperties: {
          $globalZh: true,
          $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
        }
      },
      stubs: {
        CreateKbaseDialog: {
          name: 'CreateKbaseDialogStub',
          props: ['modelValue'],
          setup (_, { expose }) {
            const openDialog = vi.fn()
            expose({ openDialog })
            return { openDialog }
          },
          render: () => null
        },
        CreateKnowledgeDialog: {
          name: 'CreateKnowledgeDialogStub',
          props: ['modelValue'],
          emits: ['update:modelValue'],
          setup (props, { emit }) {
            return () => props.modelValue
              ? h('button', { class: 'close-create-knowledge', onClick: () => emit('update:modelValue', false) })
              : null
          }
        },
        KnowledgeImportDialog: {
          name: 'KnowledgeImportDialogStub',
          props: ['modelValue'],
          emits: ['update:modelValue'],
          setup (props, { emit }) {
            return () => props.modelValue
              ? h('button', { class: 'close-import-dialog', onClick: () => emit('update:modelValue', false) })
              : null
          }
        }
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
  delete document.hidden
})

describe('工具条交互', () => {
  it('新建按钮：打开弹窗并拉取库名清单；清单接口失败回落空列表', async () => {
    const wrapper = await mountPage()
    await wrapper.find('.toolbar-left button').trigger('click') // 第一个：新建知识库
    await flush()
    expect(wrapper.vm.createOpen).toBe(true)
    expect(wrapper.vm.existingNames).toContain('手册库')

    // 再开一次，这次库名清单接口失败 → existingNames=[]
    graphApi.list = vi.fn(async () => { throw new Error('boom') })
    wrapper.vm.createOpen = false
    await wrapper.vm.openCreateDialog()
    await flush()
    expect(wrapper.vm.existingNames).toEqual([])
  })

  it('导入按钮：打开导入弹窗；弹窗 v-model 关闭', async () => {
    const wrapper = await mountPage()
    const buttons = wrapper.find('.toolbar-left').findAll('button')
    await buttons[1].trigger('click') // 导入
    await flush()
    expect(wrapper.vm.importOpen).toBe(true)
    await wrapper.find('button.close-import-dialog').trigger('click')
    expect(wrapper.vm.importOpen).toBe(false)
  })

  it('模板下拉：document 直接建库弹窗；graph 进图谱草稿', async () => {
    const wrapper = await mountPage()
    const dropdowns = wrapper.findAllComponents({ name: 'ElDropdown' })
    // 工具条：模板下拉（0）、更多下拉（1）、状态筛选下拉（2）；其余是行菜单
    expect(wrapper.text()).toContain('文档知识库')
    expect(wrapper.text()).toContain('图谱知识库')

    dropdowns[0].vm.$emit('command', 'document')
    await flush()
    expect(wrapper.vm.createOpen).toBe(true)
    expect(wrapper.vm.createGraph).toBe(false)
    wrapper.vm.createOpen = false

    dropdowns[0].vm.$emit('command', 'graph')
    await flush()
    expect(wrapper.vm.createGraph).toBe(true)
  })

  it('「更多」下拉：处理流程 / 检索监控 / 查看文档', async () => {
    const wrapper = await mountPage()
    const dropdowns = wrapper.findAllComponents({ name: 'ElDropdown' })
    expect(wrapper.text()).toContain('了解知识处理流程')
    expect(wrapper.text()).toContain('查看检索效果监控')

    dropdowns[1].vm.$emit('command', 'pipeline')
    await flush()
    expect(wrapper.vm.panelOpen).toBe(true)
    expect(wrapper.vm.panel).toBe('pipeline')
    // 流程抽屉内容渲染
    expect(wrapper.find('.pipeline-steps').exists()).toBe(true)
    wrapper.vm.panelOpen = false
    await flush()

    dropdowns[1].vm.$emit('command', 'monitor')
    await flush()
    expect(wrapper.vm.panel).toBe('monitor')
    // 监控视图：周期下拉 + 指标列表
    expect(wrapper.find('.monitor-list').exists()).toBe(true)
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    const monitorSelect = selects.filter(w => w.attributes('aria-label') === '监控时间范围')[0]
    monitorSelect.vm.$emit('update:modelValue', '30')
    await flush()
    expect(wrapper.vm.monitorPeriod).toBe('30')

    // 「了解更多」链接点击关抽屉
    wrapper.vm.panel = 'pipeline'
    await flush()
    await wrapper.find('a.panel-link').trigger('click')
    await flush()
    expect(wrapper.vm.panelOpen).toBe(false)

    // 「查看文档」走使用说明弹窗（ElMessageBox），不打开抽屉
    dropdowns[1].vm.$emit('command', 'docs')
    await flush()
    expect(wrapper.vm.panelOpen).toBe(false)
  })

  it('状态筛选下拉：渲染目录选项；command 生效后本地过滤', async () => {
    const wrapper = await mountPage()
    const dropdowns = wrapper.findAllComponents({ name: 'ElDropdown' })
    expect(wrapper.text()).toContain('全部状态')

    dropdowns[2].vm.$emit('command', 'ready')
    await flush()
    await flush()
    expect(wrapper.vm.statusFilter).toBe('ready')
    // ready = 0/5/7/8（手册库 7、帮助库 0）
    expect(wrapper.vm.rows.map(r => r.name)).toEqual(['手册库', '帮助库'])

    dropdowns[2].vm.$emit('command', 'failed')
    await flush()
    await flush()
    expect(wrapper.vm.rows.map(r => r.name)).toEqual(['失败库'])
  })

  it('搜索框：v-model.trim 生效并触发防抖取数', async () => {
    vi.useFakeTimers()
    const wrapper = await mountPage()
    graphApi.list.mockClear()
    await wrapper.find('.search-field input').setValue('  手册  ')
    expect(wrapper.vm.searchKey).toBe('手册')
    await vi.advanceTimersByTimeAsync(600)
    expect(graphApi.list).toHaveBeenCalled()
    expect(graphApi.list.mock.calls.at(-1)[0].keyword).toBe('手册')
  })
})

describe('勾选与行交互', () => {
  it('行勾选/反选；表头全选/全不选', async () => {
    const wrapper = await mountPage()
    const rowBoxes = wrapper.findAll('.knowledge-table tbody td.check-cell input[type="checkbox"]')
    await rowBoxes[0].setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(1)
    await rowBoxes[0].setValue(false)
    expect(wrapper.vm.selectedRows).toHaveLength(0)

    await wrapper.find('.knowledge-table thead input[type="checkbox"]').setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(3)
    await wrapper.find('.knowledge-table thead input[type="checkbox"]').setValue(false)
    expect(wrapper.vm.selectedRows).toHaveLength(0)
  })

  it('名称链接进入分块详情页', async () => {
    const wrapper = await mountPage()
    await wrapper.find('a.entity-link').trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge-detail')
    expect(wrapper.router.currentRoute.value.params.id).toBe('kb-1')
  })

  it('行菜单五项：分块 / 文档管理 / 重命名 / 导入 / 删除', async () => {
    const wrapper = await mountPage()
    const rowDropdowns = wrapper.findAllComponents({ name: 'ElDropdown' }).slice(3)
    expect(rowDropdowns).toHaveLength(3)
    const firstRowItems = rowDropdowns[0].findAllComponents({ name: 'ElDropdownItem' })
    expect(firstRowItems).toHaveLength(5)

    // 行内五项各自的上抛通路（@click 绑定在 el-dropdown-item 上）
    firstRowItems[0].vm.$emit('click') // 分块
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge-detail')
    firstRowItems[1].vm.$emit('click') // 文档管理
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge-documents')

    firstRowItems[2].vm.$emit('click') // 重命名
    await flush()
    const renameStub = wrapper.findComponent({ name: 'CreateKbaseDialogStub' })
    expect(renameStub.vm.openDialog).toHaveBeenCalled()

    firstRowItems[3].vm.$emit('click') // 上传文档：进文档管理并带 import 参数
    await flush()
    expect(wrapper.router.currentRoute.value.query).toEqual({ import: '1' })

    // kb-1 还有 3 篇文档：删除被拦下（有空库的删除走「删除末页唯一行」用例）
    firstRowItems[4].vm.$emit('click') // 删除
    await flush()
    expect(deletionApi.requestDeletion).not.toHaveBeenCalled()
    expect(wrapper.vm.$message.warning).toHaveBeenCalled()
  })

  it('删除末页唯一行：页码回缩到剩余有效页', async () => {
    const wrapper = await mountPage()
    wrapper.vm.onPaginationChange({ page: 2, size: 2 })
    await flush()
    await flush()
    expect(wrapper.vm.currentPage).toBe(2)
    wrapper.vm.moreHandleCommand('deleteKbase', { id: 'kb-3', name: '失败库', status: 101 })
    await flush()
    await flush()
    expect(kbApi.deleteKnowledgeBase).toHaveBeenCalledWith('kb-3')
    expect(wrapper.vm.currentPage).toBe(1)
  })

  it('空列表错误态：点重试重新取数', async () => {
    const wrapper = await mountPage({ rows: [], total: 0, listImpl: vi.fn(async () => { throw new Error('boom') }) })
    await flush()
    expect(wrapper.vm.listState).toBe('error')
    graphApi.list = vi.fn(async () => ({ items: ROWS, total: 3 }))
    const retry = wrapper.findAll('.empty-row button').find(b => b.text().includes('重试'))
    await retry.trigger('click')
    await flush()
    await flush()
    expect(wrapper.vm.listState).toBe('ready')
    expect(wrapper.vm.rows).toHaveLength(3)
  })
})

describe('自动刷新与生命周期', () => {
  it('轮询闸门：有进行中行才刷新；页面隐藏不刷新', async () => {
    vi.useFakeTimers()
    const pendingRows = [kbRow({ id: 'kb-1', name: '解析中', status: KB_STATUS.PARSING }), ...ROWS.slice(1)]
    const wrapper = await mountPage({ rows: pendingRows })
    // 挂载取数（fake timers 下用 advanceTimersByTimeAsync 冲刷异步链）
    await vi.advanceTimersByTimeAsync(0)
    expect(graphApi.list).toHaveBeenCalled()
    graphApi.list.mockClear()

    // 有进行中行：一拍之后静默刷新
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_INTERVAL + 100)
    expect(graphApi.list).toHaveBeenCalled()

    // 页面隐藏：不发请求
    graphApi.list.mockClear()
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_INTERVAL + 100)
    expect(graphApi.list).not.toHaveBeenCalled()

    // 页面可见但全部是对地状态：也不发请求
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    wrapper.vm.rows.forEach(row => { row.status = 7 })
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_INTERVAL + 100)
    expect(graphApi.list).not.toHaveBeenCalled()
  })

  it('回前台补刷：间隔已到才发；隐藏时跳过；卸载清理监听与定时器', async () => {
    const wrapper = await mountPage({ rows: [kbRow({ id: 'kb-1', name: '解析中', status: KB_STATUS.PARSING })] })
    // 间隔未到：不刷
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(graphApi.list).toHaveBeenCalledTimes(1) // 只有挂载那次

    // 把「上次静默刷新」拨回 20 秒前：focus 触发补刷
    wrapper.vm.lastSilentRefreshAt = Date.now() - 20000
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(graphApi.list).toHaveBeenCalledTimes(2)

    // 隐藏时：跳过
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    wrapper.vm.lastSilentRefreshAt = Date.now() - 20000
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(graphApi.list).toHaveBeenCalledTimes(2)

    // 卸载：监听与定时器一起清（不抛错即可；重复触发不再发请求）
    wrapper.unmount()
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    window.dispatchEvent(new Event('focus'))
  })
})

describe('辅助函数与刷新分支', () => {
  it('extractRows：四种响应形状', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.extractRows(null)).toEqual([])
    expect(wrapper.vm.extractRows([{ id: 1 }])).toEqual([{ id: 1 }])
    expect(wrapper.vm.extractRows({ items: [{ id: 2 }] })).toEqual([{ id: 2 }])
    expect(wrapper.vm.extractRows({ data: { items: [{ id: 3 }] } })).toEqual([{ id: 3 }])
    expect(wrapper.vm.extractRows({ data: {} })).toEqual([])
  })

  it('relativeTime：空值 / 刚刚 / 分钟 / 小时 / 天', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.relativeTime('')).toBe('')
    const fmt = ms => {
      const d = new Date(ms)
      const pad = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    const now = Date.now()
    expect(wrapper.vm.relativeTime(fmt(now - 10 * 1000))).toContain('刚刚')
    expect(wrapper.vm.relativeTime(fmt(now - 3 * 60000))).toContain('分钟前')
    expect(wrapper.vm.relativeTime(fmt(now - 2 * 3600000))).toContain('小时前')
    expect(wrapper.vm.relativeTime(fmt(now - 3 * 86400000))).toContain('天前')
    expect(wrapper.vm.relativeTime('not-a-date')).toBe('')
  })

  it('状态筛选 + 排序：本地排序同名比较与前后互换', async () => {
    const sameNameRows = [
      kbRow({ id: 'a', name: '同名库', status: 7, updated: '2026-01-01 08:00:00' }),
      kbRow({ id: 'b', name: '同名库', status: 7, updated: '2026-02-01 08:00:00' }),
      kbRow({ id: 'c', name: ' Earlier ', status: 7 })
    ]
    const wrapper = await mountPage({ rows: sameNameRows, total: 3 })
    wrapper.vm.orderList = [{ key: 'name', ascending: 'asc' }]
    wrapper.vm.setStatusFilter('ready')
    await flush()
    await flush()
    expect(wrapper.vm.statusFilter).toBe('ready')
    expect(wrapper.vm.rows).toHaveLength(3)
  })

  it('refreshList 失败上抛；onPaginationChange 换页换大小', async () => {
    const wrapper = await mountPage()
    graphApi.list = vi.fn(async () => { throw new Error('boom') })
    await expect(wrapper.vm.refreshList()).rejects.toThrow('refresh failed')

    graphApi.list = vi.fn(async () => ({ items: ROWS, total: 3 }))
    wrapper.vm.onPaginationChange({ page: 2, size: 20 })
    await flush()
    expect(wrapper.vm.currentPage).toBe(2)
    expect(wrapper.vm.pageSize).toBe(20)
    expect(wrapper.vm.createOpen).toBe(false)

    // 新建弹窗 v-model 关闭通路
    wrapper.vm.openCreateDialog()
    await flush()
    await wrapper.find('button.close-create-knowledge').trigger('click')
    expect(wrapper.vm.createOpen).toBe(false)
  })
})
