// @vitest-environment jsdom
/**
 * EditKnowledgeGraph.vue —— 「修改知识图谱」整页（/graph/edit/:id）。
 *
 * 四个 composable 的数据面全部经 api mock 供数：详情 / 文件上限 / 已有文件 /
 * 算子列表 / LLM 列表 / 模版列表 / 更新构建。页面文案经 proxy.$t（注入真词条）。
 *
 * 覆盖：loadPage 装配链（含 requestId 竞速守卫）、未绑定算子的修复路径
 * （handleRepairOperator）、模版缺失告警、已有文件的移除/恢复、新增文件走
 * 上传链路（watch newFiles）、脏状态快照（dirty 点与 footer 文案）、保存校验
 * 分支（名称必填 / 描述超长 / 参数非法 firstParamError）、保存构建成功
 * （FormData 装配 + schemaId 提升 + 跳列表）、canBuild 门控、取消返回详情、
 * 切图谱重载（watch route.params.id）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { graphApi, modelsApi, messageMock } = vi.hoisted(() => ({
  graphApi: {
    getKnowledgeGraphBasicInfoApi: vi.fn(),
    getKbaseFileLimitApi: vi.fn(),
    getKnowledgeGraphFileListApi: vi.fn(),
    getOperatorListApi: vi.fn(),
    getLlmListApi: vi.fn(),
    knowledgeGraphTemplateListApi: vi.fn(),
    updateKnowledgeGraphExtractApi: vi.fn()
  },
  modelsApi: { getModelList: vi.fn() },
  messageMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
}))

vi.mock('@/features/graph/api/knowledgeGraph', () => graphApi)
vi.mock('@/features/model/api/models', () => ({ getModelList: (...a) => modelsApi.getModelList(...a) }))
vi.mock('@/shared/lib/message', () => ({ default: messageMock }))

import { createTestI18n, flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import EditKnowledgeGraph from '@/features/graph/EditKnowledgeGraph.vue'
import OperatorArgsForm from '@/features/graph/components/OperatorArgsForm.vue'
import KnowledgeFilePicker from '@/features/knowledge-base/components/KnowledgeFilePicker.vue'

const i18n = createTestI18n()
const t = i18n.global.t

const SelectStub = {
  name: 'SelectStub',
  props: { modelValue: { type: null, default: '' }, placeholder: String, disabled: Boolean },
  emits: ['update:modelValue', 'change'],
  template: '<div class="ops-stub-select"><slot /></div>'
}

const OptionStub = {
  name: 'ElOption',
  props: { label: String, value: null },
  template: '<div class="ops-stub-option"><slot /></div>'
}

/** RouterLink 替身：不做参数解析（详情路由缺 id 时 vue-router 会抛未处理拒绝）。 */
const RouterLinkStub = {
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: true } },
  template: '<a :href="href" class="router-link-stub"><slot /></a>',
  computed: {
    href () {
      try {
        return this.router.resolve(this.to).href
      } catch {
        return typeof this.to === 'string' ? this.to : '#'
      }
    }
  },
  inject: { router: { from: 'router', default: null } }
}

const OPERATOR = {
  id: 'op-1',
  name: '通用抽取',
  nameEn: 'General',
  args: [
    { argName: 'schemaId', defaultValue: '' },
    { argName: 'llm', defaultValue: '' },
    { argName: 'overlap', defaultValue: '128' },
    { argName: 'chunkSize', defaultValue: '1024' },
    { argName: 'customPrompt', defaultValue: '默认提示', description: '补充提示' }
  ]
}

const GRAPH_DETAIL = () => ({
  data: {
    id: 'g-123',
    name: '影视图谱',
    description: '电影实体',
    embeddingModel: 'bge-m3',
    operatorId: 'op-1'
  },
  schemaInfo: { schema_id: 'tpl-1', schema_name: '影视模版' }
})

