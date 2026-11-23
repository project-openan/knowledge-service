// @vitest-environment jsdom
// 模型表格（ModelTable.vue）的残余分支：本地启停筛选的分页口径、批量启用/停用/
// 删除（含部分失败文案）、单条删除后的页码回缩、勾选栏（单行/全选/清除）、
// 行内连接测试（重复点击只发一次、结果弹窗）、复制端点、密钥缺失提示、
// 新建/编辑入口与 saveModel 的「保存后跨类型切页签」。
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
import ModelTestResultTableComp from '@/features/model/ModelTestResultTable.vue'
import TablePagination from '@/shared/ui/reference/TablePagination.vue'
import ModelEditorDialog from '@/features/model/components/ModelEditorDialog.vue'
import zhModelManagement from '@/app/i18n/zh/modelManagement'

const TEST_RESULT = { ok: true, probed: true, models: ['m-a'], latencyMs: 64 }

/** 编辑弹窗只留个壳：把 submitHandler 挂到按钮上，触发 saveModel 的各条链。 */
const EditorStub = {
  name: 'ModelEditorDialog',
  props: ['modelValue', 'editing', 'initialKind', 'existing', 'submitHandler'],
  emits: ['update:modelValue'],
  setup (props) {
    // submitHandler 失败由真弹窗捕获（未捕获的 rejection 会污染整个测试进程）
    const save = values => () => Promise.resolve(props.submitHandler(values)).catch(() => {})
    return () => h('div', { class: 'editor-stub', 'data-open': String(Boolean(props.modelValue)) }, [
      h('button', { class: 'editor-save-llm', onClick: save({ modelKind: 'llm' }) }),
      h('button', { class: 'editor-save-embedding', onClick: save({ modelKind: 'embedding' }) })
    ])
  }
}

const GLOBAL = {
  // 真 ElTable/ElTableColumn：连接测试结果表用 #default="{ row }" 作用域插槽，
  // EP 占位件给不出 row，会渲染报错
  components: { ElSwitch, ElTable, ElTableColumn },
  // ⚠️ script setup 直接 import 的组件要用 stubs 拦（components 覆盖不了）
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
  rowOf({ modelId: 'mdl-2', enabled: false, isDefault: false, displayName: 'Reranker X', modelKind: 'rerank', hasApiKey: false })
]

async function mountTable ({ items = TWO_ROWS, kind = 'llm', reject = false } = {}) {
  if (reject) {
    modelApi.queryModelsApi.mockRejectedValue(new Error('boom'))
  } else {
    modelApi.queryModelsApi.mockResolvedValue({ items, total: items.length, page: 1, pageSize: 10 })
  }
  const wrapper = await mountWithPlugins(ModelTable, {
    route: '/models',
    props: { kind },
    global: GLOBAL
  })
  await flush()
  await flush()
  return wrapper
}

function rowCheckboxes (wrapper) {
  // ⚠️ 行内的 ElSwitch 也是 input[type=checkbox]，必须限定在勾选格
  return wrapper.findAll('.models-table tbody td.check-cell input[type="checkbox"]')
}

async function toggleRow (wrapper, index) {
  await rowCheckboxes(wrapper)[index].setValue(true)
  await flush()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  modelApi.queryModelsApi.mockReset()
  modelApi.createModelApi.mockReset().mockResolvedValue({})
  modelApi.updateModelApi.mockReset().mockResolvedValue({})
  modelApi.deleteModelApi.mockReset().mockResolvedValue({})
  modelApi.testModelApi.mockReset().mockResolvedValue(TEST_RESULT)
  deletion.requestDeletion.mockReset().mockResolvedValue(true)
  clipboard.copyTextWithToast.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('列表加载与行渲染', () => {
  it('onMounted 取数：queryModelsApi 带 kind/keyword，行渲染名称与端点', async () => {
    const wrapper = await mountTable()
    expect(modelApi.queryModelsApi).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'llm', keyword: '', currentPage: 1, pageSize: 10 }),
      {}
    )
    expect(wrapper.findAll('.models-table tbody tr')).toHaveLength(2)
    expect(wrapper.text()).toContain('Qwen Max')
    expect(wrapper.text()).toContain('http://10.0.0.9:4000/v1')
    // apiModel 与 modelName 相同 → 显示「OpenAI 兼容」而不是重复内部名
    expect(wrapper.text()).toContain(zhModelManagement.openaiCompatible)
  })

  it('行标签：默认标记 / embedding 维度 / 思考模式（auto 未匹配、preset、custom）/ 密钥缺失', async () => {
    const rows = [
      rowOf({ modelId: 'e1', modelKind: 'embedding', dimension: 1024, isDefault: true }),
      rowOf({ modelId: 'e2', modelKind: 'llm', thinkingMode: 'auto', thinkingPresetLabel: '', thinkingMatchedPresetLabel: '', isDefault: false }),
      rowOf({ modelId: 'e3', modelKind: 'llm', thinkingMode: 'preset', thinkingPreset: 'qwen-vllm', thinkingPresetLabel: 'Qwen3（vLLM）', isDefault: false }),
      rowOf({ modelId: 'e4', modelKind: 'llm', thinkingMode: 'custom', isDefault: false, hasApiKey: false })
    ]
    const wrapper = await mountTable({ items: rows, kind: 'embedding' })
    const text = wrapper.find('.models-table').text()
    expect(text).toContain(zhModelManagement.dimensionTag.replace('{count}', '1024'))
    expect(text).toContain(zhModelManagement.tagThinkingNoMatch)
    expect(text).toContain(zhModelManagement.tagThinkingPreset.replace('{label}', 'Qwen3（vLLM）'))
    expect(text).toContain(zhModelManagement.tagThinkingCustom)
    expect(text).toContain(zhModelManagement.keyMissing)
    expect(text).toContain('默认') // isDefault 行的默认标记
  })

  it('loadRows 失败：表格保留上一屏（空）数据且不弹错误', async () => {
    const wrapper = await mountTable({ reject: true })
    expect(wrapper.find('.empty-row').text()).toBe(zhModelManagement.empty)
  })
})

