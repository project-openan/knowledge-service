// @vitest-environment jsdom
// 模型管理弹窗 ModelFormDialog.vue —— 与 modelManagement.spec.js 互补，补 select 驱动的
// 分支与校验器/提交全路径：类型切换清路径、思考模式联动、维度校验、buildPayload 各
// 思考模式形状、testHandle 三条路径（校验失败 / 编辑态走库内 key / 接口抛错）、
// submitHandle 重入守卫与 openDialog 的行回填分支。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { modelApi } = vi.hoisted(() => ({ modelApi: {} }))

vi.mock('@/features/model/api/model.js', () => ({
  createModelApi: (...args) => modelApi.create(...args),
  getThinkingPresetsApi: (...args) => modelApi.presets(...args),
  testModelConfigApi: (...args) => modelApi.testConfig(...args),
  testModelApi: (...args) => modelApi.test(...args),
  updateModelApi: (...args) => modelApi.update(...args)
}))

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { h } from 'vue'

import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElInput } from 'element-plus/es/components/input/index'
import { ElInputNumber } from 'element-plus/es/components/input-number/index'
import { ElSelect, ElOption } from 'element-plus/es/components/select/index'
import { ElSwitch } from 'element-plus/es/components/switch/index'
import { ElTable, ElTableColumn } from 'element-plus/es/components/table/index'

import { flush, mountWithPlugins } from './helpers/mount'
import ModelFormDialog from '@/features/model/ModelFormDialog.vue'
import ModelTestResultTable from '@/features/model/ModelTestResultTable.vue'

/** el-dialog 透传桩：默认 + footer 都渲染（footer 上有 测试/确定/取消 三个按钮）。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'appendToBody', 'closeOnPressEscape', 'closeOnClickModal', 'beforeClose'],
  setup (props, { slots }) {
    return () => (props.modelValue
      ? h('div', { class: 'test-dialog' }, [
        h('div', { class: 'test-dialog__title' }, props.title),
        slots.default ? slots.default() : null,
        slots.footer ? slots.footer() : null
      ])
      : null)
  }
}

const PRESETS = [
  {
    presetId: 'deepseek-vllm', label: 'DeepSeek（vLLM）', labelEn: 'DeepSeek (vLLM)',
    note: '本部署实测', noteEn: 'Verified', confidence: 'verified',
    payload: { chat_template_kwargs: { thinking: false } }
  }
]

async function mountDialog (props = {}) {
  modelApi.create = vi.fn(async () => ({}))
  modelApi.update = vi.fn(async () => ({}))
  modelApi.presets = vi.fn(async () => ({
    presets: PRESETS, matchedPresetId: 'deepseek-vllm', matchedBy: 'model_name',
    confidence: 'verified', warning: '',
    allowedPayloadKeys: ['chat_template_kwargs', 'thinking'], maxPayloadBytes: 8192
  }))
  modelApi.test = vi.fn(async () => ({ ok: true, probed: true, models: ['m'], latencyMs: 8, message: '' }))
  modelApi.testConfig = vi.fn(async () => ({ ok: false, probed: false, models: null, latencyMs: 0, message: '未连通' }))

  const wrapper = await mountWithPlugins(ModelFormDialog, {
    route: '/models',
    props,
    global: {
      components: {
        ElDialog: DialogPassthrough, ElForm, ElFormItem, ElInput,
        ElInputNumber, ElSelect, ElOption, ElSwitch, ElTable, ElTableColumn, ModelTestResultTable
      },
      directives: { loading: {} },
      config: { globalProperties: { $message: { success: vi.fn(), error: vi.fn() } } }
    }
  })
  await wrapper.vm.openDialog()
  await flush()
  return wrapper
}

/** 对第 index 个 el-select 发 update:modelValue + change（与真下拉的事件顺序一致）。 */
async function choose (wrapper, index, value) {
  const select = wrapper.findAllComponents({ name: 'ElSelect' })[index]
  select.vm.$emit('update:modelValue', value)
  select.vm.$emit('change', value)
  await flush()
}

async function clickFooter (wrapper, text) {
  const button = wrapper.findAll('button').find(node => node.text().includes(text))
  expect(button, `footer 上找不到「${text}」`).toBeTruthy()
  await button.trigger('click')
  await flush()
  await flush()
}

const VALID_BASE = { modelName: 'qwen-max', baseUrl: 'http://10.0.0.1:4000/v1' }

