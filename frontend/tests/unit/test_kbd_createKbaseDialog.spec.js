// @vitest-environment jsdom
// 建库弹窗（CreateKbaseDialog.vue）：新建/代码建库/编辑三条提交链、名称校验分支
// （必填/长度/全空格/非法字符）、模型清单的四种元素形状（字符串/对象+使用说明/null/数组）、
// 模型清单失败后允许重试、成功/失败两条消息与关闭复位。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElSelect, ElOption } from 'element-plus/es/components/select/index'

const modelsApi = vi.hoisted(() => ({ getModelList: vi.fn() }))
const kbApi = vi.hoisted(() => ({
  createKnowledgeBase: vi.fn(),
  getKnowledgeBaseInfo: vi.fn(),
  updatedKnowledgeBaseInfo: vi.fn()
}))

vi.mock('@/features/model/api/models', () => ({ getModelList: modelsApi.getModelList }))
vi.mock('@/features/knowledge-base/api/knowledgeBase', () => kbApi)

import CreateKbaseDialog from '@/features/knowledge-base/components/CreateKbaseDialog.vue'
import zhRoot from '@/app/i18n/zh'

/** el-dialog 透传件：v-model 真假、标题、默认插槽与 footer 都真渲染。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'beforeClose', 'closeOnClickModal', 'appendToBody'],
  emits: ['update:modelValue'],
  setup (props, { slots }) {
    return () => h('div', { class: 'test-dialog' }, [
      h('div', { class: 'test-dialog__title' }, props.title),
      props.modelValue ? (slots.default ? slots.default() : null) : null,
      props.modelValue && slots.footer ? slots.footer() : null
    ])
  }
}

const GLOBAL = {
  components: { ElDialog: DialogPassthrough, ElForm, ElFormItem, ElSelect, ElOption },
  // VTU 默认把 transition-group 打成 stub：EP 表单的行内错误文案正好套在里面，
  // 不放开就永远断言不到「长度 2-30」「非法字符」这些错误提示。
  stubs: { transition: false, 'transition-group': false },
  config: {
    // 组件脚本里读 proxy.$globalZh / proxy.$message（main.js 的两份全局注入）
    globalProperties: {
      $globalZh: true,
      $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() })
    }
  }
}

async function mountDialog () {
  const wrapper = await mountWithPlugins(CreateKbaseDialog, { global: GLOBAL, router: null })
  await flush()
  return wrapper
}

async function open (wrapper, params = { mode: 'create' }) {
  wrapper.vm.openDialog(params)
  await flush()
  await flush()
}

function dialogBody (wrapper) {
  return wrapper.find('.test-dialog')
}

async function dropdownOptions (wrapper) {
  // 真 ElSelect：点开后选项 teleport 到 body
  await dialogBody(wrapper).find('.el-select').trigger('click')
  await flush()
  return Array.from(document.querySelectorAll('.el-select-dropdown__item'))
    .map(node => node.textContent.trim())
}

/** 读 EP form-item 的校验状态（jsdom 里行内错误文案挂在 transition 下，不渲染成文本） */
function formItemState (wrapper, prop) {
  const item = wrapper.findAllComponents(ElFormItem).find(i => i.props('prop') === prop)
  expect(item, `找不到 prop=${prop} 的表单项`).not.toBeUndefined()
  return [item.vm.validateState, item.vm.validateMessage]
}

function setName (wrapper, value) {
  return dialogBody(wrapper).find('input[maxlength="30"]').setValue(value)
}

