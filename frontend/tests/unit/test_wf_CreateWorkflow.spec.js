// @vitest-environment jsdom
// 新建知识检索弹窗（CreateWorkflow.vue）：新建/编辑两条提交链、名称校验分支、
// 重名拦截、知识库清单分组、来源类型切换（确认/取消）、模板与类型联动。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { flowApi, messageBox } = vi.hoisted(() => ({
  flowApi: {},
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

// ElMessageBox 只 mock confirm（类型切换确认），其余保留
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

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElRadio, ElRadioGroup } from 'element-plus/es/components/radio/index'
import { ElSelect, ElOption } from 'element-plus/es/components/select/index'
import { ElTooltip } from 'element-plus/es/components/tooltip/index'
import CreateWorkflow from '@/features/workflow/CreateWorkflow.vue'
import zhRoot from '@/app/i18n/zh'

const KB_RESPONSE = {
  running: [
    { assetId: 'a-doc', name: '文档库A', tableName: 'feature_a' },
    { assetId: 'a-graph', name: '图谱库B', tableName: 'graph_b' },
    { assetId: 'a-struct', name: '结构化库C', tableName: 'struct_c', type: 'struct_knowledge' }
  ],
  dev: [{ assetId: 'd-doc', name: '草稿库D', tableName: 'feature_d' }]
}

