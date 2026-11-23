// @vitest-environment jsdom
// 模型编辑弹窗（与 modelEditorDialog.spec 互补）：类型切换、分类别的提交形状、
// 编辑态密钥分支、连接测试三条路径、以及逐条校验规则的错误分支。
// 语言在导入期读取：钉成中文。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { modelApi } = vi.hoisted(() => ({ modelApi: {} }))

vi.mock('@/features/model/api/model.js', () => ({
  getThinkingPresetsApi: (...args) => modelApi.getThinkingPresets(...args),
  testModelApi: (...args) => modelApi.testModel(...args),
  testModelConfigApi: (...args) => modelApi.testModelConfig(...args)
}))

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElTable, ElTableColumn } from 'element-plus/es/components/table/index'
import ModelEditorDialog from '@/features/model/components/ModelEditorDialog.vue'
import zhModelManagement from '@/app/i18n/zh/modelManagement'

/** 用原生 select 代替 el-select，直接切换思考模式。 */
const ElSelectStub = {
  name: 'ElSelect',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  setup (props, { emit }) {
    return () => h('select', {
      class: 'stub-select',
      value: props.modelValue,
      onChange: event => emit('update:modelValue', event.target.value)
    })
  }
}

const inert = name => ({
  name,
  props: { modelValue: { type: [Boolean, Number, String], default: undefined } },
  emits: ['update:modelValue'],
  setup: () => () => h('span')
})