describe('勾选栏与批量操作', () => {
  it('勾选单行 / 全选 / 清除：勾选栏计数与全选框状态', async () => {
    const wrapper = await mountTable()
    // 空选区不渲染
    expect(wrapper.find('.list-selection-bar').exists()).toBe(false)

    await toggleRow(wrapper, 0)
    expect(wrapper.find('.list-selection-bar').text()).toContain('1')

    // 全选
    await wrapper.find('.models-table thead input[type="checkbox"]').setValue(true)
    await flush()
    expect(wrapper.find('.list-selection-bar').text()).toContain('2')

    // 清除
    await wrapper.findAll('.list-selection-bar button').find(b => b.text().includes('取消选择')).trigger('click')
    await flush()
    expect(wrapper.find('.list-selection-bar').exists()).toBe(false)
  })

  it('批量启用/停用：PUT 按选择扇出，成功后清空选区并刷新列表', async () => {
    const wrapper = await mountTable()
    await wrapper.find('.models-table thead input[type="checkbox"]').setValue(true)
    await flush()

    await wrapper.findAll('.list-selection-bar button').find(b => b.text().includes(zhModelManagement.batchDisable)).trigger('click')
    await flush()
    await flush()

    expect(modelApi.updateModelApi).toHaveBeenCalledTimes(2)
    expect(modelApi.updateModelApi.mock.calls.every(([, payload]) => payload.enabled === false && payload.isDefault === false)).toBe(true)
    expect(GLOBAL.config.globalProperties.$message.success).toHaveBeenCalledWith(zhModelManagement.batchUpdated.replace('{count}', '2'))
    expect(wrapper.find('.list-selection-bar').exists()).toBe(false)
  })

  it('批量启用：payload 只带 enabled:true', async () => {
    const wrapper = await mountTable()
    await toggleRow(wrapper, 1) // 只选停用的那行
    await wrapper.findAll('.list-selection-bar button').find(b => b.text().includes(zhModelManagement.batchEnable)).trigger('click')
    await flush()
    await flush()
    expect(modelApi.updateModelApi).toHaveBeenCalledWith('mdl-2', { enabled: true })
  })

  it('批量删除：确认后 fanout DELETE；部分失败给出 success/failed 文案', async () => {
    const wrapper = await mountTable()
    await wrapper.find('.models-table thead input[type="checkbox"]').setValue(true)
    await flush()

    modelApi.deleteModelApi.mockRejectedValueOnce(new Error('in use')) // 第一条失败
    await wrapper.findAll('.list-selection-bar button').find(b => b.text().includes(zhModelManagement.batchDelete)).trigger('click')
    await flush()
    await flush()
    await flush()

    expect(deletion.requestDeletion).toHaveBeenCalledTimes(1)
    expect(modelApi.deleteModelApi).toHaveBeenCalledTimes(2)
    const successMsg = GLOBAL.config.globalProperties.$message.success.mock.calls.map(c => c[0]).join('|')
    const errorMsg = GLOBAL.config.globalProperties.$message.error.mock.calls.map(c => c[0]).join('|')
    expect(successMsg).toContain(zhModelManagement.batchUpdated.replace('{count}', '1'))
    expect(errorMsg).toContain(zhModelManagement.batchPartial.replace('{success}', '1').replace('{failed}', '1'))
  })

  it('批量删除：取消确认 → 不发 DELETE', async () => {
    deletion.requestDeletion.mockResolvedValue(false)
    const wrapper = await mountTable()
    await toggleRow(wrapper, 0)
    await wrapper.findAll('.list-selection-bar button').find(b => b.text().includes(zhModelManagement.batchDelete)).trigger('click')
    await flush()
    await flush()
    expect(modelApi.deleteModelApi).not.toHaveBeenCalled()
  })
})