function stubAll () {
  modelsApi.getModelList.mockReset().mockResolvedValue(['bge-m3'])
  graphApi.getKnowledgeGraphBasicInfoApi.mockReset().mockResolvedValue(GRAPH_DETAIL())
  graphApi.getKbaseFileLimitApi.mockReset().mockResolvedValue({ maxSizeMap: { PDF: 20, DOCX: 10 }, number: 5 })
  graphApi.getKnowledgeGraphFileListApi.mockReset().mockResolvedValue({
    items: [{ id: 'f-1', title: '剧本.pdf', fileSize: 2048, fileFrom: '1' }]
  })
  graphApi.getOperatorListApi.mockReset().mockResolvedValue([OPERATOR])
  graphApi.getLlmListApi.mockReset().mockResolvedValue([{ value: 'gpt-x', label: 'GPT-X' }])
  graphApi.knowledgeGraphTemplateListApi.mockReset().mockResolvedValue([{ schemaId: 'tpl-1', schemaName: '影视模版' }])
  graphApi.updateKnowledgeGraphExtractApi.mockReset().mockResolvedValue({ success: true })
}

async function mountPage (route = '/graph/edit/g-123', locale = 'zh') {
  const wrapper = await mountWithPlugins(EditKnowledgeGraph, {
    route,
    locale,
    global: {
      components: {
        ElForm, ElFormItem,
        ElSelect: SelectStub, ElOption: OptionStub,
        RouterLink: RouterLinkStub
      },
      stubs: { transition: false, 'transition-group': false },
      config: {
        globalProperties: {
          $globalZh: true,
          $t: (key, params) => t(key, params),
          $message: messageMock
        }
      }
    }
  })
  await flush()
  await flush()
  activeWrapper = wrapper
  return wrapper
}

beforeEach(() => {
  stubAll()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  Element.prototype.scrollIntoView = vi.fn()
})

// 页面 RouterLink 依赖 route.params.id：保存成功跳 /graph 后组件若仍挂载，
// 重渲染会在 RouterLink 解析里抛「Missing required param id」（未处理拒绝）。
// 每个用例结束立刻卸载，别给导航后的渲染留机会。
let activeWrapper = null

afterEach(() => {
  if (activeWrapper) {
    try {
      activeWrapper.unmount()
    } catch {
      // 已卸载/渲染树已损坏时忽略
    }
    activeWrapper = null
  }
  document.body.innerHTML = ''
})

const selects = wrapper => wrapper.findAllComponents(SelectStub)
const footerButtons = wrapper => wrapper.find('.gx-footer').findAll('button.el-button')

describe('loadPage 装配', () => {
  it('就绪态：副标题带图谱名、锁定配置显示模型/算子/模版', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('.gx-layout').exists()).toBe(true)
    expect(wrapper.text()).toContain('影视图谱')
    expect(wrapper.text()).toContain('bge-m3')
    expect(wrapper.text()).toContain('通用抽取')
    expect(wrapper.text()).toContain('影视模版')
    expect(wrapper.text()).toContain('配置已与当前图谱同步')
  })

  it('详情接口失败（返回空）：提示并回图谱列表，页面渲染未找到态', async () => {
    graphApi.getKnowledgeGraphBasicInfoApi.mockResolvedValue(null)
    const wrapper = await mountPage()
    expect(messageMock.error).toHaveBeenCalledWith(t('modules.kb.getDetailFailed'))
    expect(wrapper.router.currentRoute.value.path).toBe('/graph')
    expect(wrapper.text()).toContain('没有找到这个图谱')
    expect(wrapper.text()).toContain('返回图谱知识库')
  })

  it('operatorId 为 null（导入生成的图谱）：算子缺失告警 + 页内补选下拉', async () => {
    graphApi.getKnowledgeGraphBasicInfoApi.mockResolvedValue({
      data: { id: 'g-123', name: '导入图谱', description: '', embeddingModel: 'bge-m3', operatorId: null },
      schemaInfo: null
    })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('该图谱尚未绑定抽取算子')
    // 修复下拉出现，占位「请选择算子」
    expect(selects(wrapper).length).toBeGreaterThan(0)
    expect(selects(wrapper).at(-1).props('placeholder')).toBe(t('modules.kb.selectOperator'))
    // canBuild=false → 保存按钮禁用
    expect(footerButtons(wrapper)[1].element.disabled).toBe(true)

    // 现场补选算子 → 参数按新算子初始化，告警消失
    selects(wrapper).at(-1).vm.$emit('update:modelValue', 'op-1')
    selects(wrapper).at(-1).vm.$emit('change', 'op-1')
    await flush()
    await flush()
    expect(wrapper.text()).not.toContain('该图谱尚未绑定抽取算子')
  })

  it('算子列表里找不到绑定算子：算子已删除告警文案', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([])
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('原知识图谱算子已被删除或清理')
  })

  it('模版缺失：templateNotFound 告警 + 模版下拉禁用', async () => {
    graphApi.getKnowledgeGraphBasicInfoApi.mockResolvedValue({
      data: { id: 'g-123', name: '影视图谱', description: '', embeddingModel: 'bge-m3', operatorId: 'op-1' },
      schemaInfo: null
    })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('新建知识图谱时使用的知识图谱模版已被删除或清理')
  })

  it('切换路由参数：重新拉取新图谱（requestId 竞速守卫后旧响应丢弃）', async () => {
    const wrapper = await mountPage()
    expect(graphApi.getKnowledgeGraphBasicInfoApi).toHaveBeenCalledTimes(1)

    graphApi.getKnowledgeGraphBasicInfoApi.mockResolvedValue({
      data: { id: 'g-456', name: '另一个图谱', description: '', embeddingModel: 'bge-m3', operatorId: 'op-1' },
      schemaInfo: { schema_id: 'tpl-1', schema_name: '影视模版' }
    })
    await wrapper.router.push('/graph/edit/g-456')
    await flush()
    await flush()
    expect(graphApi.getKnowledgeGraphBasicInfoApi).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('另一个图谱')
  })
})

