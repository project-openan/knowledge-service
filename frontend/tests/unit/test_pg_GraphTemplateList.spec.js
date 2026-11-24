// @vitest-environment jsdom
/**
 * GraphTemplateList.vue（图谱知识库 · 知识图谱模版列表）—— 列表行为专项：
 * - 数据装配：接口字段映射（schemaId/schemaName/schemaDesc/createTime/createUser）、
 *   本地搜索（名称/ID/描述）、点表头排序的三态循环、本地分页与总数、加载失败清表；
 * - 工具条：新建对话框 openDialog、导入（非 zip / 超大包拒绝 + 上传结果四分支：
 *   全部成功 / 部分失败带明细 / 全部失败 / 接口层失败静默 + 网络异常提示）、
 *   静态模板包下载失败提示；
 * - 行动作：编辑 → 设计器路由、删除确认（确认成功刷新 / 失败复位 loading）、
 *   导出（详情 → 转 zip 落盘；提取不到数据抛错；失败消息取 detail/message/兜底）；
 * - 页签闸门：activeTabName / kbaseActiveTab 切回时静默补刷，document.hidden 不刷。
 *
 * api / 传输 lib / 导出 lib 全 mock；确认弹窗与新建对话框换成可编程桩。
 */
import { vi } from 'vitest'
import { ref } from 'vue'

const { api, transfer, exportLib, dialogStubs } = vi.hoisted(() => ({
  api: {
    uploadKnowledgeGraphTemplateApi: vi.fn(),
    knowledgeGraphTemplateListApi: vi.fn(),
    deleteKnowledgeGraphTemplateApi: vi.fn(),
    getGraphSchemaTemplateDetail: vi.fn()
  },
  transfer: {
    downloadStaticTemplateZip: vi.fn(),
    localizedTemplateFileName: vi.fn((locale, names) => names[locale] || names.zh),
    saveBlobAsFile: vi.fn()
  },
  exportLib: {
    createZipFromExportData: vi.fn(),
    extractSchemaDataFromResponse: vi.fn(),
    transformSchemaDataToExportFormat: vi.fn()
  },
  dialogStubs: {
    openDanger: vi.fn(),
    confirmHandlers: [],
    openCreate: vi.fn()
  }
}))

vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  uploadKnowledgeGraphTemplateApi: (...args) => api.uploadKnowledgeGraphTemplateApi(...args),
  knowledgeGraphTemplateListApi: (...args) => api.knowledgeGraphTemplateListApi(...args),
  deleteKnowledgeGraphTemplateApi: (...args) => api.deleteKnowledgeGraphTemplateApi(...args),
  getGraphSchemaTemplateDetail: (...args) => api.getGraphSchemaTemplateDetail(...args)
}))
vi.mock('@/features/graph/lib/graphTransfer', () => ({
  downloadStaticTemplateZip: (...args) => transfer.downloadStaticTemplateZip(...args),
  localizedTemplateFileName: (...args) => transfer.localizedTemplateFileName(...args),
  saveBlobAsFile: (...args) => transfer.saveBlobAsFile(...args)
}))
vi.mock('@/features/graph/lib/graph-template-export', () => ({
  createZipFromExportData: (...args) => exportLib.createZipFromExportData(...args),
  extractSchemaDataFromResponse: (...args) => exportLib.extractSchemaDataFromResponse(...args),
  transformSchemaDataToExportFormat: (...args) => exportLib.transformSchemaDataToExportFormat(...args)
}))

// 确认弹窗 / 新建对话框：页面会调 openDialog，确认事件由用例手动触发
vi.mock('@/shared/ui/DangerConfirmDialog.vue', () => ({
  default: {
    name: 'DangerConfirmStub',
    emits: ['confirm'],
    setup (_, { expose }) {
      expose({ openDialog: (...args) => dialogStubs.openDanger(...args) })
      return () => null
    }
  }
}))
vi.mock('@/features/graph/CreateKnowledgeGraphTemplateDialog.vue', () => ({
  default: {
    name: 'CreateDialogStub',
    setup (_, { expose }) {
      expose({ openDialog: (...args) => dialogStubs.openCreate(...args) })
      return () => null
    }
  }
}))

