// @vitest-environment jsdom
// 检索编排列表页（WorkflowListPage.vue）的 DOM 交互残余分支（6/6 之页一）：
// 工具条三个下拉的 v-model、排序前缀图标插槽、搜索框 v-model.trim、
// 勾选栏批量按钮（发布/取消发布/删除）、表头与行勾选、名称链接进画布、
// 复制 ID、行菜单命令分发（export/edit/publish/republish/unpublish/delete）、
// 新建弹窗 v-model 关闭、刷新页码回缩与失败上抛、取消发布确认被拒、
// 发布失败 console.error、删除后页码回缩。
// 基础覆盖见 test_wf_WorkflowListPage.spec.js。
import { vi } from 'vitest'

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
  return { ...actual, requestDeletion: (...args) => deletionApi.requestDeletion(...args) }
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

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import WorkflowListPage from '@/pages/workflow/WorkflowListPage.vue'
import zhWorkflow from '@/app/i18n/zh/workflow'

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/flow', name: 'flow', component: Blank },
  { path: '/flow/detail/:id', name: 'flow-detail', component: Blank },
  { path: '/:pathMatch(.*)*', component: Blank }
]

/** 会渲染插槽并可回抛事件的 EP 桩。 */
const PARTS = {
  // prefix/default 插槽都渲染（排序下拉的前缀图标是模板分支）
  ElSelect: {
    name: 'ElSelect',
    props: { modelValue: { type: [String, Number], default: '' } },
    emits: ['update:modelValue'],
    setup (_p, { slots }) {
      return () => h('div', { class: 'select-stub' }, [slots.prefix?.(), slots.default?.()])
    }
  },
  ElOption: { name: 'ElOption', props: ['label', 'value'], setup: props => () => h('div', { class: 'opt-stub' }, props.label) },
  ElTooltip: { name: 'ElTooltip', props: ['content'], setup: (_p, { slots }) => () => slots.default?.() },
  ElDropdown: {
    name: 'ElDropdown',
    setup (_p, { slots }) {
      return () => h('div', { class: 'dropdown-stub' }, [slots.default?.(), slots.dropdown?.()])
    }
  },
  ElDropdownMenu: { name: 'ElDropdownMenu', setup: (_p, { slots }) => () => slots.default?.() },
  ElDropdownItem: { name: 'ElDropdownItem', props: ['command'], setup: (_p, { slots }) => () => slots.default?.() }
}

function row ({ workFlowId, name, template = 'Blended', publishType = 0, updated = '2026-06-01 10:00:00',
  kbPkIds = [{ name: '手册库' }], graphKbPkIds = [] } = {}) {
  return {
    workFlowId,
    name,
    template,
    publishType,
    kbPkIds,
    graphKbPkIds,
    knowledgeType: 'knowledgeBase',
    createdBy: 'tester',
    createdDate: '2026-05-01 09:00:00',
    lastUpdatedDate: updated
  }
}

const ROWS = [
  row({ workFlowId: 'wf-a', name: '客户问答', publishType: 0, updated: '2026-08-01 09:00:00' }),
  row({ workFlowId: 'wf-b', name: '图谱检索', publishType: 2, updated: '2026-07-01 08:00:00',
    kbPkIds: [], graphKbPkIds: [{ name: '图谱库' }] }),
  row({ workFlowId: 'wf-c', name: '排序流', template: 'Sequential', publishType: 1, updated: '2026-06-15 12:00:00' })
]

