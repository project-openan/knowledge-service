// @vitest-environment jsdom
// 模型表格（ModelTable.vue）的表单交互残余分支（4/6）：
// 搜索框（v-model.trim + 防抖刷新）、启用状态下拉（筛选分页口径）、
// 行菜单「设为默认」、勾选增删（单行无 id 早退 / 反选删除）、
// 刷新失败上抛、批量动作（无选中早退 / 停用部分失败）、
// 连接测试重复点击早退、两个弹窗的 v-model 通路、启停中重复触发早退。
// 基础覆盖见 test_kbd_modelTable.spec.js。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

const modelApi = vi.hoisted(() => ({
  queryModelsApi: vi.fn(),
  createModelApi: vi.fn(),
  updateModelApi: vi.fn(),
  deleteModelApi: vi.fn(),
  testModelApi: vi.fn()
}))
const deletion = vi.hoisted(() => ({ requestDeletion: vi.fn() }))
const clipboard = vi.hoisted(() => ({ copyTextWithToast: vi.fn() }))

vi.mock('@/features/model/api/model', () => modelApi)
vi.mock('@/shared/composables/deletion', () => deletion)
vi.mock('@/shared/lib/copy-with-toast', () => clipboard)

import { flush, mountWithPlugins } from './helpers/mount'
import { ElSwitch } from 'element-plus/es/components/switch/index'
import { ElTable, ElTableColumn } from 'element-plus/es/components/table/index'
import ModelTable from '@/features/model/ModelTable.vue'
import zhModelManagement from '@/app/i18n/zh/modelManagement'

/** 编辑弹窗只留个壳。 */
const EditorStub = {
  name: 'ModelEditorDialog',
  props: ['modelValue', 'editing', 'initialKind', 'existing', 'submitHandler'],
  emits: ['update:modelValue'],
  setup (props) {
    return () => h('div', { class: 'editor-stub', 'data-open': String(Boolean(props.modelValue)) })
  }
}

const DROPDOWN_PARTS = {
  ElDropdown: {
    name: 'ElDropdown',
    setup (_p, { slots, emit }) {
      return () => h('div', { class: 'dropdown-stub', onClick: () => emit('command', 'command-from-stub') }, [
        slots.default?.(),
        slots.dropdown?.()
      ])
    }
  },
  ElDropdownMenu: { name: 'ElDropdownMenu', setup: (_p, { slots }) => () => slots.default?.() },
  ElDropdownItem: { name: 'ElDropdownItem', props: ['command'], setup: (_p, { slots }) => () => slots.default?.() }
}

const GLOBAL = {
  components: { ElSwitch, ElTable, ElTableColumn, ...DROPDOWN_PARTS },
  stubs: { ModelEditorDialog: EditorStub },
  config: {
    globalProperties: {
      $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() })
    }
  }
}

function rowOf (overrides = {}) {
  return Object.assign({
    modelId: 'mdl-1', modelKind: 'llm', modelName: 'qwen-max', displayName: 'Qwen Max',
    apiModel: '', baseUrl: 'http://10.0.0.9:4000/v1', apiKeyMasked: 'sk-****9f', hasApiKey: true,
    dimension: null, isDefault: true, enabled: true, source: 'user',
    thinkingMode: '', thinkingPreset: '', thinkingPresetLabel: '', thinkingMatchedPresetLabel: ''
  }, overrides)
}

const TWO_ROWS = [
  rowOf({ modelId: 'mdl-1', enabled: true }),
  rowOf({ modelId: 'mdl-2', enabled: false, isDefault: false, modelKind: 'rerank' })
]