import { flush, mountWithPlugins } from './helpers/mount'
import GraphTemplateList from '@/features/graph/GraphTemplateList.vue'

const closeMock = vi.fn()
const messageMock = Object.assign(vi.fn(() => ({ close: closeMock })), {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn()
})
const loadingMock = Object.assign(vi.fn(() => ({ close: closeMock })), { close: vi.fn() })

const ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } },
  { path: '/graph/createTemplate/:templateId', name: 'graph-template', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

/** 接口返回 12 条原始记录：字段名是后端风格，页面负责映射 */
function rawTemplates (count = 12) {
  return Array.from({ length: count }, (_, i) => ({
    schemaId: `tpl-${i + 1}`,
    schemaName: `模版${i + 1}`,
    schemaDesc: `描述${i + 1}`,
    createTime: String(1700000000000 + i),
    createUser: i % 3 === 0 ? '张三' : '李四'
  }))
}

async function mountList ({ list = rawTemplates(), listImpl, route = '/graph' } = {}) {
  api.knowledgeGraphTemplateListApi.mockReset()
  if (listImpl) {
    api.knowledgeGraphTemplateListApi.mockImplementation(listImpl)
  } else {
    api.knowledgeGraphTemplateListApi.mockResolvedValue(list)
  }
  api.deleteKnowledgeGraphTemplateApi.mockReset().mockResolvedValue({})
  api.getGraphSchemaTemplateDetail.mockReset().mockResolvedValue(SCHEMA_DETAIL)
  api.uploadKnowledgeGraphTemplateApi.mockReset().mockResolvedValue({ successCount: 2, failedCount: 0 })
  transfer.downloadStaticTemplateZip.mockReset().mockResolvedValue(undefined)
  transfer.saveBlobAsFile.mockReset()
  exportLib.extractSchemaDataFromResponse.mockReset().mockImplementation(r => r)
  exportLib.transformSchemaDataToExportFormat.mockReset().mockImplementation(r => r)
  exportLib.createZipFromExportData.mockReset().mockResolvedValue(new Blob(['zip']))

  // 外层 / 子层页签：默认都停在本页
  const outerTab = ref('knowledgeGraph')
  const activeTabName = ref('knowledgeGraphTemplate')

  const wrapper = await mountWithPlugins(GraphTemplateList, {
    route,
    routes: ROUTES,
    global: {
      provide: { kbaseActiveTab: outerTab, activeTabName },
      config: { globalProperties: { $message: messageMock, $loading: loadingMock } }
    }
  })
  await flush()
  return { wrapper, outerTab, activeTabName }
}

const SCHEMA_DETAIL = {
  schema_id: 'tpl-1',
  schema_name: '模版1',
  schema_desc: '描述',
  entities: [{ entity_type: 'Scene', properties: [] }],
  edges: []
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('列表装配：映射 / 搜索 / 排序 / 分页', () => {
  it('接口字段映射到行模型并本地分页（12 条 → 第 1 页 10 条 + 总数 12）', async () => {
    const { wrapper } = await mountList()
    expect(wrapper.vm.rows).toHaveLength(10)
    expect(wrapper.vm.rows[0]).toEqual({
      id: 'tpl-1',
      name: '模版1',
      schema_id: 'tpl-1',
      description: '描述1',
      createTime: 1700000000000,
      createdBy: '张三'
    })
    expect(wrapper.vm.total).toBe(12)
    expect(wrapper.vm.loading).toBe(false)
    // 页头排序默认无
    expect(wrapper.vm.sortProp).toBe('')
  })

  it('搜索命中名称 / ID / 描述（不区分大小写）', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.searchKey = '模版1'
    await wrapper.vm.refreshTableData('initPage')
    expect(wrapper.vm.total).toBe(4) // 模版1 / 模版10-12（字符串包含）

    wrapper.vm.searchKey = 'tpl-2'
    await wrapper.vm.refreshTableData('initPage')
    expect(wrapper.vm.rows.map(r => r.id)).toEqual(['tpl-2'])

    wrapper.vm.searchKey = '描述11'
    await wrapper.vm.refreshTableData('initPage')
    expect(wrapper.vm.rows.map(r => r.id)).toEqual(['tpl-11'])
  })

  it('点表头排序：asc → desc → 清除，再点新列重新 asc', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.toggleSort('name')
    await flush()
    expect(wrapper.vm.sortDir).toBe('asc')
    expect(wrapper.vm.rows[0].name).toBe('模版1')

    wrapper.vm.toggleSort('name')
    await flush()
    expect(wrapper.vm.sortDir).toBe('desc')
    expect(wrapper.vm.rows[0].name).toBe('模版9') // 字符串序：模版10 < 模版9

    wrapper.vm.toggleSort('name')
    await flush()
    expect(wrapper.vm.sortProp).toBe('')
    expect(wrapper.vm.sortDir).toBe('')

    wrapper.vm.toggleSort('schema_id')
    await flush()
    expect(wrapper.vm.sortProp).toBe('schema_id')
    expect(wrapper.vm.sortDir).toBe('asc')
  })

  it('翻页：page/size 更新后重取数据', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.onPaginationChange({ page: 2, size: 10 })
    await flush()
    expect(wrapper.vm.rows[0].id).toBe('tpl-11')
    expect(wrapper.vm.currentPage).toBe(2)
  })

  it('接口失败：清表 + 总数归零（错误提示由拦截器统一弹）', async () => {
    const { wrapper } = await mountList({ listImpl: () => Promise.reject(new Error('x')) })
    expect(wrapper.vm.rows).toEqual([])
    expect(wrapper.vm.total).toBe(0)
  })
})