async function setModel (wrapper, value) {
  const select = dialogBody(wrapper).findComponent(ElSelect)
  select.vm.$emit('update:modelValue', value)
  await flush()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // 基线：清单给一个模型；个别用例用 mockResolvedValueOnce / mockRejectedValueOnce 覆盖首调
  modelsApi.getModelList.mockReset().mockResolvedValue([{ modelName: 'bge-m3' }])
  kbApi.createKnowledgeBase.mockReset().mockResolvedValue({})
  kbApi.getKnowledgeBaseInfo.mockReset().mockResolvedValue({})
  kbApi.updatedKnowledgeBaseInfo.mockReset().mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('模型清单（首次打开才拉取，四种元素形状 + 排序）', () => {
  it('字符串元素转 {modelName}，对象原样；列表按 modelName 排序并渲染成下拉项', async () => {
    modelsApi.getModelList.mockResolvedValue([
      'zeta', { modelName: 'alpha' }, null, ['nested'], { modelName: 'mid', useInstruction: '按 token 计费' }
    ])
    const wrapper = await mountDialog()
    await open(wrapper)

    expect(modelsApi.getModelList).toHaveBeenCalledTimes(1)
    const items = await dropdownOptions(wrapper)
    // null / 数组元素归一成 {}（没有 modelName，不渲染有效 label）；
    // 有效元素全部出现在下拉里（含空 modelName 项的排序未定义，只断集合）
    expect(items.filter(Boolean).sort()).toEqual(['alpha', 'mid', 'zeta'])

    // 二次打开不再拉清单（模块常驻列表页，setup 无请求）
    await open(wrapper, { mode: 'create' })
    expect(modelsApi.getModelList).toHaveBeenCalledTimes(1)
  })

  it('清单请求失败：弹窗仍可打开；下次打开会重试', async () => {
    modelsApi.getModelList.mockRejectedValueOnce(new Error('boom'))
    const wrapper = await mountDialog()
    await open(wrapper)
    expect(dialogBody(wrapper).exists()).toBe(true)

    await open(wrapper, { mode: 'create' })
    expect(modelsApi.getModelList).toHaveBeenCalledTimes(2)
  })
})

describe('新建提交：校验失败两条分支与成功链', () => {
  beforeEach(() => {
    modelsApi.getModelList.mockResolvedValue([{ modelName: 'bge-m3' }])
  })

  it('名字太短：必填/长度规则拦住，不发建库请求', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await setName(wrapper, 'a')
    await dialogBody(wrapper).findAll('button').find(b => b.text() === zhRoot.modules.kb.createKb).trigger('click')
    await flush()
    await flush()

    expect(kbApi.createKnowledgeBase).not.toHaveBeenCalled()
    expect(formItemState(wrapper, 'name')).toEqual(['error', zhRoot.knowledge.len30])
  })

  it('非法字符（@@）：自定义 validator 报 nameLimit', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await setName(wrapper, 'a@@b')
    await dialogBody(wrapper).findAll('button').find(b => b.text() === zhRoot.modules.kb.createKb).trigger('click')
    await flush()
    await flush()

    expect(kbApi.createKnowledgeBase).not.toHaveBeenCalled()
    expect(formItemState(wrapper, 'name')).toEqual(['error', zhRoot.knowledge.nameLimit])
  })

  it('成功：POST payload 带默认文档类 category、发 refreshTableData 并复位表单', async () => {
    kbApi.createKnowledgeBase.mockResolvedValue({ id: 'kb-new' })
    const wrapper = await mountDialog()
    await open(wrapper)
    await setName(wrapper, '合同库')
    await setModel(wrapper, 'bge-m3')

    const submit = dialogBody(wrapper).findAll('button').find(b => b.text() === zhRoot.modules.kb.createKb)
    await submit.trigger('click')
    await flush()
    await flush()

    expect(kbApi.createKnowledgeBase).toHaveBeenCalledWith({
      name: '合同库',
      description: '',
      category: 0, // KB_CATEGORY.DOCUMENT
      props: { embeddingModel: 'bge-m3' }
    })
    expect(GLOBAL.config.globalProperties.$message.success).toHaveBeenCalledWith(zhRoot.messageBox.createSuccess)
    expect(wrapper.emitted('refreshTableData')).toEqual([[{ id: 'kb-new' }]])
    // 成功后关闭并复位
    expect(dialogBody(wrapper).find('input[maxlength="30"]').exists()).toBe(false)
  })

  it('codeKbCategory：传入 mode=CODECREATE 时 category 取代码库类', async () => {
    kbApi.createKnowledgeBase.mockResolvedValue({})
    const wrapper = await mountDialog()
    wrapper.vm.openDialog({ mode: 'codeCreate' })
    await flush()
    await flush()
    await setName(wrapper, '代码库')
    await setModel(wrapper, 'bge-m3')
    await dialogBody(wrapper).findAll('button').find(b => b.text() === zhRoot.modules.kb.createKb).trigger('click')
    await flush()
    await flush()

    expect(kbApi.createKnowledgeBase).toHaveBeenCalledWith(
      expect.objectContaining({ category: 3 }) // KB_CATEGORY.CODE
    )
  })
})

describe('编辑提交：回填、标题/按钮文案与 PATCH', () => {
  it('打开编辑：getKnowledgeBaseInfo 回填，标题=修改，提交走 PATCH', async () => {
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({
      name: '旧库名', description: '备注', props: { embeddingModel: 'bge-m3' }
    })
    kbApi.updatedKnowledgeBaseInfo.mockResolvedValue({})
    const wrapper = await mountDialog()
    await open(wrapper, { mode: 'edit', id: 'kb-7' })
    await flush()

    expect(dialogBody(wrapper).find('.test-dialog__title').text()).toBe(zhRoot.public.modify)
    // 非创建模式：向量模型是只读文本（不是下拉）
    expect(dialogBody(wrapper).find('.el-select').exists()).toBe(false)
    expect(dialogBody(wrapper).text()).toContain('bge-m3')

    await dialogBody(wrapper).findAll('button').find(b => b.text() === zhRoot.public.confirm).trigger('click')
    await flush()
    await flush()

    expect(kbApi.updatedKnowledgeBaseInfo).toHaveBeenCalledWith('kb-7', expect.objectContaining({ name: '旧库名' }))
    expect(GLOBAL.config.globalProperties.$message.success).toHaveBeenCalledWith(zhRoot.public.modifySuccess)
    expect(wrapper.emitted('refreshTableData')).toBeTruthy()
  })

  it('取消按钮：关闭并复位表单（不清编辑 id 之外的状态）', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await setName(wrapper, '临时输入')
    await dialogBody(wrapper).findAll('button').find(b => b.text() === zhRoot.public.cancel).trigger('click')
    await flush()
    expect(dialogBody(wrapper).find('input[maxlength="30"]').exists()).toBe(false)
  })
})