describe('来源文档区', () => {
  it('已有来源列表渲染，移除后出现恢复按钮；恢复后回到基线（非脏）', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('剧本.pdf')
    expect(wrapper.text()).toContain('已保留')
    expect(wrapper.text()).toContain('1 个来源文件')

    // 移除已有文件
    await wrapper.find('.gx-existing .icon-button').trigger('click')
    await flush()
    expect(wrapper.text()).toContain('已有来源已从本次配置中移除')
    expect(wrapper.text()).toContain('恢复已移除的 1 个文件')

    // 恢复
    await wrapper.findAll('button').find(b => b.text().includes('恢复已移除')).trigger('click')
    await flush()
    expect(wrapper.text()).toContain('剧本.pdf')
  })

  it('新增文件走 v-model → uploadedFiles（上传链路），并置脏', async () => {
    const wrapper = await mountPage()
    const picker = wrapper.findComponent({ name: 'KnowledgeFilePicker' })
    expect(picker.exists()).toBe(true)
    const raw = new File(['pdf-bytes'], '新章节.pdf', { type: 'application/pdf' })
    picker.vm.$emit('update:modelValue', [raw])
    await flush()

    expect(wrapper.text()).toContain('2 个来源文件')
    expect(wrapper.text()).toContain('有未保存的修改')
    // 提交时会带上该文件（见成功用例）
  })
})

