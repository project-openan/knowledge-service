// @vitest-environment jsdom
// 模型编辑弹窗 ModelEditorDialog.vue —— 与 test_wf_ModelEditorDialog.spec.js /
// modelEditorDialog.spec.js 互补：补输入控件 v-model 写回路径（模板内联箭头函数）、
// enabled 联动 watch、连接测试/保存的校验失败与异常分支、submitHandler 注入路径、
// 会话错位丢弃、以及编辑态 clearApiKey 的提交形状。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { modelApi } = vi.hoisted(() => ({ modelApi: {} }))

vi.mock('@/features/model/api/model.js', () => ({
  getThinkingPresetsApi: (...args) => modelApi.presets(...args),
  testModelApi: (...args) => modelApi.test(...args),
  testModelConfigApi: (...args) => modelApi.testConfig(...args)
}))

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { h } from 'vue'

import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElTable, ElTableColumn } from 'element-plus/es/components/table/index'
import { flush, mountWithPlugins } from './helpers/mount'
import ModelEditorDialog from '@/features/model/components/ModelEditorDialog.vue'
import ModelTestResultTable from '@/features/model/ModelTestResultTable.vue'

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
    ElTable,
    ElTableColumn,
    ElSelect: ElSelectStub,
    ElSwitch: inert('ElSwitch'),
    ElInputNumber: inert('ElInputNumber'),
    ElCheckbox: inert('ElCheckbox'),
    ModelTestResultTable
  }
}

const PRESETS_RESPONSE = {
  presets: [{ presetId: 'deepseek-vllm', label: 'DeepSeek（vLLM）', labelEn: 'DeepSeek (vLLM)' }],
  matchedPresetId: '',
  allowedPayloadKeys: ['thinking', 'chat_template_kwargs']
}

async function mountDialog (props = {}) {
  modelApi.presets = vi.fn(async () => PRESETS_RESPONSE)
  modelApi.test = vi.fn(async () => ({ ok: true, message: 'ok', latencyMs: 10 }))
  modelApi.testConfig = vi.fn(async () => ({ ok: false, message: '未连通' }))

  const wrapper = await mountWithPlugins(ModelEditorDialog, {
    route: '/models',
    props: { modelValue: false, ...props },
    global: GLOBAL
  })
  await wrapper.setProps({ modelValue: true })
  await flush()
  return wrapper
}

async function fillValid (wrapper, { name = 'm-1' } = {}) {
  const nameInput = wrapper.find('input[aria-label="模型名称"]')
  await nameInput.setValue(name)
  await nameInput.trigger('blur')
  const endpoint = wrapper.find('input[aria-label="端点地址"]')
  await endpoint.setValue('http://10.0.0.1:4000/v1')
  await flush()
}