describe('工具条', () => {
  it('新建：打开模板信息对话框', async () => {
    const { wrapper } = await mountList()
    await wrapper.findAll('.toolbar .el-button')[0].trigger('click')
    expect(dialogStubs.openCreate).toHaveBeenCalled()
  })

  it('下载静态模板包：按语言选文件；失败给错误提示', async () => {
    const { wrapper } = await mountList()
    await wrapper.findAll('.toolbar .el-button')[2].trigger('click')
    expect(transfer.localizedTemplateFileName).toHaveBeenCalledWith('zh', expect.objectContaining({ zh: expect.any(String) }))
    expect(transfer.downloadStaticTemplateZip).toHaveBeenCalled()

    transfer.downloadStaticTemplateZip.mockRejectedValue(new Error('404'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.handleDownloadStaticTemplate()
    // $message 是对象形式调用（{ message, type: 'error' }）
    expect(messageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    expect(String(messageMock.mock.calls.at(-1)[0].message)).toContain('下载')
    error.mockRestore()
  })

  it('导入按钮：触发隐藏的文件选择框', async () => {
    const { wrapper } = await mountList()
    const input = wrapper.find('input[type="file"]')
    const clickSpy = vi.spyOn(input.element, 'click').mockImplementation(() => {})
    await wrapper.findAll('.toolbar .el-button')[1].trigger('click')
    expect(clickSpy).toHaveBeenCalled()
  })

  it('上传结果：全部成功 / 部分失败（带明细，warning）/ 全部失败（error）都会刷新表格', async () => {
    const { wrapper } = await mountList()
    const zip = { name: '包.zip', size: 1024 }

    await wrapper.vm.onFileChange({ target: { files: [zip] } })
    expect(api.uploadKnowledgeGraphTemplateApi).toHaveBeenCalledWith(zip)
    expect(messageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))

    api.uploadKnowledgeGraphTemplateApi.mockResolvedValue({
      successCount: 1,
      failedCount: 2,
      failedDetails: [{ file: 'a.json', error: '格式不对' }, { error: '未知' }]
    })
    await wrapper.vm.onFileChange({ target: { files: [zip] } })
    // 部分成功：warning + 失败明细（未知文件/未知错误走兜底文案）
    expect(messageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', duration: 8000 }))
    expect(String(messageMock.mock.calls.at(-1)[0].message)).toContain('a.json')

    api.uploadKnowledgeGraphTemplateApi.mockResolvedValue({ successCount: 0, failedCount: 1, failedDetails: [{ file: 'b.json', error: '缺字段' }] })
    await wrapper.vm.onFileChange({ target: { files: [zip] } })
    expect(messageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', duration: 8000 }))

    // API 层已提示过错误：页面静默
    api.uploadKnowledgeGraphTemplateApi.mockResolvedValue({ success: false })
    messageMock.mockClear()
    await wrapper.vm.onFileChange({ target: { files: [zip] } })
    expect(messageMock).not.toHaveBeenCalled()
  })

  it('非 zip / 超过 1MB 的包直接拒绝，不发请求', async () => {
    const { wrapper } = await mountList()
    await wrapper.vm.onFileChange({ target: { files: [{ name: '包.rar', size: 1 }] } })
    expect(api.uploadKnowledgeGraphTemplateApi).not.toHaveBeenCalled()
    expect(messageMock).toHaveBeenCalledTimes(1)
    expect(String(messageMock.mock.calls[0][0].message)).toContain('ZIP')

    await wrapper.vm.onFileChange({ target: { files: [{ name: '包.zip', size: 2 * 1024 * 1024 }] } })
    expect(api.uploadKnowledgeGraphTemplateApi).not.toHaveBeenCalled()
    expect(messageMock).toHaveBeenCalledTimes(2)

    // 空文件列表：直接返回
    await wrapper.vm.onFileChange({ target: { files: [] } })
    expect(messageMock).toHaveBeenCalledTimes(2)
  })

  it('上传网络异常：提示失败与错误信息', async () => {
    const { wrapper } = await mountList()
    api.uploadKnowledgeGraphTemplateApi.mockRejectedValue(new Error('断网'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.onFileChange({ target: { files: [{ name: '包.zip', size: 1 }] } })
    await flush() // .then/.catch 在 onFileChange 返回后才落
    expect(messageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    expect(String(messageMock.mock.calls.at(-1)[0].message)).toContain('断网')
    error.mockRestore()
  })
})

describe('行动作', () => {
  it('点名称进设计器：graph-template 路由带行 id', async () => {
    const { wrapper } = await mountList()
    await wrapper.find('.entity-link').trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('graph-template')
    expect(wrapper.router.currentRoute.value.params.templateId).toBe('tpl-1')
  })

  it('删除：确认弹窗带名称；确认成功提示并刷新；失败复位 loading；finally 清当前目标', async () => {
    const { wrapper } = await mountList()
    wrapper.vm.deleteKnowledgeGraphTemplateHandle(wrapper.vm.rows[0])
    expect(dialogStubs.openDanger).toHaveBeenCalled()
    expect(String(dialogStubs.openDanger.mock.calls[0][0].message)).toContain('模版1')

    api.deleteKnowledgeGraphTemplateApi.mockResolvedValue({})
    const done = vi.fn()
    const setLoading = vi.fn()
    wrapper.vm.handleDeleteConfirm({ done, setLoading })
    await flush()
    expect(api.deleteKnowledgeGraphTemplateApi).toHaveBeenCalledWith('tpl-1')
    expect(messageMock.success).toHaveBeenCalled()
    expect(done).toHaveBeenCalled()
    expect(wrapper.vm.currentDeleteTemplate).toBeNull()

    // 再来一次失败路径
    wrapper.vm.deleteKnowledgeGraphTemplateHandle(wrapper.vm.rows[1])
    api.deleteKnowledgeGraphTemplateApi.mockRejectedValue(new Error('x'))
    const done2 = vi.fn()
    const setLoading2 = vi.fn()
    wrapper.vm.handleDeleteConfirm({ done: done2, setLoading: setLoading2 })
    await flush()
    expect(done2).not.toHaveBeenCalled()
    expect(setLoading2).toHaveBeenCalledWith(false)
    expect(wrapper.vm.currentDeleteTemplate).toBeNull()

    // 无当前目标：直接 done
    wrapper.vm.handleDeleteConfirm({ done: done2, setLoading: setLoading2 })
    expect(done2).toHaveBeenCalled()
  })

  it('导出：详情 → 转换 → zip 落盘 → 成功提示；提取不到数据抛「导出失败」', async () => {
    const { wrapper } = await mountList()
    await wrapper.vm.handleExportTemplate(wrapper.vm.rows[0])
    expect(api.getGraphSchemaTemplateDetail).toHaveBeenCalledWith('tpl-1')
    expect(exportLib.transformSchemaDataToExportFormat).toHaveBeenCalled()
    expect(transfer.saveBlobAsFile).toHaveBeenCalledWith(expect.any(Blob), '模版1.zip')
    expect(messageMock.success).toHaveBeenCalled()

    exportLib.extractSchemaDataFromResponse.mockReturnValue(null)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.handleExportTemplate(wrapper.vm.rows[0])
    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.exportTemplateFailed'))
    error.mockRestore()
  })

  it('导出失败：错误消息取 detail → message → 兜底词条', async () => {
    const { wrapper } = await mountList()
    api.getGraphSchemaTemplateDetail.mockRejectedValue(Object.assign(new Error('详情挂了'), { detail: 'DD' }))
    await wrapper.vm.handleExportTemplate(wrapper.vm.rows[0])
    expect(messageMock.error).toHaveBeenCalledWith('DD')

    api.getGraphSchemaTemplateDetail.mockRejectedValue(new Error('EM'))
    await wrapper.vm.handleExportTemplate(wrapper.vm.rows[0])
    expect(messageMock.error).toHaveBeenCalledWith('EM')

    api.getGraphSchemaTemplateDetail.mockRejectedValue({})
    await wrapper.vm.handleExportTemplate(wrapper.vm.rows[0])
    expect(messageMock.error).toHaveBeenCalledWith(wrapper.vm.$t('modules.kb.exportTemplateFailed'))
  })
})

describe('页签可见性闸门', () => {
  it('activeTabName 切回本页签时刷新；外层页签切回时静默刷新（不挂转圈）', async () => {
    const { wrapper, outerTab, activeTabName } = await mountList()
    api.knowledgeGraphTemplateListApi.mockClear()

    activeTabName.value = 'knowledgeGraphTemplate' // 相同值不触发
    await flush()
    expect(api.knowledgeGraphTemplateListApi).not.toHaveBeenCalled()

    activeTabName.value = 'knowledgeGraph'
    await flush()
    activeTabName.value = 'knowledgeGraphTemplate'
    await flush()
    expect(api.knowledgeGraphTemplateListApi).toHaveBeenCalledTimes(1)

    // 外层：切走（非可见）不刷；切回（可见）静默补刷
    api.knowledgeGraphTemplateListApi.mockClear()
    outerTab.value = 'doc'
    await flush()
    outerTab.value = 'knowledgeGraph'
    await flush()
    expect(api.knowledgeGraphTemplateListApi).toHaveBeenCalledTimes(1)
  })

  it('document.hidden 时不补刷', async () => {
    const { wrapper, outerTab } = await mountList()
    api.knowledgeGraphTemplateListApi.mockClear()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    outerTab.value = 'doc'
    await flush()
    outerTab.value = 'knowledgeGraph'
    await flush()
    expect(api.knowledgeGraphTemplateListApi).not.toHaveBeenCalled()
    hidden.mockRestore()
  })
})