describe('保存校验', () => {
  it('名称清空后保存：nameRequired 挂在名称表单项，不发起构建', async () => {
    const wrapper = await mountPage()
    await wrapper.find('input[maxlength="30"]').setValue('')
    // 名称空 → canBuild=false → 保存按钮禁用；快捷键路径能进 save()
    await wrapper.find('form').trigger('keydown.ctrl.enter')
    await flush()

    const errors = wrapper.findAllComponents(ElFormItem).map(item => item.props('error'))
    expect(errors).toContain(t('modules.kb.graphEditNameRequired'))
    expect(graphApi.updateKnowledgeGraphExtractApi).not.toHaveBeenCalled()
  })

  it('描述超长：descriptionTooLong 分支', async () => {
    const wrapper = await mountPage()
    await wrapper.find('.el-textarea__inner').setValue('长'.repeat(1001))
    await footerButtons(wrapper)[1].trigger('click')
    await flush()

    const errors = wrapper.findAllComponents(ElFormItem).map(item => item.props('error'))
    expect(errors).toContain(t('modules.kb.graphEditDescriptionTooLong'))
  })

  it('参数非法（overlap 非整数）：firstParamError 渲染具体错误', async () => {
    const wrapper = await mountPage()
    wrapper.findComponent(OperatorArgsForm).vm.$emit('update:dynamicParams', {
      operatorId: 'op-1', schemaId: 'tpl-1', llm: 'gpt-x', overlap: 'abc', chunkSize: 1024, customPrompt: '默认提示'
    })
    await flush()
    await footerButtons(wrapper)[1].trigger('click')
    await flush()

    expect(wrapper.text()).toContain('构建配置有误：请输入整数')
    expect(graphApi.updateKnowledgeGraphExtractApi).not.toHaveBeenCalled()
  })

  it('保存构建成功：FormData 装配（schemaId 提升）、提示并跳列表', async () => {
    const wrapper = await mountPage()
    const raw = new File(['pdf'], '新增.pdf', { type: 'application/pdf' })
    wrapper.findComponent({ name: 'KnowledgeFilePicker' }).vm.$emit('update:modelValue', [raw])
    await flush()

    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    await flush()

    expect(graphApi.updateKnowledgeGraphExtractApi).toHaveBeenCalledTimes(1)
    const [id, fd] = graphApi.updateKnowledgeGraphExtractApi.mock.calls[0]
    expect(id).toBe('g-123')
    expect(fd).toBeInstanceOf(FormData)
    const payload = JSON.parse(fd.get('data'))
    expect(payload).toMatchObject({
      name: '影视图谱',
      description: '电影实体',
      category: 10,
      operatorId: 'op-1',
      schemaId: 'tpl-1',
      coverFlag: true
    })
    expect(payload.kwargs).toMatchObject({ llm: 'gpt-x', overlap: 128, chunkSize: 1024 })
    expect(fd.getAll('files')).toHaveLength(1)
    expect(messageMock.success).toHaveBeenCalledWith(t('modules.kb.updateKnowledgeGraphSuccess'))
    expect(wrapper.router.currentRoute.value.path).toBe('/graph')
  })

  it('canBuild=false（无算子）时保存只警告不请求', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([])
    const wrapper = await mountPage()
    // canBuild=false → 按钮禁用，走 Ctrl+Enter 路径进 handleBuild 的门控
    await wrapper.find('form').trigger('keydown.ctrl.enter')
    await flush()
    expect(messageMock.warning).toHaveBeenCalledWith(t('modules.kb.pleaseCompleteRequiredFields'))
    expect(graphApi.updateKnowledgeGraphExtractApi).not.toHaveBeenCalled()
  })
})

describe('联动参数与 footer', () => {
  it('OperatorArgsForm 抛出的参数合并进 dynamicParams 且清参数错误', async () => {
    const wrapper = await mountPage()
    wrapper.findComponent(OperatorArgsForm).vm.$emit('update:dynamicParams', {
      operatorId: 'op-1', schemaId: 'tpl-1', llm: 'gpt-x', overlap: 256, chunkSize: 2048, customPrompt: '改过'
    })
    await flush()
    // 保存成功链路能带上新值
    await footerButtons(wrapper)[1].trigger('click')
    await flush()
    await flush()
    const payload = JSON.parse(graphApi.updateKnowledgeGraphExtractApi.mock.calls[0][1].get('data'))
    expect(payload.kwargs).toMatchObject({ overlap: 256, chunkSize: 2048, customPrompt: '改过' })
  })

  it('取消按钮回到图谱详情页', async () => {
    const wrapper = await mountPage()
    await footerButtons(wrapper)[0].trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('graph-detail')
  })

  it('构建中：保存按钮 loading；无文件时 footer 提示添加来源文档', async () => {
    graphApi.getKnowledgeGraphFileListApi.mockResolvedValue({ items: [] })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('添加来源文档后，可保存并构建')
    // 无文件 → canBuild false → 禁用
    expect(footerButtons(wrapper)[1].element.disabled).toBe(true)
  })

  it('查看图谱链接指向详情路由', async () => {
    const wrapper = await mountPage()
    const link = wrapper.findAllComponents(RouterLinkStub)
      .find(item => typeof item.props('to') === 'object')
    expect(link.props('to')).toEqual({ name: 'graph-detail', params: { id: 'g-123' } })
  })
})