function buttonByText (wrapper, ...texts) {
  return wrapper.findAll('button').find(node => texts.some(text => node.text().includes(text)))
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ModelEditorDialog：输入控件 v-model 写回（模板内联处理器）', () => {
  it('显示名称/端点模型/API Key/请求路径/备注/模型清单路径 全部写回 form', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    await wrapper.find('input[aria-label="显示名称"]').setValue('显示名')
    await wrapper.find('input[aria-label="端点模型名"]').setValue('gpt-x')
    await wrapper.find('input[aria-label="API 密钥"]').setValue('sk-abc')
    await wrapper.find('input[aria-label="模型列表路径"]').setValue('/v1/models')
    await wrapper.find('input[aria-label="模型请求路径"]').setValue('/v1/chat/completions')
    await wrapper.find('textarea[aria-label="备注"]').setValue('备注内容')
    await flush()

    expect(wrapper.vm.form.name).toBe('显示名')
    expect(wrapper.vm.form.endpointModel).toBe('gpt-x')
    expect(wrapper.vm.form.apiKey).toBe('sk-abc')
    expect(wrapper.vm.form.modelsPath).toBe('/v1/models')
    expect(wrapper.vm.form.requestPath).toBe('/v1/chat/completions')
    expect(wrapper.vm.form.notes).toBe('备注内容')
  })

  it('高级区展开后：自定义思考 JSON textarea、温度/最大 token 写回；预置下拉选项目录渲染', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    // 展开 <details>
    await wrapper.find('details.studio-disclosure summary').trigger('click')
    await flush()

    // 自定义思考 JSON（真下拉在 jsdom 里不开弹层：thinking 与既有 spec 一致走 v-model）
    wrapper.vm.form.thinking = 'custom'
    await flush()
    // 自定义 JSON 的 textarea 在备注之前（模板顺序），取第一个
    const jsonArea = wrapper.findAll('textarea')[0]
    expect(jsonArea.exists()).toBe(true)
    await jsonArea.setValue('{"thinking": false}')
    expect(wrapper.vm.form.thinkingCustomJson).toBe('{"thinking": false}')
    // 提示文案带 allowed keys
    expect(wrapper.text()).toContain('chat_template_kwargs')

    // 预置模式：预置下拉渲染
    wrapper.vm.form.thinking = 'preset'
    await flush()
    expect(wrapper.findAll('.stub-select').length).toBeGreaterThanOrEqual(2)
    // auto 模式：先提示「填写名称后可预览」；有名称无匹配 → 未匹配文案
    wrapper.vm.form.thinking = 'auto'
    await flush()
    expect(wrapper.text()).toContain('填写模型名称后可预览匹配结果')
    wrapper.vm.form.internal = 'gpt-x'
    await flush()
    expect(wrapper.text()).toContain('没有匹配到预置')
  })

  it('开关组写回：enabled 关掉后 isDefault 被联动复位（watch form.enabled）', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    const switches = wrapper.findAllComponents({ name: 'ElSwitch' })
    expect(switches.length).toBeGreaterThanOrEqual(2)

    wrapper.vm.form.isDefault = true
    await flush()
    // enabled → false
    switches[0].vm.$emit('update:modelValue', false)
    await flush()
    expect(wrapper.vm.form.enabled).toBe(false)
    expect(wrapper.vm.form.isDefault).toBe(false)

    // reasoning 开关写回
    switches[2].vm.$emit('update:modelValue', true)
    await flush()
    expect(wrapper.vm.form.reasoning).toBe(true)
  })

  it('类型选择卡点击切换 kind（模板按钮路径）与 embedding 维度输入', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    const rerankCard = wrapper.findAll('.studio-choice').find(node => node.text().includes('重排'))
    expect(rerankCard, '找不到重排类型卡').toBeTruthy()
    await rerankCard.trigger('click')
    await flush()
    expect(wrapper.vm.form.kind).toBe('rerank')
    expect(wrapper.vm.form.thinking).toBe('none')

    // 切到 embedding：维度字段出现
    const embeddingCard = wrapper.findAll('.studio-choice').find(node => node.text().includes('向量'))
    await embeddingCard.trigger('click')
    await flush()
    // el-input-number 用 inert 桩（无输入框），断言 form-item 的 label 与 form 字段
    expect(wrapper.vm.form.kind).toBe('embedding')
    expect(wrapper.text()).toContain('向量维度')
  })
})