async function mountTable ({ items = TWO_ROWS } = {}) {
  modelApi.queryModelsApi.mockResolvedValue({ items, total: items.length, page: 1, pageSize: 10 })
  const wrapper = await mountWithPlugins(ModelTable, {
    route: '/models',
    props: { kind: 'llm' },
    global: GLOBAL
  })
  await flush()
  await flush()
  return wrapper
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  modelApi.queryModelsApi.mockReset()
  modelApi.updateModelApi.mockReset().mockResolvedValue({})
  modelApi.deleteModelApi.mockReset().mockResolvedValue({})
  modelApi.testModelApi.mockReset().mockResolvedValue({ ok: true })
  deletion.requestDeletion.mockReset().mockResolvedValue(true)
  clipboard.copyTextWithToast.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('ModelTable：搜索与启停筛选', () => {
  it('搜索框输入：v-model.trim 去空白并按关键字刷新（防抖后）', async () => {
    vi.useFakeTimers()
    const wrapper = await mountTable()
    modelApi.queryModelsApi.mockClear()
    const input = wrapper.find('.search-field input')
    await input.setValue('  qwen  ')
    expect(wrapper.vm.searchKey).toBe('qwen')
    await vi.advanceTimersByTimeAsync(600)
    expect(modelApi.queryModelsApi).toHaveBeenCalled()
    expect(modelApi.queryModelsApi.mock.calls.at(-1)[0].keyword).toBe('qwen')
  })

  it('启停筛选下拉：enabled 只留启用行且按本页口径分页', async () => {
    const wrapper = await mountTable()
    const dropdowns = wrapper.findAllComponents({ name: 'ElDropdown' })
    // 第一个是工具条的启停筛选
    await dropdowns[0].find('.dropdown-stub').trigger('click') // command='command-from-stub' → 非 all/enabled/disabled，等价 all
    expect(wrapper.vm.enabledFilter).toBe('command-from-stub')

    wrapper.vm.setEnabledFilter('enabled')
    await flush()
    await flush()
    expect(wrapper.vm.rows.map(row => row.modelId)).toEqual(['mdl-1'])
    // 全量拉取后本地切片：currentPage 保持 1、size 按请求值
    expect(wrapper.vm.currentPage).toBe(1)
  })

  it('启停筛选 disabled：只留停用行；切回 all 恢复', async () => {
    const wrapper = await mountTable()
    wrapper.vm.setEnabledFilter('disabled')
    await flush()
    await flush()
    expect(wrapper.vm.rows.map(row => row.modelId)).toEqual(['mdl-2'])
    wrapper.vm.setEnabledFilter('all')
    await flush()
    await flush()
    expect(wrapper.vm.rows).toHaveLength(2)
  })
})

describe('ModelTable：勾选与批量', () => {
  it('无 modelId 的行：勾选早退；正常行反选删除', async () => {
    const wrapper = await mountTable({ items: [rowOf({ modelId: 'mdl-1' }), rowOf({ modelId: '', modelName: 'no-id' })] })
    const boxes = wrapper.findAll('.models-table tbody td.check-cell input[type="checkbox"]')
    // 第 2 行没有 modelId：勾了也不进选中集
    await boxes[1].setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(0)
    // 第 1 行勾选 → 反选删除
    await boxes[0].setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(1)
    await boxes[0].setValue(false)
    expect(wrapper.vm.selectedRows).toHaveLength(0)
  })

  it('表头全选/全不选：整表进出选中集', async () => {
    const wrapper = await mountTable()
    await wrapper.find('.models-table thead input[type="checkbox"]').setValue(true)
    expect(wrapper.vm.selectedRows).toHaveLength(2)
    await wrapper.find('.models-table thead input[type="checkbox"]').setValue(false)
    expect(wrapper.vm.selectedRows).toHaveLength(0)
  })

  it('批量动作没有选中行：直接返回，不发请求', async () => {
    const wrapper = await mountTable()
    await wrapper.vm.batchModels('enable')
    expect(modelApi.updateModelApi).not.toHaveBeenCalled()
    await wrapper.vm.batchModels('delete')
    expect(deletion.requestDeletion).not.toHaveBeenCalled()
  })

  it('批量停用部分失败：给「成功 N / 失败 M」明细', async () => {
    const wrapper = await mountTable()
    const boxes = wrapper.findAll('.models-table tbody td.check-cell input[type="checkbox"]')
    await boxes[0].setValue(true)
    await boxes[1].setValue(true)
    modelApi.updateModelApi = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('x'))
    await wrapper.vm.batchModels('disable')
    expect(GLOBAL.config.globalProperties.$message.error).toHaveBeenCalled()
    // 清了勾选并刷新
    expect(wrapper.vm.selectedRows).toHaveLength(0)
  })
})