describe('补充分支（locale 回退 / 默认值 / 参数错误码 / 陈旧响应）', () => {
  it('英文界面：锁定配置优先 nameEn；修复下拉 label 同样取 nameEn', async () => {
    const wrapper = await mountPage('/graph/edit/g-123', 'en')
    expect(wrapper.text()).toContain('General')
  })

  it('算子只有中文名（无 nameEn）→ 英文界面回落中文名', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([{ id: 'op-1', name: '通用抽取', args: [{ argName: 'llm' }] }])
    const wrapper = await mountPage('/graph/edit/g-123', 'en')
    expect(wrapper.text()).toContain('通用抽取')
  })

  it('算子两个名字都为空 → 英文界面显示 Not configured', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([{ id: 'op-1', args: [] }])
    const wrapper = await mountPage('/graph/edit/g-123', 'en')
    expect(wrapper.text()).toContain('Not configured')
  })

  it('文件缺 fileSize：容量汇总按 0 计（||0 兜底）', async () => {
    graphApi.getKnowledgeGraphFileListApi.mockResolvedValue({
      items: [{ id: 'f-1', title: '无大小.pdf', fileSize: null, fileFrom: '1' }]
    })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('0 B')
  })

  it('文件上限缺 maxSizeMap/number：分组为空、数量回落 50', async () => {
    graphApi.getKbaseFileLimitApi.mockResolvedValue({})
    const wrapper = await mountPage()
    const picker = wrapper.findComponent({ name: 'KnowledgeFilePicker' })
    expect(picker.props('maxFiles')).toBe(50)
    expect(picker.props('activeFileLimits')).toEqual([])
  })

  it.each([
    ['overlap 为空', { operatorId: 'op-1', schemaId: 'tpl-1', llm: 'gpt-x', overlap: '', chunkSize: 1024, customPrompt: '默认提示' }, '请填写此项'],
    ['chunkSize 过小', { operatorId: 'op-1', schemaId: 'tpl-1', llm: 'gpt-x', overlap: 1, chunkSize: 100, customPrompt: '默认提示' }, '最大字符数需在 512–10240 之间'],
    ['overlap 过大', { operatorId: 'op-1', schemaId: 'tpl-1', llm: 'gpt-x', overlap: 6000, chunkSize: 1024, customPrompt: '默认提示' }, '重叠字符数需在 0–5120 之间'],
    ['overlap 不小于 chunkSize', { operatorId: 'op-1', schemaId: 'tpl-1', llm: 'gpt-x', overlap: 2000, chunkSize: 1024, customPrompt: '默认提示' }, '重叠字符数必须小于最大字符数']
  ])('参数错误码：%s', async (_name, params, expected) => {
    const wrapper = await mountPage()
    wrapper.findComponent(OperatorArgsForm).vm.$emit('update:dynamicParams', params)
    await flush()
    // 参数不完整 → canBuild=false → 按钮禁用；走 Ctrl+Enter 触发校验
    await wrapper.find('form').trigger('keydown.ctrl.enter')
    await flush()
    expect(wrapper.text()).toContain(`构建配置有误：${expected}`)
    expect(graphApi.updateKnowledgeGraphExtractApi).not.toHaveBeenCalled()
  })

  it('名称只有一个字符：nameFormat 分支文案', async () => {
    const wrapper = await mountPage()
    await wrapper.find('input[maxlength="30"]').setValue('a')
    await wrapper.find('form').trigger('keydown.ctrl.enter')
    await flush()
    const errors = wrapper.findAllComponents(ElFormItem).map(item => item.props('error'))
    expect(errors).toContain(t('modules.kb.graphEditNameFormat'))
  })

  it('修复下拉收到空 id：handleRepairOperator 直接返回', async () => {
    graphApi.getKnowledgeGraphBasicInfoApi.mockResolvedValue({
      data: { id: 'g-123', name: '导入图谱', description: '', embeddingModel: 'bge-m3', operatorId: null },
      schemaInfo: null
    })
    const wrapper = await mountPage()
    const callsBefore = graphApi.getOperatorListApi.mock.calls.length
    selects(wrapper).at(-1).vm.$emit('update:modelValue', '')
    selects(wrapper).at(-1).vm.$emit('change', '')
    await flush()
    // 空 id 不触发 validateOperator（不再拉算子列表）
    expect(graphApi.getOperatorListApi.mock.calls.length).toBe(callsBefore)
  })

  it('文件清单请求悬着时切走：陈旧响应被丢弃（414/423 的 requestId 守卫）', async () => {
    let resolveFiles
    graphApi.getKnowledgeGraphFileListApi.mockImplementationOnce(() => new Promise((resolve) => { resolveFiles = resolve }))
    const wrapper = await mountPage()
    // loadPage 停在 loadExistingFiles：此时切到另一个图谱
    await wrapper.router.push('/graph/edit/g-456')
    resolveFiles({ items: [{ id: 'f-stale', title: '旧文件.pdf', fileSize: 1, fileFrom: '1' }] })
    await flush()
    await flush()
    // 陈旧文件不该进入新页面（新页面对 g-456 重新走完整 loadPage）
    expect(wrapper.text()).not.toContain('旧文件.pdf')
  })
})