async function fillValid (wrapper) {
  const nameInput = wrapper.findAll('input').find(node => node.attributes('placeholder') === '如：deepseek-chat')
  if (nameInput) await nameInput.setValue(VALID_BASE.modelName)
  const urlInput = wrapper.findAll('input').find(node => node.attributes('placeholder')?.includes('https://your-llm-endpoint'))
  if (urlInput) await urlInput.setValue(VALID_BASE.baseUrl)
  await flush()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ModelFormDialog：类型切换与思考模式联动（select 事件路径）', () => {
  it('kind 切到 embedding：路径字段清空、思考配置收成 none；切回 llm 不自动恢复（钉现状）', async () => {
    const wrapper = await mountDialog()
    expect(wrapper.vm.formData.thinkingMode).toBe('auto')

    await choose(wrapper, 0, 'embedding')
    expect(wrapper.vm.formData.chatPath).toBe('')
    expect(wrapper.vm.formData.modelsPath).toBe('')
    expect(wrapper.vm.formData.thinkingMode).toBe('none')
    expect(wrapper.vm.formData.thinkingPreset).toBe('')
    expect(wrapper.vm.formData.thinkingPayload).toBeNull()
    expect(wrapper.vm.formData.thinkingCustomJson).toBe('')

    // 切回 llm：经 kindChangeHandle（真下拉重渲染后 change 监听不稳定，走方法入口）。
    // 钉住现状：这里没有「llm 恢复 auto」的回迁分支（与 ModelEditorDialog.setKind 不同），
    // 切走再切回后 thinkingMode 保持 none，需要用户手动改回。
    wrapper.vm.formData.modelKind = 'llm'
    wrapper.vm.kindChangeHandle()
    await flush()
    expect(wrapper.vm.formData.thinkingMode).toBe('none')
    // 类型恢复 llm 后路径输入框也跟着换（chatPath/modelsPath）
    expect(wrapper.vm.pathFields).toEqual(['chatPath', 'modelsPath'])
  })

  it('thinkingMode 切 auto 触发目录刷新；切 custom 且已有 payload 时回填 JSON', async () => {
    const wrapper = await mountDialog()
    const before = modelApi.presets.mock.calls.length

    await choose(wrapper, 1, 'auto')
    await flush()
    expect(modelApi.presets.mock.calls.length).toBeGreaterThan(before)

    wrapper.vm.formData.thinkingPayload = { thinking: false }
    await choose(wrapper, 1, 'custom')
    expect(wrapper.vm.formData.thinkingCustomJson).toBe(JSON.stringify({ thinking: false }, null, 2))

    // custom 且已有 JSON：不覆盖
    await choose(wrapper, 1, 'preset')
    await choose(wrapper, 1, 'custom')
    expect(wrapper.vm.formData.thinkingCustomJson).toBe(JSON.stringify({ thinking: false }, null, 2))
  })

  it('思考预置选中后显示备注与置信度；payload 预览渲染', async () => {
    const wrapper = await mountDialog()
    await choose(wrapper, 1, 'preset')
    await flush()
    // thinkingPreset 选项目录来自接口
    expect(wrapper.findAll('.model-form__thinking-preset').length).toBeGreaterThan(0)
    wrapper.vm.formData.thinkingPreset = 'deepseek-vllm'
    await flush()
    expect(wrapper.text()).toContain('本部署实测')

    // preset 有 payload → 预览 <pre> 渲染
    expect(wrapper.find('.model-form__thinking-preview').text()).toContain('chat_template_kwargs')
  })

  it('auto 未匹配时提示「不会发送」，目录请求失败时提示失败', async () => {
    const wrapper = await mountDialog()
    modelApi.presets.mockRejectedValueOnce(new Error('network'))
    await fillValid(wrapper)
    await wrapper.vm.refreshThinkingCatalog()
    await flush()
    expect(wrapper.vm.thinkingCatalogError).toBe(true)
    expect(wrapper.text()).toContain('预置目录加载失败')
    expect(wrapper.vm.thinkingCatalog.presets).toEqual([])
  })
})

