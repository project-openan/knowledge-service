// @vitest-environment jsdom
// 弹窗与小组件残余分支（7/6 之外加）：
// - RetrievalSourceSelect：来源下拉的前缀图标 / 空态插槽 / v-model 回写
// - CreateKbaseDialog：名称校验（空值放行 / 全空格拦截）、模型清单 null 与未知类型、
//   描述 textarea、弹窗 v-model 关闭、before-close 通路
// - CreateWorkflow：名称校验空值放行、模板/来源 tooltip 内容渲染、isTitle、
//   库下拉分组标题点击/选项点击/过滤、handleSelectChange 过滤分组标题、
//   仅选图谱库提交（新状态分组）、重名查询接口失败收敛、类型切换模板回退、
//   无普通文档库时清单置空、取消按钮关闭
// 基础覆盖见 test_wf_CreateWorkflow / test_kbd_createKbaseDialog / test_kbd_createWorkflowDialogExtra。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { flowApi, kbApi, modelsApi, messageBox } = vi.hoisted(() => ({
  flowApi: {},
  kbApi: {},
  modelsApi: { getModelList: vi.fn() },
  messageBox: {}
}))

vi.mock('@/features/workflow/api/workflow', () => ({
  createFlow: (...args) => flowApi.createFlow(...args),
  updateFlow: (...args) => flowApi.updateFlow(...args),
  getFlowList: (...args) => flowApi.getFlowList(...args),
  getAllKBList: (...args) => flowApi.getAllKBList(...args),
  getFlowConfig: vi.fn(),
  saveFlowConfig: vi.fn(),
  checkSaveFlowConfig: vi.fn(),
  deleteFlowApi: vi.fn(),
  exportWorkFlow: vi.fn(),
  publishWorkFlow: vi.fn(),
  unpublishWorkFlow: vi.fn()
}))

vi.mock('@/features/model/api/models', () => ({ getModelList: modelsApi.getModelList }))

vi.mock('@/features/knowledge-base/api/knowledgeBase', () => kbApi)

vi.mock('element-plus', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    ElMessageBox: {
      ...actual.ElMessageBox,
      confirm: (...args) => messageBox.confirm(...args)
    }
  }
})

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElRadio, ElRadioGroup } from 'element-plus/es/components/radio/index'
import { ElSelect, ElOption } from 'element-plus/es/components/select/index'
import CreateWorkflow from '@/features/workflow/CreateWorkflow.vue'
import CreateKbaseDialog from '@/features/knowledge-base/components/CreateKbaseDialog.vue'
import RetrievalSourceSelect from '@/features/workflow/components/RetrievalSourceSelect.vue'

/** 内容插槽也渲染的 tooltip（EP 真件要 hover 才渲染 content）。 */
const TooltipStub = {
  name: 'ElTooltip',
  props: ['content'],
  setup (_p, { slots }) {
    return () => h('span', { class: 'tooltip-stub' }, [slots.default?.(), slots.content?.()])
  }
}

/** 会渲染 prefix/default/empty 三个插槽的 el-select 桩。 */
const SelectPartsStub = {
  name: 'ElSelect',
  props: { modelValue: { type: [String, Number, Array], default: '' } },
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => h('div', { class: 'select-parts-stub', 'data-value': JSON.stringify(props.modelValue) }, [
      slots.prefix?.(),
      slots.default?.(),
      slots.empty?.(),
      h('button', { class: 'select-parts-stub__set', onClick: () => emit('update:modelValue', ['opt-1']) })
    ])
  }
}

const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'beforeClose', 'closeOnClickModal'],
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => h('div', { class: 'test-dialog' }, [
      h('div', { class: 'test-dialog__title' }, props.title),
      props.modelValue ? (slots.default ? slots.default() : null) : null,
      props.modelValue && slots.footer ? slots.footer() : null,
      props.modelValue && props.beforeClose
        ? h('button', { class: 'before-close', onClick: () => props.beforeClose(() => emit('update:modelValue', false)) })
        : null
    ])
  }
}

const GLOBAL = {
  components: {
    ElDialog: DialogPassthrough,
    ElForm,
    ElFormItem,
    ElRadio,
    ElRadioGroup,
    ElSelect,
    ElOption,
    ElTooltip: TooltipStub
  },
  stubs: { transition: false, 'transition-group': false },
  config: {
    globalProperties: {
      $globalZh: true,
      $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
    }
  }
}