/** el-dialog 的透传件：默认插槽 + footer + 标题都要真渲染。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'beforeClose', 'closeOnClickModal'],
  setup (props, { slots }) {
    return () => h('div', { class: 'test-dialog' }, [
      h('div', { class: 'test-dialog__title' }, props.title),
      props.modelValue ? (slots.default ? slots.default() : null) : null,
      props.modelValue && slots.footer ? slots.footer() : null
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
    ElTooltip
  }
}

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/flow', name: 'flow', component: Blank },
  { path: '/flow/detail/:id', name: 'flow-detail', component: Blank }
]

async function mountDialog () {
  flowApi.createFlow = vi.fn(async () => ({}))
  flowApi.updateFlow = vi.fn(async () => ({}))
  flowApi.getFlowList = vi.fn(async () => ({ items: [], total: 0 }))
  flowApi.getAllKBList = vi.fn(async () => KB_RESPONSE)
  messageBox.confirm = vi.fn(() => Promise.resolve())

  const wrapper = await mountWithPlugins(CreateWorkflow, {
    route: '/flow',
    routes: ROUTES,
    global: {
      ...GLOBAL,
      config: {
        globalProperties: {
          $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
        }
      }
    }
  })
  await flush()
  return wrapper
}

function dialogBody (wrapper) {
  return wrapper.find('.test-dialog')
}

async function open (wrapper, workflowObj) {
  wrapper.vm.openDialog(workflowObj)
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

describe('openDialog：新建与编辑两条入口', () => {
  it('新建：生成 RAG_Workflow_xxxx 的 ID，弹窗打开', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    expect(dialogBody(wrapper).find('.test-dialog__title').text()).toBe(zhRoot.ragFlow.createWorkflow)
    expect(wrapper.vm.appForm.workFlowId).toMatch(/^RAG_Workflow_[0-9a-f]{4}$/)
    expect(wrapper.vm.appForm.template).toBe('Blended')
    // availableTemplates：文档知识库 3 种模板
    expect(wrapper.vm.availableTemplates.map(item => item.value)).toEqual(['Blended', 'Sequential', 'Conditional'])
  })

  it('编辑：合并 kbPkIds/graphKbPkIds 成 selectedKbs，结构化库 → Sequential 模板', async () => {
    const wrapper = await mountDialog()
    await open(wrapper, {
      name: '已有流',
      workFlowId: 'RAG_Workflow_ab12',
      template: 'Blended',
      description: '备注',
      kbPkIds: [{ assetId: 'a-doc', name: '文档库A', tableName: 'feature_a', status: 'running' }],
      graphKbPkIds: [{ assetId: 'a-graph', name: '图谱库B', tableName: 'graph_b', status: 'running' }]
    })
    expect(wrapper.vm.isEditMode).toBe(true)
    expect(wrapper.vm.appForm.selectedKbs).toHaveLength(2)
    expect(wrapper.vm.appForm.selectedKbs.filter(kb => kb.isGraphKb)).toHaveLength(1)
    expect(wrapper.vm.appForm.knowledgeType).toBe('knowledgeBase')
    expect(wrapper.vm.appForm.template).toBe('Blended')

    // 结构化库 → 推断为 database 类型且模板强制 Sequential
    const wrapper2 = await mountDialog()
    await open(wrapper2, {
      name: '结构化流',
      workFlowId: 'RAG_Workflow_cd34',
      kbPkIds: [{ assetId: 'a-struct', name: '结构化库C', tableName: 'struct_c', status: 'running', type: 'struct_knowledge' }],
      graphKbPkIds: []
    })
    expect(wrapper2.vm.appForm.knowledgeType).toBe('database')
    expect(wrapper2.vm.appForm.template).toBe('Sequential')
    // database 类型只有一个模板可选
    expect(wrapper2.vm.availableTemplates.map(item => item.value)).toEqual(['Sequential'])
  })
})

describe('提交链：create / update', () => {
  async function submitWith (wrapper, { name = '合法名称', selectedKbs = [], duplicate = false, workFlowId = null } = {}) {
    await open(wrapper)
    if (workFlowId) {
      wrapper.vm.appForm.workFlowId = workFlowId
    }
    wrapper.vm.appForm.name = name
    wrapper.vm.appForm.selectedKbs = selectedKbs
    flowApi.getFlowList = vi.fn(async () => ({
      items: duplicate ? [{ name, workFlowId: 'other-id' }] : [],
      total: 0
    }))
    await clickCreate(wrapper)
    await flush()
    await flush()
  }

  /** 点 footer 上的「创建 / 确认」主按钮（触发 ElForm.validate → createNewFlow）。 */
  async function clickCreate (wrapper) {
    const buttons = dialogBody(wrapper).findAll('button')
    const create = buttons.find(node => [zhRoot.ragFlow.create, zhRoot.public.confirm].includes(node.text().trim()))
    expect(create, 'footer 上找不到创建/确认按钮').toBeTruthy()
    await create.trigger('click')
  }

  it('合法提交：createFlow 带上按状态分组的 boundInfo，随后跳画布', async () => {
    const wrapper = await mountDialog()
    await submitWith(wrapper, {
      selectedKbs: [
        { assetId: 'a-doc', name: '文档库A', tableName: 'feature_a', status: 'running' },
        { assetId: 'a-graph', name: '图谱库B', tableName: 'graph_b', status: 'running' }
      ]
    })
    expect(flowApi.createFlow).toHaveBeenCalledTimes(1)
    const params = flowApi.createFlow.mock.calls[0][0]
    expect(params.name).toBe('合法名称')
    expect(params.workFlowId).toMatch(/^RAG_Workflow_/)
    expect(params.template).toBe('Blended')
    expect(params.knowledgeType).toBe('knowledgeBase')
    // boundInfo：running 分组去掉 key/status
    expect(params.boundInfo.running).toEqual([
      { assetId: 'a-doc', name: '文档库A', tableName: 'feature_a' },
      { assetId: 'a-graph', name: '图谱库B', tableName: 'graph_b' }
    ])
    // 创建成功跳画布
    expect(wrapper.router.currentRoute.value.name).toBe('flow-detail')
    expect(wrapper.vm.$message.success).toHaveBeenCalled()
  })

  it('重名拦截：不发 createFlow，提示换名', async () => {
    const wrapper = await mountDialog()
    await submitWith(wrapper, { selectedKbs: [{ assetId: 'a-doc', tableName: 'feature_a', status: 'running' }], duplicate: true })
    expect(flowApi.createFlow).not.toHaveBeenCalled()
    expect(wrapper.vm.$message.error).toHaveBeenCalledWith(zhRoot.ragFlow.nameDuplicate)
  })

  it('重名但同名同 ID（自己）：放行提交', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    const workFlowId = wrapper.vm.appForm.workFlowId
    wrapper.vm.appForm.name = '我的流'
    wrapper.vm.appForm.selectedKbs = [{ assetId: 'a-doc', tableName: 'feature_a', status: 'running' }]
    flowApi.getFlowList = vi.fn(async () => ({ items: [{ name: '我的流', workFlowId }], total: 1 }))
    await clickCreate(wrapper)
    await flush()
    await flush()
    expect(flowApi.createFlow).toHaveBeenCalledTimes(1)
  })

  it('名称校验分支：空格名 / 非法字符 / 过短都拦下', async () => {
    for (const badName of ['   ', '坏@名字', 'a']) {
      const wrapper = await mountDialog()
      await submitWith(wrapper, { name: badName, selectedKbs: [{ assetId: 'a-doc', tableName: 'feature_a', status: 'running' }] })
      expect(flowApi.createFlow, `「${badName}」不该提交`).not.toHaveBeenCalled()
      // ⚠️ 该环境下 EP 只落 is-error 视觉态，不渲染错误文案节点：钉「拦截 + is-error」
      expect(dialogBody(wrapper).find('.is-error').exists(), `「${badName}」应标红`).toBe(true)
    }
  })

  it('编辑提交：updateFlow（PATCH）成功后提示修改成功，不跳画布', async () => {
    const wrapper = await mountDialog()
    await open(wrapper, {
      name: '旧名',
      workFlowId: 'RAG_Workflow_ab12',
      template: 'Blended',
      kbPkIds: [{ assetId: 'a-doc', name: '文档库A', tableName: 'feature_a', status: 'running' }],
      graphKbPkIds: []
    })
    wrapper.vm.appForm.name = '旧名'
    wrapper.vm.appForm.selectedKbs = [{ assetId: 'a-doc', name: '文档库A', tableName: 'feature_a', status: 'running' }]
    flowApi.getFlowList = vi.fn(async () => ({ items: [], total: 0 }))
    await clickCreate(wrapper)
    await flush()
    await flush()
    expect(flowApi.updateFlow).toHaveBeenCalledTimes(1)
    expect(flowApi.createFlow).not.toHaveBeenCalled()
    expect(wrapper.vm.$message.success).toHaveBeenCalled()
    expect(wrapper.router.currentRoute.value.name).not.toBe('flow-detail')
  })
})