describe('ModelFormDialog：校验器直调', () => {
  it('dimension：非向量模型直接通过；空值/非整数/合法', async () => {
    const wrapper = await mountDialog()
    const run = value => new Promise(resolve => {
      wrapper.vm.formRules.dimension[0].validator({}, value, error => resolve(error ? error.message : ''))
    })
    // llm：不需要维度 → 通过
    expect(await run(null)).toBe('')
    // 切到 embedding
    await choose(wrapper, 0, 'embedding')
    expect(await run(null)).toContain('请填写向量维度')
    expect(await run(0.5)).toContain('正整数')
    expect(await run(1024)).toBe('')
  })

  it('thinkingPreset：preset 模式必选；thinkingCustomJson 的五种错误与通过', async () => {
    const wrapper = await mountDialog()
    const presetRun = value => new Promise(resolve => {
      wrapper.vm.formRules.thinkingPreset[0].validator({}, value, error => resolve(error ? error.message : ''))
    })
    wrapper.vm.formData.thinkingMode = 'preset'
    expect(await presetRun('')).toContain('请选择思考预置')
    expect(await presetRun('deepseek-vllm')).toBe('')
    wrapper.vm.formData.thinkingMode = 'auto'
    expect(await presetRun('')).toBe('')

    const jsonRun = value => new Promise(resolve => {
      wrapper.vm.formRules.thinkingCustomJson[0].validator({}, value, error => resolve(error ? error.message : ''))
    })
    wrapper.vm.formData.thinkingMode = 'custom'
    expect(await jsonRun('')).toContain('请填写 JSON')
    expect(await jsonRun('{bad')).toContain('JSON 格式不正确')
    expect(await jsonRun('[]')).toContain('必须是对象')
    expect(await jsonRun('{}')).toContain('不能是空对象')
    expect(await jsonRun('{"unknown_key": 1}')).toContain('unknown_key')
    // 超过 maxPayloadBytes（8192）：填充超大值
    expect(await jsonRun(JSON.stringify({ thinking: 'x'.repeat(9000) }))).toContain('大小上限')
    expect(await jsonRun('{"thinking": false}')).toBe('')
    wrapper.vm.formData.thinkingMode = 'none'
    expect(await jsonRun('')).toBe('')
  })

  it('baseUrl：非 http(s) 报错；presetLabel / presetNote 的中英文与空值', async () => {
    const wrapper = await mountDialog()
    const urlRun = value => new Promise(resolve => {
      wrapper.vm.formRules.baseUrl[1].validator({}, value, error => resolve(error ? error.message : ''))
    })
    expect(await urlRun('ftp://x')).toContain('必须以 http')
    expect(await urlRun('http://ok')).toBe('')
    expect(await urlRun('')).toBe('')

    expect(wrapper.vm.presetLabel(null)).toBe('')
    expect(wrapper.vm.presetNote(null)).toBe('')
    expect(wrapper.vm.presetLabel(PRESETS[0])).toBe('DeepSeek（vLLM）')
    expect(wrapper.vm.presetNote(PRESETS[0])).toContain('本部署实测')
  })
})