/** StudioDialog 内部的 el-dialog：helpers 的占位件不渲染 footer，这里透传 header/footer。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'class', 'style', 'alignCenter', 'appendToBody', 'destroyOnClose',
    'closeOnClickModal', 'closeOnPressEscape', 'showClose'],
  setup (props, { slots }) {
    return () => (props.modelValue
      ? h('div', { class: 'test-dialog' }, [
          slots.header ? slots.header({ titleId: 't' }) : null,
          slots.default ? slots.default() : null,
          slots.footer ? slots.footer() : null
        ])
      : null)
  }
}

const GLOBAL = {
  components: {
    ElDialog: DialogPassthrough,
    ElForm,
    ElFormItem,
    // 连接测试明细用真表格渲染（ModelTestResultTable 的列作用域插槽）
    ElTable,
    ElTableColumn,
    ElSelect: ElSelectStub,
    ElSwitch: inert('ElSwitch'),
    ElInputNumber: inert('ElInputNumber'),
    ElCheckbox: inert('ElCheckbox')
  }
}

const PRESETS_RESPONSE = {
  presets: [{ presetId: 'deepseek-vllm', label: 'DeepSeek（vLLM）', labelEn: 'DeepSeek (vLLM)' }],
  matchedPresetId: '',
  allowedPayloadKeys: ['thinking', 'chat_template_kwargs']
}

async function mountDialog (props = {}) {
  modelApi.getThinkingPresets = vi.fn(async () => PRESETS_RESPONSE)
  modelApi.testModel = vi.fn(async () => ({ ok: true, message: 'ok', latencyMs: 10 }))
  modelApi.testModelConfig = vi.fn(async () => ({ ok: false, message: '未连通' }))

  const wrapper = await mountWithPlugins(ModelEditorDialog, {
    route: '/models',
    props: { modelValue: false, ...props },
    global: GLOBAL
  })
  await wrapper.setProps({ modelValue: true })
  await flush()
  return wrapper
}

async function fill (wrapper, { name = 'm-1', endpoint = 'http://10.0.0.1:4000/v1', kind = null } = {}) {
  if (kind) {
    wrapper.vm.setKind(kind)
    await flush()
  }
  await wrapper.find(`input[aria-label="模型名称"]`).setValue(name)
  await wrapper.find(`input[aria-label="模型名称"]`).trigger('blur')
  await wrapper.find(`input[aria-label="端点地址"]`).setValue(endpoint)
  await flush()
}

async function clickTest (wrapper) {
  const buttons = wrapper.findAll('button')
  const test = buttons.find(node => node.text().includes('连接测试'))
  await test.trigger('click')
  await flush()
  await flush()
}

async function clickSave (wrapper) {
  const buttons = wrapper.findAll('button')
  const save = buttons.find(node => node.text().includes('添加模型') || node.text().includes('保存更改'))
  await save.trigger('click')
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

describe('setKind：类型切换的字段联动', () => {
  it('llm → embedding：思考配置清空成 none；embedding → llm：none 回到 auto', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    expect(wrapper.vm.form.thinking).toBe('auto')

    wrapper.vm.setKind('embedding')
    await flush()
    expect(wrapper.vm.form.kind).toBe('embedding')
    expect(wrapper.vm.form.thinking).toBe('none')
    expect(wrapper.vm.form.requestPath).toBe('')

    wrapper.vm.setKind('llm')
    await flush()
    // thinking 从 none 恢复为 auto
    expect(wrapper.vm.form.thinking).toBe('auto')

    // 同类型：no-op
    wrapper.vm.setKind('llm')
    expect(wrapper.vm.form.kind).toBe('llm')
  })

  it('llm → rerank：思考配置与自定义 JSON 一并清掉', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    wrapper.vm.form.thinking = 'preset'
    wrapper.vm.form.thinkingPreset = 'deepseek-vllm'
    wrapper.vm.form.requestPath = '/chat/completions'
    wrapper.vm.setKind('rerank')
    await flush()
    expect(wrapper.vm.form.thinking).toBe('none')
    expect(wrapper.vm.form.thinkingPreset).toBe('')
    expect(wrapper.vm.form.requestPath).toBe('')
  })
})

describe('buildValues：提交形状按类型收敛', () => {
  it('embedding：只带 dimension，无生成参数，路径写 embeddingsPath', async () => {
    const submitHandler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({ initialKind: 'embedding', submitHandler })
    wrapper.vm.form.dimension = 1024
    await fill(wrapper, { name: 'bge-m3' })
    await clickSave(wrapper)

    expect(submitHandler).toHaveBeenCalledTimes(1)
    const values = submitHandler.mock.calls[0][0]
    expect(values.modelKind).toBe('embedding')
    expect(values.dimension).toBe(1024)
    expect(values.maxTokens).toBeNull()
    expect(values.temperature).toBeNull()
    expect(values.thinkingMode).toBe('none')
    expect(values.embeddingsPath).toBe('')
    expect(values.chatPath).toBeUndefined()
  })

  it('llm：maxTokens/temperature 带出，路径写 chatPath', async () => {
    const submitHandler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({ initialKind: 'llm', submitHandler })
    wrapper.vm.form.maxTokens = 2048
    wrapper.vm.form.temperature = 0.7
    wrapper.vm.form.reasoning = true
    wrapper.vm.form.requestPath = '/chat/completions'
    await fill(wrapper, { name: 'qwen-max' })
    await clickSave(wrapper)

    const values = submitHandler.mock.calls[0][0]
    expect(values.modelKind).toBe('llm')
    expect(values.maxTokens).toBe(2048)
    expect(values.temperature).toBe(0.7)
    expect(values.isReasoning).toBe(true)
    expect(values.chatPath).toBe('/chat/completions')
    expect(values.modelsPath).toBe('')
  })

  it('编辑态：密钥留空 = 不改库里的 key；勾选清除才带 clearApiKey', async () => {
    const submitHandler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({
      submitHandler,
      editing: {
        modelId: 'mdl-1',
        modelKind: 'llm',
        modelName: 'qwen-max',
        displayName: 'Qwen',
        baseUrl: 'http://10.0.0.1:4000/v1',
        apiModel: 'qwen-max',
        hasApiKey: true,
        apiKeyMasked: 'sk-****',
        dimension: null,
        enabled: true,
        isDefault: true,
        isReasoning: false,
        thinkingMode: 'none',
        thinkingPayload: null,
        timeout: 60,
        chatPath: '/chat/completions',
        remark: '备注'
      }
    })
    await fill(wrapper, { name: 'qwen-max' })
    await clickSave(wrapper)

    const values = submitHandler.mock.calls[0][0]
    // 留空且未勾选清除：apiKey 字段被删掉
    expect(values.apiKey).toBeUndefined()
    expect(values.clearApiKey).toBeUndefined()
    expect(values.isDefault).toBe(true)
    expect(values.remark).toBe('备注')
    expect(values.timeout).toBe(60)

    // 勾选清除：带 clearApiKey（第一次保存已关弹窗：重新打开）
    await wrapper.setProps({ modelValue: false })
    await flush()
    await wrapper.setProps({ modelValue: true })
    await flush()
    wrapper.vm.form.clearApiKey = true
    await clickSave(wrapper)
    expect(submitHandler.mock.calls[1][0].clearApiKey).toBe(true)
  })

  it('llm + preset 思考：带 thinkingPreset；custom：解析 JSON payload', async () => {
    const submitHandler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({ initialKind: 'llm', submitHandler })
    await fill(wrapper, { name: 'qwen' })
    wrapper.vm.form.thinking = 'preset'
    wrapper.vm.form.thinkingPreset = 'deepseek-vllm'
    await clickSave(wrapper)
    expect(submitHandler.mock.calls[0][0].thinkingPreset).toBe('deepseek-vllm')
    expect(submitHandler.mock.calls[0][0].thinkingPayload).toBeNull()

    // preset 保存成功会关弹窗：重新打开（表单被重置，必填项要重填）再改 custom
    await wrapper.setProps({ modelValue: false })
    await flush()
    await wrapper.setProps({ modelValue: true })
    await flush()
    await fill(wrapper, { name: 'qwen' })
    wrapper.vm.form.thinking = 'custom'
    wrapper.vm.form.thinkingCustomJson = '{"thinking": {"type": "disabled"}}'
    await clickSave(wrapper)
    expect(submitHandler.mock.calls[1][0].thinkingPayload).toEqual({ thinking: { type: 'disabled' } })

    // 非法 JSON → payload null（保存成功会关弹窗，每次重新打开）
    await wrapper.setProps({ modelValue: false })
    await flush()
    await wrapper.setProps({ modelValue: true })
    await flush()
    await fill(wrapper, { name: 'qwen' })
    wrapper.vm.form.thinkingCustomJson = '{bad'
    await clickSave(wrapper)
    expect(submitHandler.mock.calls[2][0].thinkingPayload).toBeNull()

    await wrapper.setProps({ modelValue: false })
    await flush()
    await wrapper.setProps({ modelValue: true })
    await flush()
    await fill(wrapper, { name: 'qwen' })
    wrapper.vm.form.thinkingCustomJson = '[1,2]'
    await clickSave(wrapper)
    expect(submitHandler.mock.calls[3][0].thinkingPayload).toBeNull()
  })

  it('displayName 缺省用模型名；baseUrl 去尾斜杠', async () => {
    const submitHandler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({ initialKind: 'llm', submitHandler })
    await fill(wrapper, { name: 'qwen', endpoint: 'http://10.0.0.1:4000/v1/' })
    await clickSave(wrapper)
    const values = submitHandler.mock.calls[0][0]
    expect(values.displayName).toBe('qwen')
    expect(values.baseUrl).toBe('http://10.0.0.1:4000/v1')
  })
})

describe('校验规则：逐条错误分支', () => {
  async function expectInvalid (wrapper, { name = 'm-1', endpoint = 'http://10.0.0.1:4000/v1' } = {}) {
    await fill(wrapper, { name, endpoint })
    await clickSave(wrapper)
    return wrapper
  }

  it('同类型同名（排除自己）→ 重名错误', async () => {
    const wrapper = await mountDialog({
      existing: [
        { modelId: 'other', modelKind: 'llm', modelName: 'M-1' },
        { modelId: 'embedding-row', modelKind: 'embedding', modelName: 'm-1' }
      ],
      editing: { modelId: 'self', modelKind: 'llm', modelName: 'M-1', baseUrl: 'http://x' }
    })
    await fill(wrapper, { name: 'm-1' })
    await clickSave(wrapper)
    // 自己的名字（大小写不同）不判重
    expect(wrapper.text()).not.toContain(zhModelManagement.formNamePlaceholder)
  })

  it('端点非 http：端点错误', async () => {
    const submitHandler = vi.fn()
    const wrapper = await mountDialog({ submitHandler })
    await fill(wrapper, { name: 'm', endpoint: 'ftp://x' })
    await clickSave(wrapper)
    expect(submitHandler).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('端点')
  })

  it('embedding 缺维度：维度必填错误', async () => {
    const submitHandler = vi.fn()
    const wrapper = await mountDialog({ initialKind: 'embedding', submitHandler })
    await fill(wrapper, { name: 'bge' })
    await clickSave(wrapper)
    expect(submitHandler).not.toHaveBeenCalled()
  })

  it('路径字段必须以 / 开头（requestPath/modelsPath）', async () => {
    const submitHandler = vi.fn()
    const wrapper = await mountDialog({ initialKind: 'llm', submitHandler })
    await fill(wrapper, { name: 'qwen' })
    wrapper.vm.form.requestPath = 'chat/completions'
    await clickSave(wrapper)
    expect(submitHandler).not.toHaveBeenCalled()

    wrapper.vm.form.requestPath = '/chat/completions'
    wrapper.vm.form.modelsPath = 'models'
    await clickSave(wrapper)
    expect(submitHandler).not.toHaveBeenCalled()
  })

  it('custom 思考 JSON 的键不在白名单 → 键名错误；非对象 → 必须是对象', async () => {
    const submitHandler = vi.fn()
    const wrapper = await mountDialog({ initialKind: 'llm', submitHandler })
    await fill(wrapper, { name: 'qwen' })
    wrapper.vm.form.thinking = 'custom'
    wrapper.vm.form.thinkingCustomJson = '{"evil": 1}'
    await clickSave(wrapper)
    expect(submitHandler).not.toHaveBeenCalled()

    wrapper.vm.form.thinkingCustomJson = '"string"'
    await clickSave(wrapper)
    expect(submitHandler).not.toHaveBeenCalled()

    wrapper.vm.form.thinkingCustomJson = '{}'
    await clickSave(wrapper)
    expect(submitHandler).not.toHaveBeenCalled()

    wrapper.vm.form.thinkingCustomJson = '{"thinking": {"type": "disabled"}}'
    await clickSave(wrapper)
    expect(submitHandler).toHaveBeenCalledTimes(1)
  })

  it('preset 思考未选预置 → 必选错误', async () => {
    const submitHandler = vi.fn()
    const wrapper = await mountDialog({ initialKind: 'llm', submitHandler })
    await fill(wrapper, { name: 'qwen' })
    wrapper.vm.form.thinking = 'preset'
    wrapper.vm.form.thinkingPreset = ''
    await clickSave(wrapper)
    expect(submitHandler).not.toHaveBeenCalled()
  })
})

describe('checkConnection：三条路径与会话丢弃', () => {
  it('新建：打 testModelConfigApi；结果落 connectionResult', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    await fill(wrapper, { name: 'qwen' })
    await clickTest(wrapper)
    expect(modelApi.testModelConfig).toHaveBeenCalledTimes(1)
    expect(modelApi.testModel).not.toHaveBeenCalled()
    expect(wrapper.vm.connectionResult).toMatchObject({ ok: false, message: '未连通' })
  })

  it('编辑：打 testModelApi（用库里那把 key）', async () => {
    const wrapper = await mountDialog({
      editing: { modelId: 'mdl-9', modelKind: 'llm', modelName: 'qwen', baseUrl: 'http://x' }
    })
    await fill(wrapper, { name: 'qwen' })
    await clickTest(wrapper)
    expect(modelApi.testModel).toHaveBeenCalledWith('mdl-9', expect.anything(), { skipErrorHandler: true })
    expect(wrapper.vm.connectionResult.ok).toBe(true)
  })

  it('探测中重复点击：不发第二次', async () => {
    let resolveProbe = null
    const wrapper = await mountDialog({ initialKind: 'llm' })
    modelApi.testModelConfig = vi.fn(() => new Promise(resolve => {
      resolveProbe = resolve
    }))
    await fill(wrapper, { name: 'qwen' })
    await clickTest(wrapper)
    await clickTest(wrapper)
    expect(resolveProbe, '第一次探测没有发请求').toBeTruthy()
    resolveProbe({ ok: true, message: '' })
    await flush()
    expect(modelApi.testModelConfig).toHaveBeenCalledTimes(1)
  })

  it('思考目录接口失败：清掉旧匹配但不影响保存', async () => {
    const submitHandler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({ initialKind: 'llm', submitHandler })
    // 挂载后再让目录接口失败：刷新目录的 catch 分支要保留空目录
    modelApi.getThinkingPresets = vi.fn(async () => {
      throw new Error('down')
    })
    await fill(wrapper, { name: 'qwen' })
    await wrapper.find(`input[aria-label="模型名称"]`).trigger('blur')
    await flush()
    await clickSave(wrapper)
    expect(wrapper.vm.thinkingCatalog.presets).toEqual([])
    expect(submitHandler).toHaveBeenCalledTimes(1)
  })
})

describe('submit：submitHandler 缺省 / 抛错', () => {
  it('没有 submitHandler：emit save 并关弹窗', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    await fill(wrapper, { name: 'qwen' })
    await clickSave(wrapper)
    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.vm.open).toBe(false)
  })

  it('submitHandler 抛错：保持弹窗打开', async () => {
    const submitHandler = vi.fn(async () => {
      throw new Error('后端拒绝')
    })
    const wrapper = await mountDialog({ initialKind: 'llm', submitHandler })
    await fill(wrapper, { name: 'qwen' })
    await clickSave(wrapper)
    expect(wrapper.vm.open).toBe(true)
  })
})