async function mountPage ({ rows = ROWS } = {}) {
  flowApi.getFlowList = vi.fn(async () => ({ items: rows, total: rows.length }))
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
      components: PARTS,
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
        CreateWorkflowDialog: {
          name: 'CreateWorkflowDialogStub',
          props: ['modelValue'],
          emits: ['update:modelValue'],
          setup (props, { emit }) {
            return () => props.modelValue
              ? h('button', { class: 'close-create-dialog', onClick: () => emit('update:modelValue', false) })
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
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('工具条与表格 DOM 交互', () => {
  it('搜索框：v-model.trim 去空白并触发防抖取数', async () => {
    vi.useFakeTimers()
    const wrapper = await mountPage()
    flowApi.getFlowList.mockClear()
    await wrapper.find('.search-field input').setValue('  客户  ')
    expect(wrapper.vm.searchKey).toBe('客户')
    await vi.advanceTimersByTimeAsync(400)
    expect(flowApi.getFlowList).toHaveBeenCalled()
    expect(flowApi.getFlowList.mock.calls.at(-1)[2]).toBe('客户')
    vi.useRealTimers()
  })

  it('三个下拉：类型/状态/排序的 v-model 生效，选项与前缀图标渲染', async () => {
    const wrapper = await mountPage()
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    // 选项与排序前缀图标经插槽渲染
    expect(wrapper.findAll('.opt-stub').length).toBeGreaterThanOrEqual(9)
    expect(wrapper.find('.workflow-sort-icon').exists()).toBe(true)

    const byAria = label => selects.filter(w => w.attributes('aria-label') === label)
    const typeSelect = byAria(zhWorkflow.allTypes)[0]
    const statusSelect = byAria(zhWorkflow.allStatus)[0]
    const sortSelect = byAria(zhWorkflow.sortByTime)[0]

    typeSelect.vm.$emit('update:modelValue', 'graph')
    await flush()
    expect(wrapper.vm.typeFilter).toBe('graph')
    expect(wrapper.vm.pagedList.map(r => r.workFlowId)).toEqual(['wf-b'])

    typeSelect.vm.$emit('update:modelValue', 'all')
    await flush()
    statusSelect.vm.$emit('update:modelValue', 'unpublished')
    await flush()
    expect(wrapper.vm.pagedList.map(r => r.workFlowId)).toEqual(['wf-a'])

    sortSelect.vm.$emit('update:modelValue', 'name')
    await flush()
    expect(wrapper.vm.sortBy).toBe('name')
    expect(wrapper.vm.filteredList.map(r => r.name))
      .toEqual([...wrapper.vm.filteredList.map(r => r.name)].sort((a, b) => a.localeCompare(b)))
  })

  it('行勾选与表头全选；批量按钮（发布/取消发布/删除）走 DOM 点击', async () => {
    const wrapper = await mountPage()
    // 行勾选（第 1 行 wf-a）
    await wrapper.find('.flow-table tbody input[type="checkbox"]').setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(1)
    // 勾选栏出现：批量发布 / 批量删除逐个点击
    const buttons = wrapper.find('.list-selection-actions').findAll('button')
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    await buttons[0].trigger('click') // 批量发布
    await flush()
    expect(flowApi.publishWorkFlow).toHaveBeenCalledWith('wf-a')
    // 批量动作结束会清空勾选：先重新勾选再点批量删除
    await wrapper.find('.flow-table tbody input[type="checkbox"]').setValue(true)
    await wrapper.find('.list-selection-actions').findAll('button')[2].trigger('click')
    await flush()
    expect(flowApi.deleteFlowApi).toHaveBeenCalledWith('wf-a')
    // 批量取消发布：目标必须是已发布行（publishType≠0）→ 勾第 3 行 wf-c
    await wrapper.findAll('.flow-table tbody input[type="checkbox"]')[2].setValue(true)
    expect(wrapper.vm.selectedRows.map(r => r.workFlowId)).toEqual(['wf-c'])
    await wrapper.find('.list-selection-actions').findAll('button')[1].trigger('click')
    await flush()
    expect(flowApi.unpublishWorkFlow).toHaveBeenCalledWith('wf-c')
    // 表头全选再清除
    await wrapper.find('.flow-table thead input[type="checkbox"]').setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(3)
    await wrapper.find('.list-selection-bar button').trigger('click')
    expect(wrapper.vm.selectedRows).toHaveLength(0)
  })

  it('名称链接进画布；复制 ID 按钮；发布状态提示图标', async () => {
    const wrapper = await mountPage()
    await wrapper.find('a.entity-link').trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('flow-detail')
    expect(wrapper.router.currentRoute.value.params.id).toBe('wf-a')

    await wrapper.find('button.icon-button.copy').trigger('click')
    expect(clipboard.copyTextWithToast).toHaveBeenCalledWith('wf-a')

    // wf-b publishType=2：带提示图标的 tooltip（默认插槽已渲染）
    expect(wrapper.find('.workflow-status__tip').exists()).toBe(true)
  })

  it('行菜单命令分发：export/edit/publish/republish/unpublish 各分支', async () => {
    const wrapper = await mountPage()
    const dropdowns = wrapper.findAllComponents({ name: 'ElDropdown' })
    expect(dropdowns).toHaveLength(3)

    await dropdowns[0].find('.dropdown-stub').trigger('click')
    dropdowns[0].vm.$emit('command', 'export')
    await flush()
    expect(flowApi.exportWorkFlow).toHaveBeenCalledWith('wf-a')

    dropdowns[0].vm.$emit('command', 'edit')
    await flush()
    const stub = wrapper.findComponent({ name: 'CreateWorkflowStub' })
    expect(stub.vm.openDialog).toHaveBeenCalled()

    // wf-a 未发布 → publish；wf-b 已发布修改 → republish
    dropdowns[0].vm.$emit('command', 'publish')
    await flush()
    expect(flowApi.publishWorkFlow).toHaveBeenCalledWith('wf-a')

    dropdowns[1].vm.$emit('command', 'republish')
    await flush()
    expect(flowApi.publishWorkFlow).toHaveBeenCalledWith('wf-b')

    dropdowns[1].vm.$emit('command', 'unpublish')
    await flush()
    expect(flowApi.unpublishWorkFlow).toHaveBeenCalledWith('wf-b')
  })

  it('新建弹窗 v-model：从弹窗内关闭', async () => {
    const wrapper = await mountPage()
    wrapper.vm.openCreateDialog()
    await flush()
    expect(wrapper.vm.createOpen).toBe(true)
    await wrapper.find('button.close-create-dialog').trigger('click')
    expect(wrapper.vm.createOpen).toBe(false)
  })
})

describe('刷新 / 确认 / 删除的页码与失败分支', () => {
  it('refreshWorkflowList：页码超出回缩到有效页；取数失败上抛', async () => {
    const wrapper = await mountPage()
    wrapper.vm.onPaginationChange({ page: 3, size: 2 })
    await flush()
    expect(wrapper.vm.currentPage).toBe(3)
    await wrapper.vm.refreshWorkflowList()
    expect(wrapper.vm.currentPage).toBe(2) // maxPage=ceil(3/2)=2

    flowApi.getFlowList = vi.fn(async () => { throw new Error('boom') })
    await expect(wrapper.vm.refreshWorkflowList()).rejects.toThrow('refresh failed')
  })

  it('取消发布确认被拒：不发接口', async () => {
    const wrapper = await mountPage()
    confirmOnce.onceConfirm = vi.fn(async () => false)
    await wrapper.vm.action('unpublish', wrapper.vm.workflowList[1])
    expect(flowApi.unpublishWorkFlow).not.toHaveBeenCalled()
  })

  it('发布接口失败：console.error 兜底、发布集合在 1 秒后释放', async () => {
    const wrapper = await mountPage()
    flowApi.publishWorkFlow = vi.fn(async () => { throw new Error('发布失败') })
    wrapper.vm.action('publish', wrapper.vm.workflowList[0])
    await flush()
    expect(console.error).toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(wrapper.vm.isWorkflowPublishing('wf-a')).toBe(false)
  })

  it('删除最后一页的唯一行：页码回缩到剩余有效页', async () => {
    const wrapper = await mountPage()
    wrapper.vm.onPaginationChange({ page: 2, size: 2 })
    await flush()
    expect(wrapper.vm.currentPage).toBe(2)
    // 删除第 3 行（第 2 页只剩这一行）→ 剩 2 行 → maxPage 1 → 回到第 1 页
    wrapper.vm.action('delete', wrapper.vm.workflowList[2])
    await flush()
    await flush()
    expect(wrapper.vm.currentPage).toBe(1)
    expect(flowApi.deleteFlowApi).toHaveBeenCalledWith('wf-c')
  })
})