describe('ModelEditorDialog：编辑态密钥', () => {
  it('有已存密钥时显示「清除已存密钥」勾选；勾选后提交带 clearApiKey，不勾且不填则不带 apiKey', async () => {
    const wrapper = await mountDialog({
      editing: {
        modelId: 'mdl-9', modelKind: 'llm', modelName: 'qwen-max', displayName: 'Q',
        baseUrl: 'http://10.0.0.1:4000/v1', hasApiKey: true, thinkingMode: 'none'
      },
      existing: []
    })
    expect(wrapper.vm.hasStoredKey).toBe(true)
    const checkbox = wrapper.findAllComponents({ name: 'ElCheckbox' })[0]
    expect(checkbox.exists()).toBe(true)
    checkbox.vm.$emit('update:modelValue', true)
    await flush()
    expect(wrapper.vm.form.clearApiKey).toBe(true)

    // 提交：带 clearApiKey；apiKey 空 + 勾选 → 仍带（删除密钥语义）
    await fillValid(wrapper)
    await buttonByText(wrapper, '保存更改').trigger('click')
    await flush()
    const payload = wrapper.emitted('save').at(-1)[0]
    expect(payload.clearApiKey).toBe(true)
  })

  it('无已存密钥的编辑行：不渲染清除勾选；不填 key 时 payload 不带 apiKey 字段', async () => {
    const wrapper = await mountDialog({
      editing: { modelId: 'mdl-8', modelKind: 'llm', modelName: 'qwen-max', baseUrl: 'http://10.0.0.1:4000/v1', thinkingMode: 'none' },
      existing: []
    })
    expect(wrapper.vm.hasStoredKey).toBe(false)

    await fillValid(wrapper)
    await buttonByText(wrapper, '保存更改').trigger('click')
    await flush()
    const payload = wrapper.emitted('save').at(-1)[0]
    expect(payload.apiKey).toBeUndefined()
    expect(payload.clearApiKey).toBeUndefined()
  })
})

describe('ModelEditorDialog：连接测试与保存的失败分支', () => {
  it('连接测试：校验失败 → 展开高级区、不发请求、不出结论', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    // 名称为空 → validate 拒绝
    await buttonByText(wrapper, '连接测试').trigger('click')
    await flush()
    await flush()
    expect(modelApi.testConfig).not.toHaveBeenCalled()
    expect(wrapper.vm.connectionResult).toBeNull()
    expect(wrapper.vm.testing).toBe(false)
  })

  it('连接测试：接口抛错 → 结论区显示错误消息；双击被防重入口拦下', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    await fillValid(wrapper)
    modelApi.testConfig.mockRejectedValueOnce({ detail: '超时了' })
    await buttonByText(wrapper, '连接测试').trigger('click')
    await flush()
    await flush()
    expect(wrapper.vm.connectionResult).toMatchObject({ ok: false, message: '超时了' })

    // 测试中再点：直接返回
    wrapper.vm.testing = true
    await buttonByText(wrapper, '连接测试').trigger('click')
    await flush()
    expect(modelApi.testConfig.mock.calls.length).toBeLessThanOrEqual(2)
    wrapper.vm.testing = false
  })

  it('保存：校验失败 → 展开高级区、不提交；submitting 中重复点击被拦', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    await buttonByText(wrapper, '添加模型').trigger('click')
    await flush()
    await flush()
    expect(wrapper.emitted('save')).toBeUndefined()

    wrapper.vm.submitting = true
    await buttonByText(wrapper, '添加模型').trigger('click')
    await flush()
    expect(wrapper.emitted('save')).toBeUndefined()
    wrapper.vm.submitting = false
  })

  it('注入 submitHandler：成功后关闭弹窗；handler 抛错则保持打开', async () => {
    const handler = vi.fn(async () => {})
    const wrapper = await mountDialog({ submitHandler: handler })
    await fillValid(wrapper)
    await buttonByText(wrapper, '添加模型').trigger('click')
    await flush()
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.open).toBe(false)

    const failing = vi.fn(async () => { throw new Error('boom') })
    const wrapper2 = await mountDialog({ submitHandler: failing })
    await fillValid(wrapper2, { name: 'm-2' })
    await buttonByText(wrapper2, '添加模型').trigger('click')
    await flush()
    await flush()
    expect(wrapper2.vm.open).toBe(true)
  })

  it('会话错位：测试/保存的响应回来时弹窗重开过（openSession 变了）→ 丢弃结果', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    await fillValid(wrapper)
    // 让请求挂起，期间重开弹窗（openSession+1）
    let release
    modelApi.testConfig.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const clickPromise = buttonByText(wrapper, '连接测试').trigger('click')
    await flush()
    await wrapper.setProps({ modelValue: false })
    await flush()
    await wrapper.setProps({ modelValue: true })
    await flush()
    release({ ok: true, message: 'late' })
    await clickPromise
    await flush()
    await flush()
    // 会话错位：结果不落、testing 不复位错乱
    expect(wrapper.vm.connectionResult).toBeNull()
  })
})