describe('知识库清单分组与模板联动', () => {
  it('Blended 模板：文档库 + 图谱库两组；草稿库(dev)也纳入可选', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    const merged = wrapper.vm.mergedKBList
    const keys = merged.map(group => group.key)
    expect(keys).toEqual(['dockb', 'graphKb'])
    // 运行库 + 草稿库都在文档组里
    const docNames = merged.find(group => group.key === 'dockb').options.map(option => option.name)
    expect(docNames).toEqual(['文档库A', '草稿库D'])
    expect(merged.find(group => group.key === 'graphKb').options.map(option => option.name)).toEqual(['图谱库B'])
  })

  it('切到 Sequential：图谱库分组隐藏', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    wrapper.vm.appForm.template = 'Sequential'
    await flush()
    expect(wrapper.vm.mergedKBList.map(group => group.key)).toEqual(['dockb'])
  })

  it('模板切走时把已选的图谱库从 selectedKbs 里清掉（watcher）', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    wrapper.vm.appForm.selectedKbs = [
      { assetId: 'a-doc', name: '文档库A', tableName: 'feature_a', isGraphKb: false },
      { assetId: 'a-graph', name: '图谱库B', tableName: 'graph_b', isGraphKb: true }
    ]
    wrapper.vm.appForm.template = 'Sequential'
    await flush()
    await flush()
    expect(wrapper.vm.appForm.selectedKbs.every(kb => !kb.isGraphKb)).toBe(true)
    expect(wrapper.vm.appForm.kbPkIds).toHaveLength(1)
    expect(wrapper.vm.appForm.graphKbPkIds).toEqual([])
  })

  it('来源类型切到数据库：确认后清空已选、模板固定 Sequential；取消则回退', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    wrapper.vm.appForm.selectedKbs = [{ assetId: 'a-doc', tableName: 'feature_a', isGraphKb: false }]
    await flush()

    // 确认
    messageBox.confirm = vi.fn(() => Promise.resolve())
    wrapper.vm.appForm.knowledgeType = 'database'
    await flush()
    await flush()
    expect(messageBox.confirm).toHaveBeenCalled()
    expect(wrapper.vm.appForm.selectedKbs).toEqual([])
    expect(wrapper.vm.appForm.template).toBe('Sequential')

    // 取消：先重新选库（上一步已清空已选），再切回文档类型
    wrapper.vm.appForm.selectedKbs = [{ assetId: 'a-doc', tableName: 'feature_a', isGraphKb: false }]
    messageBox.confirm = vi.fn(() => Promise.reject(new Error('cancel')))
    wrapper.vm.appForm.knowledgeType = 'knowledgeBase'
    await flush()
    await flush()
    expect(wrapper.vm.appForm.knowledgeType).toBe('database') // 回退到旧值
  })

  it('结构化库存在时才显示「数据库」入口（hasStructuredKbs）', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    expect(wrapper.vm.hasStructuredKbs).toBe(true)
    // 有结构化库时出现「数据库」单选项
    const radioNodes = dialogBody(wrapper).findAll('.el-radio')
    expect(radioNodes.some(node => node.text().includes(zhRoot.ragFlow.knowledgeTypeDb))).toBe(true)

    const wrapper2 = await mountDialog()
    // mountDialog 里会重置 mock：挂载后再换成「无结构化库」的清单
    flowApi.getAllKBList = vi.fn(async () => ({
      running: [{ assetId: 'a-doc', name: '文档库A', tableName: 'feature_a' }],
      dev: []
    }))
    await open(wrapper2)
    expect(wrapper2.vm.hasStructuredKbs).toBe(false)
    // 没有结构化库时，「数据库」单选项不渲染（只剩「知识库」一项）
    const radios = dialogBody(wrapper2).findAll('.el-radio')
    // 4 个单选项 = 知识库（来源类型）+ 3 个模板；没有「数据库」
    expect(radios.map(node => node.text().trim())).toEqual([
      zhRoot.ragFlow.knowledgeTypeKb, zhRoot.ragFlow.mixWorkflow, zhRoot.ragFlow.sequenceWorkflow, zhRoot.ragFlow.conditionWorkflow
    ])
  })

  it('知识库清单加载失败：保留空列表不挡弹窗', async () => {
    const wrapper = await mountDialog()
    flowApi.getAllKBList = vi.fn(async () => {
      throw new Error('x')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await open(wrapper)
    expect(wrapper.vm.mergedKBList).toEqual([])
    errorSpy.mockRestore()
  })
})