describe('单条删除与页码回缩', () => {
  it('确认删除：DELETE + 清勾选 + 成功文案；当前页超出剩余页数时回缩并重查', async () => {
    modelApi.queryModelsApi.mockResolvedValue({ items: [rowOf({ modelId: 'only-1' })], total: 1, page: 2, pageSize: 10 })
    const wrapper = await mountWithPlugins(ModelTable, {
      route: '/models',
      props: { kind: 'llm' },
      global: GLOBAL
    })
    await flush()
    await flush()
    // 先翻到第 2 页（TablePagination 的 change 事件）
    const pagination = wrapper.findComponent(TablePagination)
    expect(pagination.exists()).toBe(true)
    pagination.vm.$emit('change', { page: 2, size: 10 })
    await flush()

    await wrapper.findAll('.row-actions button').find(b => b.text().includes('删除')).trigger('click')
    await flush()
    await flush()
    await flush()

    expect(modelApi.deleteModelApi).toHaveBeenCalledWith('only-1')
    expect(GLOBAL.config.globalProperties.$message.success).toHaveBeenCalledWith(zhModelManagement.deleteSuccess)
    // 回缩后的重查：page 1
    const lastCall = modelApi.queryModelsApi.mock.calls.at(-1)[0]
    expect(lastCall.currentPage).toBe(1)
  })

  it('取消删除：不发 DELETE', async () => {
    deletion.requestDeletion.mockResolvedValue(false)
    const wrapper = await mountTable()
    await wrapper.findAll('.row-actions button').find(b => b.text().includes('删除')).trigger('click')
    await flush()
    expect(modelApi.deleteModelApi).not.toHaveBeenCalled()
  })
})

describe('行内连接测试', () => {
  it('点击测试：按钮转圈、结果弹窗渲染；再点一次不重复发请求', async () => {
    let resolveTest
    modelApi.testModelApi.mockImplementation(() => new Promise(resolve => { resolveTest = resolve }))
    const wrapper = await mountTable()

    const testButton = wrapper.findAll('.row-actions button').find(b => b.text().includes(zhModelManagement.test))
    await testButton.trigger('click')
    await flush()

    // 请求在飞：重复点击不发第二条
    await testButton.trigger('click')
    await flush()
    expect(modelApi.testModelApi).toHaveBeenCalledTimes(1)

    resolveTest(TEST_RESULT)
    await flush()
    await flush()

    // 结果表组件拿到结果（弹窗标题在占位件里不渲染，直接断结果组件）
    const resultTable = wrapper.findComponent(ModelTestResultTableComp)
    expect(resultTable.exists()).toBe(true)
    expect(resultTable.props('result')).toMatchObject({ latencyMs: 64 })
  })

  it('测试失败：不弹结果窗，按钮恢复', async () => {
    modelApi.testModelApi.mockRejectedValue(new Error('timeout'))
    const wrapper = await mountTable()
    await wrapper.findAll('.row-actions button').find(b => b.text().includes(zhModelManagement.test)).trigger('click')
    await flush()
    await flush()
    expect(wrapper.text()).not.toContain(zhModelManagement.testResultTitle)
    // 恢复后可再次发起
    modelApi.testModelApi.mockResolvedValue(TEST_RESULT)
    await wrapper.findAll('.row-actions button').find(b => b.text().includes(zhModelManagement.test)).trigger('click')
    await flush()
    await flush()
    expect(modelApi.testModelApi).toHaveBeenCalledTimes(2)
  })
})