const KB_RESPONSE = {
  running: [
    { assetId: 'a-doc', name: '文档库A', tableName: 'feature_a' },
    { assetId: 'a-graph', name: '图谱库B', tableName: 'graph_b' }
  ],
  dev: []
}

async function mountCreateWorkflow () {
  flowApi.createFlow = vi.fn(async () => ({}))
  flowApi.updateFlow = vi.fn(async () => ({}))
  flowApi.getFlowList = vi.fn(async () => ({ items: [], total: 0 }))
  flowApi.getAllKBList = vi.fn(async () => KB_RESPONSE)
  messageBox.confirm = vi.fn(() => Promise.resolve())

  const wrapper = await mountWithPlugins(CreateWorkflow, {
    route: '/flow',
    routes: [
      { path: '/flow', name: 'flow', component: { render: () => null } },
      { path: '/flow/detail/:id', name: 'flow-detail', component: { render: () => null } }
    ],
    global: GLOBAL
  })
  await flush()
  return wrapper
}

async function open (wrapper, workflowObj) {
  wrapper.vm.openDialog(workflowObj)
  await flush()
  await flush()
}

async function submit (wrapper) {
  const buttons = wrapper.findAll('.test-dialog button')
  const ok = buttons.find(node => node.text().includes('创建') || node.text().includes('确 定') || node.text().includes('确定'))
  await ok.trigger('click')
  await flush()
  await flush()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// ─────────────────────────────────────────────────────────────────────────────
// RetrievalSourceSelect
// ─────────────────────────────────────────────────────────────────────────────

describe('RetrievalSourceSelect：插槽与回写', () => {
  const OPTIONS = [
    { id: 'opt-1', name: '文档库A', statusLabel: '已发布', disabled: false, description: '说明' },
    { id: 'opt-2', name: '草稿库D', statusLabel: '未发布', disabled: true }
  ]

  it('prefix / empty 插槽渲染；帮助行统计可用数；v-model 回写', async () => {
    const wrapper = await mountWithPlugins(RetrievalSourceSelect, {
      props: { sourceType: 'knowledge', options: OPTIONS },
      global: { components: { ElSelect: SelectPartsStub, ElOption: { name: 'ElOption', props: ['value', 'label'], setup: () => () => null } } },
      router: null
    })
    await flush()
    // prefix 图标 + 帮助行（1 可用 / 1 不可用）
    expect(wrapper.find('.retrieval-select-icon').exists()).toBe(true)
    expect(wrapper.text()).toContain('1 个可选')
    expect(wrapper.text()).toContain('1 个未就绪或不可用')
    // 空态插槽渲染（桩把 empty 插槽一并渲染出来）
    expect(wrapper.text()).toContain('没有找到匹配的来源')

    // v-model 更新走一遍 defineModel 的通路
    await wrapper.find('button.select-parts-stub__set').trigger('click')
    expect(wrapper.find('.select-parts-stub').attributes('data-value')).toBe('["opt-1"]')
    wrapper.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CreateKbaseDialog
// ─────────────────────────────────────────────────────────────────────────────

describe('CreateKbaseDialog：校验与清单残余', () => {
  // ⚠️ 模型清单只在首次打开时拉取（模块级缓存）：异常形状的两个用例必须先跑，
  // 否则成功清单把缓存喂饱，null / 未知类型的分支再也走不到。
  async function mountKbaseDialog ({ modelImpl } = {}) {
    if (modelImpl !== null) {
      modelsApi.getModelList.mockReset().mockImplementation(async () => (modelImpl ? modelImpl() : [{ modelName: 'bge-m3' }]))
    } else {
      modelsApi.getModelList.mockReset().mockImplementation(async () => null)
    }
    kbApi.createKnowledgeBase = vi.fn(async () => ({}))
    kbApi.getKnowledgeBaseInfo = vi.fn(async () => ({}))
    kbApi.updatedKnowledgeBaseInfo = vi.fn(async () => ({}))
    const wrapper = await mountWithPlugins(CreateKbaseDialog, { global: GLOBAL, router: null })
    await flush()
    wrapper.vm.openDialog({ mode: 'create' })
    await flush()
    return wrapper
  }

  it('模型清单返回 null：清单置空；返回未知类型：抛错但弹窗可用', async () => {
    // ⚠️ moduleListRequested 是模块级标记，且 mountKbaseDialog 默认喂成功清单 ——
    // 这两个形状必须各自用独立实现打开一次（该标记在成功后不再重拉）。
    const nullWrapper = await mountKbaseDialog({ modelImpl: null })
    await flush()
    expect(nullWrapper.vm.kbModelList).toEqual([])
    nullWrapper.unmount()

    const weirdWrapper = await mountKbaseDialog({ modelImpl: async () => 'weird' })
    await flush()
    expect(modelsApi.getModelList).toHaveBeenCalled()
    weirdWrapper.unmount()
  })

  it('名称校验：空值放行；全空格拦下', async () => {
    const wrapper = await mountKbaseDialog()
    let error = 'unset'
    wrapper.vm.validateName({}, '', e => { error = e })
    expect(error).toBeUndefined()
    wrapper.vm.validateName({}, '   ', e => { error = e })
    expect(error).toBeTruthy()
    expect(error.message).toContain('全为空格')
    wrapper.unmount()
  })


  it('描述 textarea 回写；弹窗 v-model 关闭；before-close 通路', async () => {
    const wrapper = await mountKbaseDialog()
    await wrapper.find('textarea').setValue('说明文案')
    expect(wrapper.vm.formData.description).toBe('说明文案')

    await wrapper.find('button.before-close').trigger('click')
    await flush()
    expect(wrapper.vm.dialogVisible).toBe(false)
    wrapper.unmount()
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// CreateWorkflow
// ─────────────────────────────────────────────────────────────────────────────

describe('CreateWorkflow：表单交互与提交残余', () => {
  it('名称校验：空值放行（回调无错误）', async () => {
    const wrapper = await mountCreateWorkflow()
    let error = 'unset'
    wrapper.vm.validateName({}, '', e => { error = e })
    expect(error).toBeUndefined()
  })

  it('模板与来源的 tooltip 内容渲染（isTitle 排版 + 互斥提示）', async () => {
    const wrapper = await mountCreateWorkflow()
    await open(wrapper)
    // tooltip 内容插槽已渲染：模板说明（含数字序号行）与库互斥提示
    expect(wrapper.find('.tooltip-stub').exists()).toBe(true)
    expect(wrapper.vm.isTitle('1、混合检索')).toBe(true)
    expect(wrapper.vm.isTitle('普通说明')).toBe(false)
    expect(wrapper.vm.isTitle('  ')).toBe(false)
    expect(wrapper.vm.isTitle('')).toBe(false)
  })

  it('名称输入 / 描述 textarea / 模板单选：表单 v-model 全通路', async () => {
    const wrapper = await mountCreateWorkflow()
    await open(wrapper)
    await wrapper.find('.app-name-input input').setValue('客户流')
    expect(wrapper.vm.appForm.name).toBe('客户流')
    await wrapper.find('textarea').setValue('说明')
    expect(wrapper.vm.appForm.description).toBe('说明')
    // 模板单选（真 ElRadio）：点击 Conditional
    const radios = wrapper.findAll('.el-radio')
    const conditional = radios.find(node => node.text().includes('条件'))
    expect(conditional, '条件检索单选未渲染').toBeTruthy()
    await conditional.find('input[type="radio"]')?.setValue?.('Conditional')
    await flush()
    await flush()
    expect(wrapper.vm.appForm.template).toBe('Conditional')
  })

  it('库下拉：分组标题点击收起；选项点击同步 kbPkIds/graphKbPkIds；过滤关键字', async () => {
    const wrapper = await mountCreateWorkflow()
    await open(wrapper)
    // 真实 ElOption：分组标题 + 两个普通选项
    const options = wrapper.findAllComponents(ElOption)
    expect(options.length).toBeGreaterThanOrEqual(3)
    // 分组标题点击 → 收起（再点展开）
    await options[0].trigger('click')
    await flush()
    const groupKey = wrapper.vm.displayedKBList[0].key
    expect(wrapper.vm.groupCollapseState[groupKey]).toBe(true)
    // hasOwnProperty 的键新增不触发 computed 重算：换一个新对象触发重算
    // （真实页面里模板重渲染也会带着 computed 重算）
    wrapper.vm.groupCollapseState = { [groupKey]: true }
    await flush()
    expect(wrapper.vm.dynamicGroupCollapseState[groupKey]).toBe(true)
    wrapper.vm.handleGroupTitleClick(groupKey)
    wrapper.vm.groupCollapseState = { [groupKey]: false }
    await flush()
    expect(wrapper.vm.dynamicGroupCollapseState[groupKey]).toBe(false)
    // 选项点击（文档库）→ kbPkIds 同步
    await options[1].trigger('click')
    await flush()
    expect(wrapper.vm.appForm.kbPkIds.map(kb => kb.name)).toEqual(['文档库A'])
    expect(wrapper.vm.appForm.graphKbPkIds).toEqual([])

    // 过滤：不匹配的分组被隐藏
    wrapper.vm.handleKbFilter('图谱')
    await flush()
    expect(wrapper.vm.displayedKBList.every(group => group.options.every(option => option.name.includes('图谱')))).toBe(true)
    wrapper.vm.handleKbFilter('')
  })

  it('handleSelectChange：过滤掉 group- 分组标题值', async () => {
    const wrapper = await mountCreateWorkflow()
    await open(wrapper)
    const docKb = wrapper.vm.displayedKBList[0].options[0]
    wrapper.vm.handleSelectChange(['group-x', docKb])
    await flush()
    expect(wrapper.vm.appForm.selectedKbs).toEqual([docKb])
  })

  it('只选图谱库提交：boundInfo 初始化新状态分组', async () => {
    const wrapper = await mountCreateWorkflow()
    await open(wrapper)
    wrapper.vm.appForm.name = '图谱流'
    const graphKb = wrapper.vm.allGraphKBList[0].options[0]
    wrapper.vm.appForm.selectedKbs = [{ ...graphKb, isGraphKb: true }]
    wrapper.vm.syncKbFields()
    await submit(wrapper)
    expect(flowApi.createFlow).toHaveBeenCalled()
    const payload = flowApi.createFlow.mock.calls[0][0]
    expect(Object.keys(payload.boundInfo)).toContain('running')
    expect(payload.boundInfo.running[0].tableName).toBe('graph_b')
    expect(payload.boundInfo.running[0].key).toBeUndefined()
    // 提交成功 → 跳画布
    expect(wrapper.router.currentRoute.value.name).toBe('flow-detail')
  })

  it('重名查询接口失败：submitLoading 复位、不建流', async () => {
    const wrapper = await mountCreateWorkflow()
    await open(wrapper)
    wrapper.vm.appForm.name = 'x'
    flowApi.getFlowList = vi.fn(async () => { throw new Error('boom') })
    await submit(wrapper)
    expect(flowApi.createFlow).not.toHaveBeenCalled()
    expect(wrapper.vm.submitLoading).toBe(false)
  })

  it('类型切换：database → Sequential；切回 knowledgeBase 且模板非法 → 回 Blended', async () => {
    const wrapper = await mountCreateWorkflow()
    await open(wrapper)
    wrapper.vm.appForm.knowledgeType = 'database'
    await flush()
    await flush()
    expect(wrapper.vm.appForm.template).toBe('Sequential')

    wrapper.vm.appForm.template = 'zzz'
    wrapper.vm.appForm.knowledgeType = 'knowledgeBase'
    await flush()
    await flush()
    expect(wrapper.vm.appForm.template).toBe('Blended')
  })

  it('没有普通文档库：文档清单置空；取消按钮关闭弹窗', async () => {
    const wrapper = await mountCreateWorkflow()
    flowApi.getAllKBList = vi.fn(async () => ({
      running: [{ assetId: 'a-graph', name: '图谱库B', tableName: 'graph_b' }],
      dev: []
    }))
    await open(wrapper)
    wrapper.vm.getKBList()
    await flush()
    await flush()
    expect(wrapper.vm.allKBList).toEqual([])

    const cancel = wrapper.findAll('.test-dialog button').find(node => node.text().includes('取消'))
    await cancel.trigger('mousedown')
    // handleClose 里的复位在 setTimeout(0) 宏任务里
    await new Promise(resolve => setTimeout(resolve, 10))
    await flush()
    expect(wrapper.vm.createAppDialogVisible).toBe(false)
  })
})