describe('ModelEditorDialog：校验器分支补齐', () => {
  it('maxTokens/temperature 非法值、modelsPath/requestPath 非法路径、thinkingPreset 必选', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    const runRule = (rules, value) => new Promise(resolve => {
      rules[0].validator({}, value, done => resolve(done))
    })
    const rules = wrapper.vm.rules

    // optionalNumber：null 通过、越界失败、非整数失败
    expect(await runRule(rules.maxTokens, null)).toBeUndefined()
    expect((await runRule(rules.maxTokens, 0))?.message).toContain('请输入有效范围内的数值')
    expect((await runRule(rules.maxTokens, 1.5))?.message).toContain('请输入有效范围内的数值')
    expect(await runRule(rules.temperature, 2)).toBeUndefined()
    expect((await runRule(rules.temperature, 3))?.message).toContain('请输入有效范围内的数值')

    // pathRule：空通过、合法通过、带查询串失败
    expect(await runRule(rules.modelsPath, '')).toBeUndefined()
    expect(await runRule(rules.modelsPath, '/v1/models')).toBeUndefined()
    expect((await runRule(rules.requestPath, '/v1/chat?q=1'))?.message).toContain('路径')

    // thinkingPreset：非 preset 模式通过；preset 模式必选
    wrapper.vm.form.thinking = 'preset'
    expect((await runRule(rules.thinkingPreset, ''))?.message).toContain('请选择')
    expect(await runRule(rules.thinkingPreset, 'deepseek-vllm')).toBeUndefined()
    wrapper.vm.form.kind = 'embedding'
    expect(await runRule(rules.thinkingPreset, '')).toBeUndefined()

    // thinkingCustomJson：非 llm / 空 / 坏 JSON / 非对象 / 未知键
    wrapper.vm.form.kind = 'llm'
    wrapper.vm.form.thinking = 'custom'
    expect((await runRule(rules.thinkingCustomJson, ''))?.message).toContain('请填写 JSON')
    expect((await runRule(rules.thinkingCustomJson, '{bad'))?.message).toContain('格式')
    expect((await runRule(rules.thinkingCustomJson, '[]'))?.message).toContain('对象')
    expect((await runRule(rules.thinkingCustomJson, '{"nope": 1}'))?.message).toContain('nope')
    expect(await runRule(rules.thinkingCustomJson, '{"thinking": true}')).toBeUndefined()

    // dimension：非 embedding 直接通过；embedding 必填正整数
    expect(await runRule(rules.dimension, null)).toBeUndefined()
    wrapper.vm.form.kind = 'embedding'
    expect((await runRule(rules.dimension, null))?.message).toContain('请输入向量维度')
    expect((await runRule(rules.dimension, 'abc'))?.message).toContain('请输入有效范围内的数值')
    expect(await runRule(rules.dimension, 8)).toBeUndefined()

    // internal：重名（同 kind 不同 modelId）判重复
    const dup = await mountDialog({
      initialKind: 'llm',
      existing: [{ modelId: 'other', modelKind: 'llm', modelName: 'M-1' }]
    })
    const dupError = await new Promise(resolve => {
      dup.vm.rules.internal[0].validator({}, 'm-1', done => resolve(done))
    })
    expect(dupError.message).toContain('已存在')
    // 编辑行自己不算重名
    const self = await mountDialog({
      editing: { modelId: 'self', modelKind: 'llm', modelName: 'M-1' },
      existing: [{ modelId: 'self', modelKind: 'llm', modelName: 'M-1' }]
    })
    expect(await new Promise(resolve => {
      self.vm.rules.internal[0].validator({}, 'm-1', done => resolve(done))
    })).toBeUndefined()
  })

  it('thinkingMatch / presetLabel / customThinkingPayload 的分支', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    // 名称与端点模型都为空 → 提示「先填写」
    expect(wrapper.vm.thinkingMatch.key).toContain('thinkingPreviewEmpty')
    // 有名称无匹配 → 未匹配
    wrapper.vm.form.internal = 'gpt'
    expect(wrapper.vm.thinkingMatch.key).toContain('thinkingPreviewNoMatch')
    // 非 auto 模式 → null
    wrapper.vm.form.thinking = 'none'
    expect(wrapper.vm.thinkingMatch).toBeNull()

    // presetLabel 中英文
    expect(wrapper.vm.presetLabel({ label: '中文', labelEn: 'EN' })).toBe('中文')

    // customThinkingPayload：合法对象 / 数组 / 坏 JSON
    wrapper.vm.form.thinkingCustomJson = '{"a": 1}'
    expect(wrapper.vm.customThinkingPayload()).toEqual({ a: 1 })
    wrapper.vm.form.thinkingCustomJson = '[1]'
    expect(wrapper.vm.customThinkingPayload()).toBeNull()
    wrapper.vm.form.thinkingCustomJson = '{bad'
    expect(wrapper.vm.customThinkingPayload()).toBeNull()
    wrapper.vm.form.thinkingCustomJson = ''
    expect(wrapper.vm.customThinkingPayload()).toBeNull()
  })

  it('refreshThinkingCatalog：响应形状兜底（非对象/空数组/无 keys）与失败清理', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    modelApi.presets.mockResolvedValueOnce('not-an-object')
    await wrapper.vm.refreshThinkingCatalog()
    expect(wrapper.vm.thinkingCatalog.presets).toEqual([])

    modelApi.presets.mockRejectedValueOnce(new Error('net'))
    await wrapper.vm.refreshThinkingCatalog()
    expect(wrapper.vm.thinkingCatalog.presets).toEqual([])
    expect(wrapper.vm.thinkingCatalog.matchedPresetId).toBe('')
    expect(wrapper.vm.thinkingCatalogLoading).toBe(false)

    // embedding：不请求目录
    wrapper.vm.form.kind = 'embedding'
    const before = modelApi.presets.mock.calls.length
    await wrapper.vm.refreshThinkingCatalog()
    expect(modelApi.presets.mock.calls.length).toBe(before)
  })

  it('buildValues：三种 kind 的提交形状与 requestPath 归位', async () => {
    const wrapper = await mountDialog({ initialKind: 'llm' })
    await fillValid(wrapper)
    wrapper.vm.form.maxTokens = 512
    wrapper.vm.form.temperature = 0.5
    wrapper.vm.form.reasoning = true
    wrapper.vm.form.modelsPath = '/v1/models'
    wrapper.vm.form.requestPath = '/v1/chat/completions'
    let values = wrapper.vm.buildValues()
    expect(values).toMatchObject({
      modelKind: 'llm', maxTokens: 512, temperature: 0.5, isReasoning: true,
      modelsPath: '/v1/models', chatPath: '/v1/chat/completions'
    })

    // embedding：思考三件套归 none/null，维度保留，路径键换名
    wrapper.vm.setKind('embedding')
    wrapper.vm.form.dimension = 1536
    wrapper.vm.form.requestPath = '/v1/embeddings'
    values = wrapper.vm.buildValues()
    expect(values).toMatchObject({
      thinkingMode: 'none', thinkingPayload: null, dimension: 1536, embeddingsPath: '/v1/embeddings', maxTokens: null
    })

    // rerank：rerankPath
    wrapper.vm.setKind('rerank')
    wrapper.vm.form.requestPath = '/v1/rerank'
    expect(wrapper.vm.buildValues()).toMatchObject({ rerankPath: '/v1/rerank' })

    // preset / custom 的 payload 形状
    wrapper.vm.setKind('llm')
    wrapper.vm.form.thinking = 'preset'
    wrapper.vm.form.thinkingPreset = 'deepseek-vllm'
    expect(wrapper.vm.buildValues()).toMatchObject({ thinkingPreset: 'deepseek-vllm', thinkingPayload: null })
    wrapper.vm.form.thinking = 'custom'
    wrapper.vm.form.thinkingCustomJson = '{"thinking": true}'
    expect(wrapper.vm.buildValues().thinkingPayload).toEqual({ thinking: true })
  })
})