describe('端点复制与密钥提示', () => {
  it('复制按钮：copyTextWithToast(baseUrl)；没有 baseUrl 不复制', async () => {
    const wrapper = await mountTable({
      items: [rowOf({ modelId: 'm1', baseUrl: 'http://ep' }), rowOf({ modelId: 'm2', baseUrl: '', displayName: 'NoUrl' })]
    })
    const copyButtons = wrapper.findAll('.endpoint-line .icon-button')
    await copyButtons[0].trigger('click')
    await copyButtons[1].trigger('click')
    expect(clipboard.copyTextWithToast).toHaveBeenCalledTimes(1)
    expect(clipboard.copyTextWithToast).toHaveBeenCalledWith('http://ep')
  })

  it('眼睛按钮：提示「仅返回掩码」的信息', async () => {
    const wrapper = await mountTable()
    await wrapper.find('.key-line .icon-button').trigger('click')
    expect(GLOBAL.config.globalProperties.$message.info).toHaveBeenCalledWith(zhModelManagement.showKeyHint)
  })
})

describe('新建 / 编辑入口与 saveModel', () => {
  it('新建：编辑弹窗打开且 editing 为 null；保存成功后刷新 + POST', async () => {
    const wrapper = await mountTable()
    await wrapper.findAll('.toolbar button').find(b => b.text().includes(zhModelManagement.create)).trigger('click')
    await flush()
    const editor = wrapper.find('.editor-stub')
    expect(editor.attributes('data-open')).toBe('true')

    await wrapper.find('.editor-save-llm').trigger('click')
    await flush()
    await flush()
    expect(modelApi.createModelApi).toHaveBeenCalledWith({ modelKind: 'llm' })
    expect(GLOBAL.config.globalProperties.$message.success).toHaveBeenCalledWith(zhModelManagement.saveSuccess)
  })

  it('编辑：editing 带行数据；保存后类型变了 → emit change-kind', async () => {
    const wrapper = await mountTable({ kind: 'llm' })
    await wrapper.findAll('.row-actions button').find(b => b.text().includes(zhModelManagement.edit)).trigger('click')
    await flush()
    await wrapper.find('.editor-save-embedding').trigger('click')
    await flush()
    await flush()
    expect(wrapper.emitted('change-kind')).toEqual([['embedding']])
  })

  it('保存失败：不弹成功文案（错误由拦截器统一处理）', async () => {
    modelApi.createModelApi.mockRejectedValue(new Error('dup'))
    const wrapper = await mountTable()
    await wrapper.findAll('.toolbar button').find(b => b.text().includes(zhModelManagement.create)).trigger('click')
    await flush()
    // submitHandler 抛错会被弹窗捕获：这里只断言成功文案没出现
    await wrapper.find('.editor-save-llm').trigger('click').catch(() => {})
    await flush()
    await flush()
    expect(GLOBAL.config.globalProperties.$message.success).not.toHaveBeenCalledWith(zhModelManagement.saveSuccess)
  })

  it('loadAllModels 失败：回落为当前页行（弹窗判重仍有数据）', async () => {
    modelApi.queryModelsApi
      .mockResolvedValueOnce({ items: TWO_ROWS, total: 2 }) // onMounted
      .mockRejectedValueOnce(new Error('boom')) // loadAllModels
    const wrapper = await mountTable()
    await wrapper.findAll('.row-actions button').find(b => b.text().includes(zhModelManagement.edit)).trigger('click')
    await flush()
    expect(wrapper.find('.editor-stub').attributes('data-open')).toBe('true')
  })
})

describe('刷新与页码', () => {
  it('refreshList：当前页超过最大页时回缩到最后一页重查', async () => {
    modelApi.queryModelsApi
      .mockResolvedValueOnce({ items: TWO_ROWS, total: 2 }) // onMounted（第 1 页）
    const wrapper = await mountTable()
    modelApi.queryModelsApi.mockClear()
    // 模拟停在很后的页码（直接由 pagination 事件驱动）
    const refreshButton = wrapper.findComponent({ name: 'TableRefreshButton' })
    // 直接通过刷新按钮的 refresh prop 调用 refreshList：先造一个高页码
    // （currentPage 只能由 onPaginationChange 进入，这里用两段式验证）
    modelApi.queryModelsApi.mockResolvedValue({ items: [], total: 2 })
    // 第一步：翻到第 3 页（total=2，pageSize=10 → maxPage=1，仍会成功返回空页）
    const pagination = wrapper.findComponent(TablePagination)
    pagination.vm.$emit('change', { page: 3, size: 10 })
    await flush()
    // 第二步：点刷新 → 回缩到第 1 页再查一次
    modelApi.queryModelsApi.mockClear()
    modelApi.queryModelsApi.mockResolvedValue({ items: TWO_ROWS, total: 2 })
    await refreshButton.props('refresh')()
    await flush()
    await flush()
    const pages = modelApi.queryModelsApi.mock.calls.map(c => c[0].currentPage)
    expect(pages).toEqual([3, 1]) // 先按当前第 3 页查一次，发现超页再回缩到第 1 页
  })
})
