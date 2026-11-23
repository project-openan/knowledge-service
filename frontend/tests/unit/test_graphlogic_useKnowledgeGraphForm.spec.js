// @vitest-environment jsdom
// 建图页表单 composable（features/graph/composables/useKnowledgeGraphForm.js）。
// 现有 knowledgeGraphForm.safe-back.spec.js 只盖 fetchKnowledgeGraphInfo 的错误分支，
// 这里补齐：validateName / loadEmbeddingModels / handleOperatorChange / handleBuild。
// composable 需要 setup 上下文（getCurrentInstance），用探针组件挂载（同 safe-back spec）。
import { vi, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { mountWithPlugins } from './helpers/mount'

vi.mock('@/features/model/api/models', () => ({ getModelList: vi.fn() }))
vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  getKnowledgeGraphBasicInfoApi: vi.fn(),
  updateKnowledgeGraphExtractApi: vi.fn()
}))
// handleBuild 的 toast 走全局 message 单例（不是 proxy.$message）
vi.mock('@/shared/lib/message', () => ({
  default: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

import { getModelList } from '@/features/model/api/models'
import { getKnowledgeGraphBasicInfoApi, updateKnowledgeGraphExtractApi } from '@/features/graph/api/knowledgeGraph'
import message from '@/shared/lib/message'
import { useKnowledgeGraphForm } from '@/features/graph/composables/useKnowledgeGraphForm'

function makeMessageMock () {
  return { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
}

async function setupForm () {
  let form = null
  const Probe = defineComponent({
    setup () {
      form = useKnowledgeGraphForm()
      return () => null
    }
  })
  const messageMock = makeMessageMock()
  await mountWithPlugins(Probe, {
    route: '/graph/edit/kb-1',
    global: { mocks: { $message: messageMock } }
  })
  return { form, messageMock }
}

/** 收集 validateName 的回调结果。 */
function runValidator (validator, value) {
  const errors = []
  validator({}, value, (error) => {
    if (error) { errors.push(error.message) }
  })
  return errors
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('表单校验规则', () => {
  it('name 必填 + 自定义校验器，description 限长 1000', async () => {
    const { form } = await setupForm()
    expect(form.formRules.name[0].required).toBe(true)
    expect(typeof form.formRules.name[1].validator).toBe('function')
    expect(form.formRules.description[0].max).toBe(1000)
  })

  it('validateName：空值放行（必填规则负责），全空格 / 非法字符 / 长度越界报错', async () => {
    const { form } = await setupForm()
    const validator = form.formRules.name[1].validator
    expect(runValidator(validator, '')).toEqual([])
    expect(runValidator(validator, '   ')).toHaveLength(1)
    expect(runValidator(validator, 'a/b')).toHaveLength(1)
    expect(runValidator(validator, 'a')).toHaveLength(1)
    expect(runValidator(validator, 'a'.repeat(31))).toHaveLength(1)
    expect(runValidator(validator, 'ab')).toEqual([])
    expect(runValidator(validator, 'a'.repeat(30))).toEqual([])
  })
})

describe('loadEmbeddingModels', () => {
  it('字符串 / 对象混合列表 → 归一为带 modelName 的对象，无效项剔除', async () => {
    const { form } = await setupForm()
    getModelList.mockResolvedValue([
      'raw-model',
      { modelName: 'obj-model', recommended: true },
      { name: 'no-modelname' },
      42,
      null,
      []
    ])
    await form.loadEmbeddingModels()
    expect(form.embeddingModelList.value).toEqual([
      { modelName: 'raw-model' },
      { modelName: 'obj-model', recommended: true }
    ])
  })

  it('非数组响应 → 空列表；接口失败 → 空列表并记录错误', async () => {
    const { form } = await setupForm()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    getModelList.mockResolvedValue({ data: [] })
    await form.loadEmbeddingModels()
    expect(form.embeddingModelList.value).toEqual([])

    getModelList.mockRejectedValue(new Error('boom'))
    await form.loadEmbeddingModels()
    expect(form.embeddingModelList.value).toEqual([])
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('handleOperatorChange', () => {
  async function prepare () {
    const { form } = await setupForm()
    form.step2Form.config.template = 'tpl'
    form.step2Form.config.llmModel = 'llm'
    form.step2Form.config.prompt = 'p'
    return form
  }

  function makeLists (llmModelList) {
    return {
      operatorList: { value: [] },
      llmModelList: { value: llmModelList },
      dynamicParams: { stale: 'x', schemaId: 's1' },
      loadLLMModels: vi.fn(async () => {})
    }
  }

  it('先清空 step2 配置与动态参数', async () => {
    const form = await prepare()
    const lists = makeLists([])
    await form.handleOperatorChange(1, lists.operatorList, lists.llmModelList, lists.dynamicParams, lists.loadLLMModels)
    expect(form.step2Form.config).toEqual({
      operator: '',
      template: '',
      llmModel: '',
      prompt: ''
    })
    expect(lists.dynamicParams).toEqual({})
  })

  it('llm 参数：模型列表非空取首个 value（回退 id），空则回退算子默认值', async () => {
    const form = await prepare()

    const withModels = makeLists([{ value: 'llm-value' }, { id: 'second' }])
    withModels.operatorList.value = [{ id: 1, args: [{ argName: 'llm' }] }]
    await form.handleOperatorChange(1, withModels.operatorList, withModels.llmModelList, withModels.dynamicParams, withModels.loadLLMModels)
    expect(withModels.loadLLMModels).toHaveBeenCalledTimes(1)
    expect(withModels.dynamicParams.llm).toBe('llm-value')

    const withIds = makeLists([{ id: 'by-id' }])
    withIds.operatorList.value = [{ id: 1, args: [{ argName: 'llm', defaultValue: 'fallback' }] }]
    await form.handleOperatorChange(1, withIds.operatorList, withIds.llmModelList, withIds.dynamicParams, withIds.loadLLMModels)
    expect(withIds.dynamicParams.llm).toBe('by-id')

    const withoutModels = makeLists([])
    withoutModels.operatorList.value = [{ id: 1, args: [{ argName: 'llm', defaultValue: 'fallback' }] }]
    await form.handleOperatorChange(1, withoutModels.operatorList, withoutModels.llmModelList, withoutModels.dynamicParams, withoutModels.loadLLMModels)
    expect(withoutModels.dynamicParams.llm).toBe('fallback')

    const noDefault = makeLists([])
    noDefault.operatorList.value = [{ id: 1, args: [{ argName: 'llm' }] }]
    await form.handleOperatorChange(1, noDefault.operatorList, noDefault.llmModelList, noDefault.dynamicParams, noDefault.loadLLMModels)
    expect(noDefault.dynamicParams.llm).toBe('')
  })

  it('overlap / chunkSize 默认值转数字；其它命名参数取 defaultValue（缺失为空串）', async () => {
    const form = await prepare()
    const lists = makeLists([])
    lists.operatorList.value = [{
      id: 2,
      args: [
        { argName: 'chunkSize', defaultValue: '1024' },
        { argName: 'overlap', defaultValue: '64' },
        { argName: 'schemaId', defaultValue: 'tpl-9' },
        { argName: 'plain' }
      ]
    }]
    await form.handleOperatorChange(2, lists.operatorList, lists.llmModelList, lists.dynamicParams, lists.loadLLMModels)
    expect(lists.dynamicParams.chunkSize).toBe(1024)
    expect(lists.dynamicParams.overlap).toBe(64)
    expect(lists.dynamicParams.schemaId).toBe('tpl-9')
    expect(lists.dynamicParams.plain).toBe('')
  })

  it('数值参数缺 defaultValue：chunkSize 补 512、overlap 补 0；非法数值落 0', async () => {
    const form = await prepare()
    const lists = makeLists([])
    lists.operatorList.value = [{
      id: 3,
      args: [
        { argName: 'chunkSize' },
        { argName: 'overlap' },
        { argName: 'chunkSizeBad', defaultValue: 'NaN-ish', _for: 'chunkSize' }
      ]
    }]
    await form.handleOperatorChange(3, lists.operatorList, lists.llmModelList, lists.dynamicParams, lists.loadLLMModels)
    expect(lists.dynamicParams.chunkSize).toBe(512)
    expect(lists.dynamicParams.overlap).toBe(0)

    // 非法字符串经 parseInt 落 0：单独一轮验证 defaultValue 为非数字的 chunkSize
    const bad = makeLists([])
    bad.operatorList.value = [{ id: 4, args: [{ argName: 'chunkSize', defaultValue: 'NaN-ish' }] }]
    await form.handleOperatorChange(4, bad.operatorList, bad.llmModelList, bad.dynamicParams, bad.loadLLMModels)
    expect(bad.dynamicParams.chunkSize).toBe(0)
  })

  it('找不到算子时（id 不匹配）按无参数处理', async () => {
    const form = await prepare()
    const lists = makeLists([])
    lists.operatorList.value = [{ id: 1, args: [{ argName: 'x' }] }]
    await form.handleOperatorChange(999, lists.operatorList, lists.llmModelList, lists.dynamicParams, lists.loadLLMModels)
    expect(lists.dynamicParams).toEqual({})
  })
})

describe('handleBuild', () => {
  function makeRefs (canBuild = true) {
    const uploaded = [
      { raw: new File(['a'], 'a.txt') },
      new File(['b'], 'b.txt') // 无 raw 时直接用文件本体
    ]
    return {
      canBuild: { value: canBuild },
      uploadedFiles: { value: uploaded },
      deletedFiles: { value: ['gone.txt'] },
      remainingFiles: { value: ['keep.txt'] },
      dynamicParams: { chunkSize: 512, schemaId: 'tpl-1' },
      router: { push: vi.fn() }
    }
  }

  it('canBuild 为假：只警告不发请求', async () => {
    const { form } = await setupForm()
    const refs = makeRefs(false)
    await form.handleBuild(refs.canBuild, refs.uploadedFiles, refs.deletedFiles, refs.remainingFiles, refs.dynamicParams, refs.router)
    expect(message.warning).toHaveBeenCalledTimes(1)
    expect(updateKnowledgeGraphExtractApi).not.toHaveBeenCalled()
    expect(form.buildLoading.value).toBe(false)
  })

  it('构建成功：FormData 装文件与 payload，schemaId 上提到 payload，成功后跳图谱列表', async () => {
    const { form, messageMock } = await setupForm()
    form.knowledgeGraphId.value = 'kb-77'
    form.formData.name = '新图谱'
    form.formData.description = '描述'
    form.formData.embeddingModel = 'bge-m3'
    form.step2Form.config.operator = 'op-1'
    const refs = makeRefs(true)

    await form.handleBuild(refs.canBuild, refs.uploadedFiles, refs.deletedFiles, refs.remainingFiles, refs.dynamicParams, refs.router)

    const [kbId, fd] = updateKnowledgeGraphExtractApi.mock.calls[0]
    expect(kbId).toBe('kb-77')
    expect(fd.get('files').name).toBe('a.txt')
    expect(fd.getAll('files')).toHaveLength(2)
    expect(JSON.parse(fd.get('deleteFiles'))).toEqual(['gone.txt'])
    expect(JSON.parse(fd.get('localFiles'))).toEqual(['keep.txt'])
    expect(JSON.parse(fd.get('accessFiles'))).toEqual([])

    const payload = JSON.parse(fd.get('data'))
    expect(payload).toEqual({
      name: '新图谱',
      description: '描述',
      category: 10,
      props: { embeddingModel: 'bge-m3' },
      operatorId: 'op-1',
      coverFlag: true,
      schemaId: 'tpl-1',
      kwargs: { chunkSize: 512 }
    })

    expect(message.success).toHaveBeenCalledTimes(1)
    expect(refs.router.push).toHaveBeenCalledWith({ path: '/graph' })
    expect(form.buildLoading.value).toBe(false)
    expect(messageMock.error).not.toHaveBeenCalled()
  })

  it('无 schemaId 时 kwargs 保持原样；构建失败只记录日志并在 finally 复位 loading', async () => {
    const { form } = await setupForm()
    form.knowledgeGraphId.value = 'kb-1'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateKnowledgeGraphExtractApi.mockRejectedValue(new Error('server down'))
    const refs = makeRefs(true)
    delete refs.dynamicParams.schemaId

    await form.handleBuild(refs.canBuild, refs.uploadedFiles, refs.deletedFiles, refs.remainingFiles, refs.dynamicParams, refs.router)

    const payload = JSON.parse(updateKnowledgeGraphExtractApi.mock.calls[0][1].get('data'))
    expect(payload.schemaId).toBeUndefined()
    expect(payload.kwargs).toEqual({ chunkSize: 512 })
    expect(errorSpy).toHaveBeenCalled()
    expect(refs.router.push).not.toHaveBeenCalled()
    expect(form.buildLoading.value).toBe(false)
  })
})

describe('fetchKnowledgeGraphInfo 成功路径（错误分支见 safe-back spec）', () => {
  it('详情写入表单并返回响应；过期响应（路由已切换）丢弃不写表单', async () => {
    const { form } = await setupForm()
    getKnowledgeGraphBasicInfoApi.mockResolvedValue({
      data: { name: 'n1', description: 'd1', embeddingModel: 'm1' },
      schemaInfo: { entities: [] }
    })
    const route = { params: { id: 'kb-1' } }
    const res = await form.fetchKnowledgeGraphInfo(route, { back: vi.fn(), replace: vi.fn() })
    expect(res.data.name).toBe('n1')
    expect(form.formData).toEqual({ name: 'n1', description: 'd1', embeddingModel: 'm1' })
    expect(form.schemaInfo.value).toEqual({ entities: [] })
    expect(form.knowledgeGraphId.value).toBe('kb-1')

    // 连续切换：请求在途时路由 params.id 已被换掉（同一 route 对象）→ 过期响应丢弃
    let resolveApi
    getKnowledgeGraphBasicInfoApi.mockImplementation(() => new Promise(resolve => { resolveApi = resolve }))
    const inFlightRoute = { params: { id: 'kb-1' } }
    const inFlight = form.fetchKnowledgeGraphInfo(inFlightRoute, { back: vi.fn(), replace: vi.fn() })
    inFlightRoute.params.id = 'kb-2' // 用户切到另一张图
    resolveApi({ data: { name: 'late' } })
    expect(await inFlight).toBeNull()
    expect(form.formData.name).toBe('n1')
  })
})