describe('ModelTable：行内动作', () => {
  it('行菜单「设为默认」：只传 isDefault + enabled，成功后刷新', async () => {
    const wrapper = await mountTable()
    // 第 0 个是工具条的筛选下拉，第 1 个是第一行的行菜单
    const rowDropdown = wrapper.findAllComponents({ name: 'ElDropdown' })[1]
    await rowDropdown.find('.dropdown-stub').trigger('click')
    await flush()
    expect(modelApi.updateModelApi).toHaveBeenCalledWith('mdl-1', { isDefault: true, enabled: true })
    expect(GLOBAL.config.globalProperties.$message.success).toHaveBeenCalled()
  })

  it('启停开关：启用中重复触发早退；停用成功后清 isDefault', async () => {
    const wrapper = await mountTable()
    const switches = wrapper.findAllComponents(ElSwitch)
    // 第二行（停用态）启用
    await switches[1].vm.$emit('change', true)
    await flush()
    expect(modelApi.updateModelApi).toHaveBeenCalledWith('mdl-2', { enabled: true })
    // 同一行重复触发（toggling 未释放前）早退
    wrapper.vm.toggling = { 'mdl-2': true }
    await switches[1].vm.$emit('change', false)
    expect(modelApi.updateModelApi).toHaveBeenCalledTimes(1)
    wrapper.vm.toggling = {}

    // 第一行停用 → isDefault 一并清掉
    await switches[0].vm.$emit('change', false)
    await flush()
    expect(modelApi.updateModelApi).toHaveBeenCalledWith('mdl-1', { enabled: false, isDefault: false })
    expect(wrapper.vm.rows[0].isDefault).toBe(false)
  })

  it('连接测试：上一次未结束时再次点击早退', async () => {
    const wrapper = await mountTable()
    wrapper.vm.testingId = 'mdl-1'
    wrapper.vm.testClickHandle(wrapper.vm.rows[0])
    expect(modelApi.testModelApi).not.toHaveBeenCalled()
    wrapper.vm.testingId = ''
  })

  it('两个弹窗的 v-model 通路：编辑弹窗与测试弹窗都能关闭', async () => {
    const wrapper = await mountTable()
    wrapper.vm.createHandle()
    await flush()
    expect(wrapper.vm.editorOpen).toBe(true)
    const editor = wrapper.findComponent({ name: 'ModelEditorDialog' })
    editor.vm.$emit('update:modelValue', false)
    await flush()
    expect(wrapper.vm.editorOpen).toBe(false)

    // 测试结果弹窗（el-dialog 桩）的 v-model 通路
    wrapper.vm.testVisible = true
    const dialogs = wrapper.findAllComponents({ name: 'ElDialog' })
    expect(dialogs).toHaveLength(1)
    dialogs[0].vm.$emit('update:modelValue', false)
    await flush()
    expect(wrapper.vm.testVisible).toBe(false)
  })

  it('refreshList 失败：把错误上抛（TableRefreshButton 捕获提示）', async () => {
    const wrapper = await mountTable()
    modelApi.queryModelsApi.mockRejectedValue(new Error('boom'))
    await expect(wrapper.vm.refreshList()).rejects.toThrow('refresh failed')
  })
})

describe('ModelTable：杂项展示', () => {
  it('zh 词条在列（筛选下拉 / 行菜单）', async () => {
    const wrapper = await mountTable()
    expect(wrapper.text()).toContain(zhModelManagement.filterAll)
    expect(wrapper.text()).toContain(zhModelManagement.setDefault)
  })
})