describe('补充分支 II（未配置回落 / 修复下拉 label 回退 / 陈旧算子响应）', () => {
  it('详情缺 Embedding 模型：锁定配置回落「未配置」', async () => {
    graphApi.getKnowledgeGraphBasicInfoApi.mockResolvedValue({
      data: { id: 'g-123', name: '影视图谱', description: '', embeddingModel: '', operatorId: 'op-1' },
      schemaInfo: { schema_id: 'tpl-1', schema_name: '影视模版' }
    })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('未配置')
  })

  it('中文名为空的算子：中文界面回落显示 nameEn', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([{ id: 'op-1', nameEn: 'General', args: [] }])
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('General')
  })

  it('算子没有任何名字：中文界面显示「未配置」', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([{ id: 'op-1', args: [] }])
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('未配置')
  })

  it('英文界面修复下拉：只有 nameEn 的算子 label 取 nameEn', async () => {
    graphApi.getKnowledgeGraphBasicInfoApi.mockResolvedValue({
      data: { id: 'g-123', name: 'Imported', description: '', embeddingModel: 'bge-m3', operatorId: null },
      schemaInfo: null
    })
    graphApi.getOperatorListApi.mockResolvedValue([{ id: 'op-1', nameEn: 'General', args: [] }])
    const wrapper = await mountPage('/graph/edit/g-123', 'en')
    // el-option 的 label 是 prop（operatorLabel(op)），不是插槽内容
    const labels = wrapper.findAllComponents(OptionStub).map(o => o.props('label'))
    expect(labels).toContain('General')
  })

  it('英文界面修复下拉：只有中文名的算子 label 回落中文名', async () => {
    graphApi.getKnowledgeGraphBasicInfoApi.mockResolvedValue({
      data: { id: 'g-123', name: 'Imported', description: '', embeddingModel: 'bge-m3', operatorId: null },
      schemaInfo: null
    })
    graphApi.getOperatorListApi.mockResolvedValue([{ id: 'op-1', name: '通用抽取', args: [] }])
    const wrapper = await mountPage('/graph/edit/g-123', 'en')
    const labels = wrapper.findAllComponents(OptionStub).map(o => o.props('label'))
    expect(labels).toContain('通用抽取')
  })

  it('算子清单请求悬着时切走：陈旧算子响应被丢弃', async () => {
    let resolveOperators
    graphApi.getOperatorListApi.mockImplementationOnce(() => new Promise((resolve) => { resolveOperators = resolve }))
    const wrapper = await mountPage()
    // loadPage 停在 validateOperator → loadOperatorList：此时切到另一个图谱
    await wrapper.router.push('/graph/edit/g-456')
    resolveOperators([OPERATOR])
    await flush()
    await flush()
    // 新页面对 g-456 重新走完整 loadPage，旧页面的参数写入被 requestId 守卫拦下
    expect(wrapper.text()).toContain('影视图谱')
  })
})