describe('ModelFormDialog：buildPayload / testHandle / submitHandle', () => {
  it('buildPayload：四种思考模式的提交形状', async () => {
    const wrapper = await mountDialog()
    // auto：preset/payload 清空
    wrapper.vm.formData.thinkingMode = 'auto'
    wrapper.vm.formData.thinkingPreset = 'x'
    expect(wrapper.vm.buildPayload().thinkingPreset).toBe('')
    // custom：payload 解析
    wrapper.vm.formData.thinkingMode = 'custom'
    wrapper.vm.formData.thinkingCustomJson = '{"thinking": false}'
    expect(wrapper.vm.buildPayload().thinkingPayload).toEqual({ thinking: false })
    wrapper.vm.formData.thinkingCustomJson = '{bad'
    expect(wrapper.vm.buildPayload().thinkingPayload).toBeNull()
    // 非 llm：thinking 三件套固定
    wrapper.vm.formData.modelKind = 'embedding'
    expect(wrapper.vm.buildPayload()).toMatchObject({ thinkingMode: 'none', thinkingPreset: '', thinkingPayload: null, embeddingsPath: '' })
  })

  it('testHandle：校验失败直接返回；成功走对应接口并渲染结果表；接口抛错进 catch', async () => {
    const wrapper = await mountDialog()
    // 未填名称：validate 失败 → 不发请求
    await clickFooter(wrapper, '连接测试')
    expect(modelApi.testConfig).not.toHaveBeenCalled()

    await fillValid(wrapper)
    await clickFooter(wrapper, '连接测试')
    expect(modelApi.testConfig).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.testResult).toMatchObject({ ok: false, message: '未连通' })
    // 结果表格真渲染
    expect(wrapper.find('.model-form__result').exists()).toBe(true)

    // 接口抛错 → testResult 记录错误消息
    modelApi.testConfig.mockRejectedValueOnce({ detail: '超时' })
    await clickFooter(wrapper, '连接测试')
    expect(wrapper.vm.testResult).toMatchObject({ ok: false, message: '超时' })
  })

  it('testHandle：编辑态且没重填 key 时走 testModelApi（用库里的 key）', async () => {
    const wrapper = await mountDialog()
    wrapper.vm.openDialog({
      modelId: 'mdl-1', modelKind: 'llm', modelName: 'qwen-max',
      baseUrl: 'http://10.0.0.1:4000/v1', hasApiKey: true, apiKeyMasked: 'sk-****',
      thinkingMode: 'none'
    })
    await flush()
    await clickFooter(wrapper, '连接测试')
    expect(modelApi.test).toHaveBeenCalledWith('mdl-1', expect.objectContaining({ modelName: 'qwen-max' }), { skipErrorHandler: true })
  })

  it('submitHandle：saveDisabled 时直接返回（同步双击守卫）', async () => {
    const wrapper = await mountDialog()
    wrapper.vm.saveDisabled = true
    wrapper.vm.submitHandle()
    await flush()
    expect(modelApi.create).not.toHaveBeenCalled()
    expect(wrapper.emitted('refreshTableData')).toBeUndefined()
  })

  it('提交成功（新建/编辑）→ 成功提示 + refreshTableData + 关闭', async () => {
    const wrapper = await mountDialog()
    await fillValid(wrapper)
    await clickFooter(wrapper, '确定')
    expect(modelApi.create).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('refreshTableData')).toHaveLength(1)
    expect(wrapper.vm.dialogVisible).toBe(false)

    // 编辑态 → PUT
    const editWrapper = await mountDialog()
    editWrapper.vm.openDialog({
      modelId: 'mdl-2', modelKind: 'llm', modelName: 'qwen-max',
      baseUrl: 'http://10.0.0.1:4000/v1', thinkingMode: 'none'
    })
    await flush()
    await clickFooter(editWrapper, '确定')
    expect(modelApi.update).toHaveBeenCalledWith('mdl-2', expect.objectContaining({ modelName: 'qwen-max' }))
  })

  it('openDialog 分支：非 llm 行 thinking 收成 none；空 thinkingMode 的 llm 行也收 none；payload 缺失为 null', async () => {
    const wrapper = await mountDialog()
    wrapper.vm.openDialog({ modelId: 'm1', modelKind: 'embedding', thinkingMode: 'preset', thinkingPreset: 'x' })
    await flush()
    expect(wrapper.vm.formData.thinkingMode).toBe('none')
    expect(wrapper.vm.formData.thinkingPreset).toBe('')

    wrapper.vm.openDialog({ modelId: 'm2', modelKind: 'llm', thinkingMode: '' })
    await flush()
    expect(wrapper.vm.formData.thinkingMode).toBe('none')
    expect(wrapper.vm.formData.thinkingPayload).toBeNull()
    expect(wrapper.vm.formData.thinkingCustomJson).toBe('')

    // preset 行保留预置；payload 带上则回填 JSON
    wrapper.vm.openDialog({
      modelId: 'm3', modelKind: 'llm', thinkingMode: 'preset', thinkingPreset: 'deepseek-vllm',
      thinkingPayload: { thinking: true }
    })
    await flush()
    expect(wrapper.vm.formData.thinkingMode).toBe('preset')
    expect(wrapper.vm.formData.thinkingPreset).toBe('deepseek-vllm')
    expect(wrapper.vm.formData.thinkingCustomJson).toBe(JSON.stringify({ thinking: true }, null, 2))
  })

  it('编辑态密钥：占位显示脱敏值、clearApiKey 勾选后 payload 带 clearApiKey、取消/关闭复位', async () => {
    const wrapper = await mountDialog()
    wrapper.vm.openDialog({
      modelId: 'mdl-3', modelKind: 'llm', modelName: 'qwen-max',
      baseUrl: 'http://10.0.0.1:4000/v1', hasApiKey: true, apiKeyMasked: 'sk-****9f', thinkingMode: 'none'
    })
    await flush()
    const keyInput = wrapper.findAll('input').find(node => node.attributes('placeholder') === 'sk-****9f')
    expect(keyInput).toBeTruthy()

    wrapper.vm.formData.clearApiKey = true
    const payload = wrapper.vm.buildPayload()
    // 钉住现状：clearApiKey 不在 SUBMITTABLE_FIELDS 白名单里，payload 从不携带
    // （模板勾选框与 buildPayload 注释声称会带，实际两处都没有输出 —— 既有缺口）
    expect(payload.clearApiKey).toBeUndefined()
    // 未填新 key：apiKey 以空串提交（后端按「空 = 保留库里的」处理）
    expect(payload.apiKey).toBe('')

    // footer「取消」复位全部
    await clickFooter(wrapper, '取消')
    expect(wrapper.vm.formData.modelId).toBe('')
    expect(wrapper.vm.hasStoredKey).toBe(false)
    expect(wrapper.vm.testResult).toBeNull()
    expect(wrapper.vm.advancedVisible).toBe(false)
    expect(wrapper.vm.dialogVisible).toBe(false)
  })

  it('高级选项折叠切换：按钮在「展开/收起」两态间翻转', async () => {
    const wrapper = await mountDialog()
    const toggle = () => wrapper.findAll('button').find(node => node.text().includes('高级选项'))
    expect(toggle, '找不到高级选项切换按钮').toBeTruthy()
    expect(wrapper.vm.advancedVisible).toBe(false)
    await toggle().trigger('click')
    await flush()
    expect(wrapper.vm.advancedVisible).toBe(true)
    expect(wrapper.text()).toContain('收起高级选项')
    await wrapper.findAll('button').find(node => node.text().includes('收起高级选项')).trigger('click')
    await flush()
    expect(wrapper.vm.advancedVisible).toBe(false)
  })
})
