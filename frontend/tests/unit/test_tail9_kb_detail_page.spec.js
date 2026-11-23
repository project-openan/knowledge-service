// @vitest-environment jsdom
/**
 * KnowledgeBaseDetailPage.vue —— 文档知识库详情页（/knowledge/detail/:id 与
 * /documents 文档管理模式）。api / message / 删除确认 / ElMessageBox / 上传加密
 * 全部 mock；切片与文档两条主线的开态渲染 + 表单交互 + 提交两路逐个跑。
 *
 * 覆盖：状态文案目录（就绪/处理中/失败/等待导入）、指标卡、切片网格/列表视图、
 * 切片抽屉（复制）、文档搜索防抖、tab=info 信息页与编辑弹窗保存、
 * 目录搜索/新建（校验三分支）/重命名/删除（仅目录与连文档两路 + 部分失败中止）、
 * 文件筛选（目录/状态/关键字）、全选/勾选、批量移动（冲突/成功）、
 * 批量删除（成功/部分失败）、文件操作（预览/下载/重试/删除）、上传弹窗
 * （默认目录、大小写扩展名归一、文件名冲突覆盖/取消）、5 秒轮询、切实体重载、
 * ?import=1 直达上传、?source= 切片来源过滤。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, provide, inject, onMounted } from 'vue'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { kbApi, dirApi, kbaseApi, messageMock, deletionApi, cryptoMock, quickCreate } = vi.hoisted(() => ({
  kbApi: {
    getKnowledgeBaseInfo: vi.fn(),
    updatedKnowledgeBaseInfo: vi.fn(),
    getDatasetList: vi.fn(),
    getFileDatasetApi: vi.fn()
  },
  dirApi: {
    getDescendantsDirectoryList: vi.fn(),
    createDirectory: vi.fn(),
    deleteDirectory: vi.fn(),
    deleteFile: vi.fn(),
    downloadFileOut: vi.fn(),
    getAllFilesPageApi: vi.fn(),
    moveDocuments: vi.fn(),
    retryFile: vi.fn(),
    updateDirectory: vi.fn()
  },
  kbaseApi: { uploadFileAndSplitConfigApi: vi.fn() },
  messageMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  deletionApi: { requestDeletion: vi.fn() },
  cryptoMock: { getConfig: vi.fn(async () => ({})) },
  quickCreate: {
    buildDefaultSplitOperator: vi.fn(async () => ({ id: 'op-split' })),
    fallbackUploadLimits: vi.fn(() => ({ groups: [], maxFiles: 20, maxTotalBytes: 20 * 1024 * 1024 })),
    loadUploadLimits: vi.fn(async () => ({ groups: [{ extensions: ['pdf'], maxMB: 20 }], maxFiles: 5, maxTotalBytes: 50 * 1024 * 1024 }))
  }
}))

const boxMock = vi.hoisted(() => ({ prompt: vi.fn(), confirm: vi.fn() }))

vi.mock('@/features/knowledge-base/api/knowledgeBase', () => kbApi)
vi.mock('@/features/knowledge-base/api/directory', () => dirApi)
vi.mock('@/features/knowledge-base/api/kbaseApi.js', () => kbaseApi)
vi.mock('@/shared/lib/message', () => ({ default: messageMock }))
vi.mock('@/shared/composables/deletion', async importOriginal => ({
  ...(await importOriginal()),
  requestDeletion: (...args) => deletionApi.requestDeletion(...args)
}))
vi.mock('@/shared/composables/useCrypto', () => ({ useCrypto: () => ({ getConfig: cryptoMock.getConfig }) }))
vi.mock('@/features/knowledge-base/lib/quick-create', () => quickCreate)
// 删除目录弹窗的验证码：被 DeleteFolderDialog 直接 import，必须走 vi.mock 才能替掉
vi.mock('@/shared/ui/DeleteVerification.vue', async () => {
  const { onMounted } = await import('vue')
  return {
    default: {
      name: 'DeleteVerification',
      emits: ['update:verified'],
      setup (_, { emit }) {
        onMounted(() => emit('update:verified', true))
        // 弹窗每次打开会把 verified 复位并调 verificationRef.reset()
        return { reset: () => {} , render: () => null }
      }
    }
  }
})
vi.mock('element-plus', async importOriginal => ({
  ...(await importOriginal()),
  ElMessageBox: { prompt: (...a) => boxMock.prompt(...a), confirm: (...a) => boxMock.confirm(...a) }
}))
const copyMock = vi.hoisted(() => ({ copyTextWithToast: vi.fn(async () => true) }))
vi.mock('@/shared/lib/copy-with-toast', () => ({ copyTextWithToast: (...a) => copyMock.copyTextWithToast(...a) }))

import { createTestI18n, flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElSwitch } from 'element-plus/es/components/switch/index'
import KnowledgeBaseDetailPage from '@/pages/knowledge-base/KnowledgeBaseDetailPage.vue'

const i18n = createTestI18n()
const t = i18n.global.t

const DrawerShell = {
  name: 'ElDrawer',
  props: { modelValue: Boolean },
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => props.modelValue
      ? h('div', { class: 'drawer-shell' }, [
        h('div', { class: 'drawer-shell-header' }, slots.header?.()),
        h('div', { class: 'drawer-shell-body' }, slots.default?.()),
        h('div', { class: 'drawer-shell-footer' }, slots.footer?.())
      ])
      : null
  }
}

const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'beforeClose', 'closeOnClickModal'],
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    return () => props.modelValue
      ? h('div', { class: 'test-dialog' }, [
        slots.default ? slots.default() : null,
        slots.footer ? slots.footer() : null
      ])
      : null
  }
}

const SelectStub = {
  name: 'SelectStub',
  props: { modelValue: { type: null, default: '' }, placeholder: String, disabled: Boolean },
  emits: ['update:modelValue', 'change', 'visible-change'],
  setup (_, { slots }) {
    return () => h('div', { class: 'ops-stub-select' }, [slots.default?.(), slots.empty?.()])
  }
}

const OptionStub = { name: 'ElOption', props: { label: String, value: null }, template: '<div class="ops-stub-option"><slot /></div>' }

/** 命令下拉替身：#dropdown 插槽内联渲染；item 点击回传 command（复刻 EP 的 command 链）。 */
const COMMAND = Symbol('test-dropdown-command')
const ElDropdown = {
  name: 'ElDropdown',
  emits: ['command', 'visible-change'],
  setup (_, { slots, emit }) {
    provide(COMMAND, cmd => emit('command', cmd))
    return () => h('div', { class: 'test-dropdown' }, [slots.default?.(), slots.dropdown?.()])
  }
}
const ElDropdownMenu = { name: 'ElDropdownMenu', setup (_, { slots }) { return () => h('div', { class: 'test-dropdown-menu' }, slots.default?.()) } }
const ElDropdownItem = {
  name: 'ElDropdownItem',
  props: { command: String, disabled: Boolean, divided: Boolean },
  setup (props, { slots }) {
    const send = inject(COMMAND, null)
    return () => h('button', {
      class: 'test-dropdown-item',
      disabled: props.disabled,
      onClick: () => send?.(props.command)
    }, slots.default?.())
  }
}

const RouterLinkStub = {
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: true } },
  template: '<a :href="typeof to === \'string\' ? to : \'#\'" class="router-link-stub"><slot /></a>'
}

const GLOBAL = {
  components: {
    ElDrawer: DrawerShell, ElDialog: DialogPassthrough,
    ElForm, ElFormItem, ElSwitch, ElSelect: SelectStub, ElOption: OptionStub,
    ElDropdown, ElDropdownMenu, ElDropdownItem,
    RouterLink: RouterLinkStub
  },
  stubs: { transition: false, 'transition-group': false },
  config: { globalProperties: { $globalZh: true, $message: messageMock } }
}

const KB_DETAIL = () => ({
  id: 'kb-1',
  name: '手册库',
  description: '产品说明书',
  status: 7,
  currentFileCount: 3,
  createdBy: 'tester',
  props: { embeddingModel: 'bge-m3' },
  lastUpdatedDate: '2026-06-01T10:30:00',
  chunkCount: 12
})

const FILES = () => ([
  { id: 'f-1', title: '说明书.pdf', parentId: 'fold-1', fileSize: 1024, status: 1, chunkCount: 5, createdBy: 'u1', fullName: '张三', createdDate: '2026-05-01 09:00:00' },
  { id: 'f-2', title: '附录.DOCX', parentId: 'fold-2', fileSize: 2048, status: 2, failReason: 'RetCode.file.embedding.error', createdBy: 'u2', fullNameEn: 'Li Si', createdDate: '2026-05-02 09:00:00' },
  { id: 'f-3', title: '待处理.txt', parentId: 'fold-1', fileSize: 8, status: 0, createdBy: 'u3', createdDate: '2026-05-03 09:00:00' },
  { id: 'f-4', title: '问答.QA', parentId: 'fold-1', fileSize: 16, status: 1, kType: 'QA', chunkCount: 2, createdBy: 'u1', fullName: '张三', createdDate: '2026-05-04 09:00:00' }
])

const FOLDERS = () => ([
  { id: 'fold-1', title: '第一卷', type: 'folder', parentId: null },
  { id: 'fold-2', title: '子卷', type: 'folder', parentId: 'fold-1' },
  { id: 'fold-3', title: '孙卷', type: 'folder', parentId: 'fold-2' }
])

const CHUNK_ROWS = () => ([
  { chunkId: 'c-1', content: '## 第一章\n\n正文内容甲', source: '说明书.pdf', fileId: 'f-1', effectFlag: 1 },
  { chunkId: 'c-2', content: '## 第二章\n\n正文内容乙', source: '说明书.pdf', fileId: 'f-1', effectFlag: 0 }
])

function stubAll () {
  kbApi.getKnowledgeBaseInfo.mockReset().mockResolvedValue(KB_DETAIL())
  kbApi.updatedKnowledgeBaseInfo.mockReset().mockResolvedValue({})
  kbApi.getDatasetList.mockReset().mockResolvedValue({ items: CHUNK_ROWS(), total: 12 })
  kbApi.getFileDatasetApi.mockReset().mockResolvedValue({ items: CHUNK_ROWS(), total: 12 })
  dirApi.getAllFilesPageApi.mockReset().mockResolvedValue({ items: FILES(), total: 4 })
  dirApi.getDescendantsDirectoryList.mockReset().mockResolvedValue(FOLDERS())
  dirApi.createDirectory.mockReset().mockResolvedValue({ id: 'fold-new' })
  dirApi.deleteDirectory.mockReset().mockResolvedValue({})
  dirApi.deleteFile.mockReset().mockResolvedValue({})
  dirApi.downloadFileOut.mockReset().mockResolvedValue(new Blob(['pdf']))
  dirApi.moveDocuments.mockReset().mockResolvedValue({})
  dirApi.retryFile.mockReset().mockResolvedValue({})
  dirApi.updateDirectory.mockReset().mockResolvedValue({})
  kbaseApi.uploadFileAndSplitConfigApi.mockReset().mockResolvedValue({})
  deletionApi.requestDeletion.mockReset().mockResolvedValue(true)
  boxMock.prompt.mockReset()
  boxMock.confirm.mockReset()
  copyMock.copyTextWithToast.mockClear()
  messageMock.mockClear()
  messageMock.success.mockClear()
  messageMock.error.mockClear()
  messageMock.warning.mockClear()
}

let activeWrapper = null

async function mountPage (route = '/knowledge/detail/kb-1') {
  const wrapper = await mountWithPlugins(KnowledgeBaseDetailPage, {
    route,
    global: GLOBAL
  })
  await flush()
  await flush()
  activeWrapper = wrapper
  return wrapper
}

beforeEach(() => {
  stubAll()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (activeWrapper) {
    try {
      activeWrapper.unmount()
    } catch {
      // 忽略二次卸载
    }
    activeWrapper = null
  }
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const selectsIn = (wrapper, ariaLabel) => wrapper.findAllComponents(SelectStub)
  .find(s => s.attributes('aria-label') === ariaLabel || s.props('placeholder') === ariaLabel)

describe('切片管理页（默认 tab）', () => {
  it('概览指标与状态（就绪）：文件数/切片数/存储量、嵌入模型、切片卡片', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('手册库')
    expect(wrapper.text()).toContain('产品说明书')
    expect(wrapper.text()).toContain('bge-m3')
    expect(wrapper.text()).toContain('已就绪')
    expect(wrapper.text()).toContain('第一章')
    expect(wrapper.text()).toContain('# 001')
    // 启用/停用状态徽标
    expect(wrapper.text()).toContain('已启用')
    expect(wrapper.text()).toContain('已停用')
    // 分片统计文案
    expect(wrapper.text()).toContain('12')
  })

  it('空知识库：状态「等待导入」、空态文案给「去导入文档」', async () => {
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), status: 0, currentFileCount: 0, chunkCount: 0 })
    dirApi.getAllFilesPageApi.mockResolvedValue({ items: [], total: 0 })
    kbApi.getDatasetList.mockResolvedValue({ items: [], total: 0 })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('等待导入')
    expect(wrapper.text()).toContain('前往文档管理')
  })

  it('处理中 / 失败状态的文案目录（1 解析中 / 101 解析失败）', async () => {
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), status: 1 })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('解析中')
    await activeWrapper.unmount()
    activeWrapper = null
    document.body.innerHTML = ''

    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), status: 101 })
    const failed = await mountPage()
    expect(failed.text()).toContain('解析失败')
  })

  it('详情接口失败：保留空态而不是整页报错（轮询瞬时失败不清数据）', async () => {
    kbApi.getKnowledgeBaseInfo.mockRejectedValue(new Error('boom'))
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('知识库不存在')
    expect(wrapper.text()).toContain('返回文档知识库')
  })

  it('点切片卡打开抽屉：标题编号、正文、复制按钮', async () => {
    const wrapper = await mountPage()
    await wrapper.findAll('.kd-chunk')[0].trigger('click')
    await flush()

    const drawer = wrapper.find('.drawer-shell')
    expect(drawer.exists()).toBe(true)
    expect(drawer.text()).toContain('第一章')
    expect(drawer.text()).toContain('正文内容甲')
    expect(drawer.text()).toContain('说明书.pdf')
    expect(drawer.text()).toContain('c-1')

    await drawer.findAll('button.el-button')[0].trigger('click')
    expect(copyMock.copyTextWithToast).toHaveBeenCalled()

    // 关闭抽屉（点遮罩 / update:modelValue=false）
    await drawer.findAll('.el-switch').length
    wrapper.findAllComponents(DrawerShell)[0].vm.$emit('update:modelValue', false)
    await flush()
    expect(wrapper.find('.drawer-shell').exists()).toBe(false)
  })

  it('视图切换：grid → list（容器类名变化）', async () => {
    const wrapper = await mountPage()
    await wrapper.find('button[aria-label="列表视图"]').trigger('click')
    await flush()
    expect(wrapper.find('.kd-chunks').classes()).toContain('is-list')
  })

  it('切片搜索防抖：输入后 300ms 才按关键字取数并回第 1 页', async () => {
    const wrapper = await mountPage()
    const callsBefore = kbApi.getDatasetList.mock.calls.length
    await wrapper.find('.kd-search input').setValue('第一章')
    expect(kbApi.getDatasetList.mock.calls.length).toBe(callsBefore)
    await new Promise(resolve => setTimeout(resolve, 350))
    await flush()
    expect(kbApi.getDatasetList.mock.calls.length).toBeGreaterThan(callsBefore)
    const lastCall = kbApi.getDatasetList.mock.calls.at(-1)[0]
    expect(lastCall.keyword).toBe('第一章')
  })

  it('来源下拉（?source= 直达）：按文件过滤切片走 getFileDatasetApi', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1?source=f-1')
    await flush()
    expect(kbApi.getFileDatasetApi.mock.calls.length).toBeGreaterThanOrEqual(1)
    // 清空来源 → 回到全量切片接口
    kbApi.getDatasetList.mockClear()
    selectsIn(wrapper, '全部来源文档').vm.$emit('update:modelValue', '')
    await flush()
    expect(kbApi.getDatasetList).toHaveBeenCalledTimes(1)
  })

  it('tab=info：概览信息卡（创建者首字母/索引名/复制知识库 ID）', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1?tab=info')
    expect(wrapper.text()).toContain('基本信息')
    expect(wrapper.text()).toContain('doc_kb_1')
    expect(wrapper.text()).toContain('T')
    // 复制 ID / 索引名
    const copyButtons = wrapper.findAll('.kd-copy-value .icon-button')
    await copyButtons[0].trigger('click')
    expect(copyMock.copyTextWithToast).toHaveBeenCalledWith('kb-1')
    await copyButtons[1].trigger('click')
    expect(copyMock.copyTextWithToast).toHaveBeenCalledWith('doc_kb_1')
  })

  it('tab 切换写回路由 query', async () => {
    const wrapper = await mountPage()
    await wrapper.find('.el-tabs__item#tab-info').trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.query.tab).toBe('info')
  })

  it('编辑基本信息：openEdit 回填 → 保存成功提示并重拉详情', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1?tab=info')
    await wrapper.findAll('.kd-section-heading .el-button')[0].trigger('click')
    await flush()

    const dialog = wrapper.find('.test-dialog')
    const nameInput = dialog.find('input[maxlength="64"]')
    expect(nameInput.element.value).toBe('手册库')
    await nameInput.setValue('新名字')

    // 保存（footer 主按钮）
    const saveButton = dialog.findAll('button.el-button').at(-1)
    await saveButton.trigger('click')
    await flush()
    await flush()
    expect(kbApi.updatedKnowledgeBaseInfo).toHaveBeenCalledWith('kb-1', { name: '新名字', description: '产品说明书' })
    expect(messageMock.success).toHaveBeenCalledWith('基本信息已更新')
  })

  it('编辑基本信息：名称为空直接不保存', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1?tab=info')
    await wrapper.findAll('.kd-section-heading .el-button')[0].trigger('click')
    await flush()
    await wrapper.find('.test-dialog input[maxlength="64"]').setValue('  ')
    await wrapper.find('.test-dialog').findAll('button.el-button').at(-1).trigger('click')
    await flush()
    expect(kbApi.updatedKnowledgeBaseInfo).not.toHaveBeenCalled()
  })

  it('刷新按钮：refreshChunks 重拉三类数据并夹回有效页码', async () => {
    const wrapper = await mountPage()
    const callsBefore = kbApi.getKnowledgeBaseInfo.mock.calls.length
    await wrapper.find('.table-refresh-control button').trigger('click')
    await flush()
    await flush()
    expect(kbApi.getKnowledgeBaseInfo.mock.calls.length).toBeGreaterThan(callsBefore)
  })
})

describe('文档管理页（/documents）', () => {
  async function mountDocs (route = '/knowledge/detail/kb-1/documents') {
    return mountPage(route)
  }

  it('目录侧栏：文件夹列表与计数、新建按钮、搜索过滤', async () => {
    const wrapper = await mountDocs()
    expect(wrapper.text()).toContain('第一卷')
    expect(wrapper.text()).toContain('子卷')
    expect(wrapper.text()).toContain('2') // 全部文档 4 个里 fold-1 有 3 个…此处断言计数渲染存在
    expect(wrapper.text()).toContain('说明书.pdf')

    await wrapper.find('.kd-folders .el-input__inner').setValue('子')
    await flush()
    const folderTexts = wrapper.findAll('.kd-folder').map(b => b.text())
    expect(folderTexts.join('|')).not.toContain('第一卷')
    expect(folderTexts.join('|')).toContain('子卷')
  })

  it('文件状态徽标目录：成功 / 嵌入失败 / 处理中 / QA 类型标记', async () => {
    const wrapper = await mountDocs()
    expect(wrapper.text()).toContain('可用')
    expect(wrapper.text()).toContain('向量化失败')
    expect(wrapper.text()).toContain('待处理')
    expect(wrapper.text()).toContain('QA')
    expect(wrapper.text()).toContain('文档')
    // 切片数：可用文件给数字，其它给 —
    expect(wrapper.text()).toContain('5')
    expect(wrapper.text()).toContain('—')
  })

  it('目录切换筛选文件；文件夹勾选全选/清除', async () => {
    const wrapper = await mountDocs()
    // 点目录「第一卷」→ 只显示 fold-1 的文件
    await wrapper.findAll('.kd-folder')[1].trigger('click')
    await flush()
    expect(wrapper.text()).toContain('待处理.txt')
    expect(wrapper.text()).not.toContain('附录.DOCX')

    // 表头全选 → 3 个文件都勾上
    const headerCheckbox = wrapper.find('.list-table thead input[type="checkbox"]')
    await headerCheckbox.setValue(true)
    await flush()
    expect(wrapper.text()).toContain('已选择 3 篇文档')

    // 取消全选
    await headerCheckbox.setValue(false)
    await flush()
    expect(wrapper.text()).not.toContain('已选择 3 篇文档')
  })

  it('状态筛选下拉与文件关键字过滤', async () => {
    const wrapper = await mountDocs()
    selectsIn(wrapper, '全部状态').vm.$emit('update:modelValue', 'failed')
    await flush()
    expect(wrapper.text()).toContain('附录.DOCX')
    expect(wrapper.text()).not.toContain('说明书.pdf')

    selectsIn(wrapper, '全部状态').vm.$emit('update:modelValue', '')
    await flush()
    await wrapper.findAll('.kd-doc-filters input')[0].setValue('问答')
    await flush()
    expect(wrapper.text()).toContain('问答.QA')
    expect(wrapper.text()).not.toContain('说明书.pdf')
  })

  it('新建目录：校验三分支（必填 / 非法字符 / 合法创建后选中）', async () => {
    const wrapper = await mountDocs()
    let validatorResult = null
    boxMock.prompt.mockImplementation(async (_msg, _title, opts) => {
      validatorResult = opts.inputValidator?.('新目录')
      return { value: '新目录' }
    })

    await wrapper.find('.kd-folder-heading .icon-button').trigger('click')
    await flush()
    await flush()
    expect(dirApi.createDirectory).toHaveBeenCalledWith(
      { kbaseId: 'kb-1', parentId: 'fold-1' },
      { title: '新目录', category: 0 }
    )
    // validator 三种取值都验过
    expect(validatorResult).toBe(true)

    // 空名 → 必填提示
    boxMock.prompt.mockImplementation(async (_m, _t, opts) => {
      validatorResult = opts.inputValidator?.('')
      return { value: '' }
    })
    await wrapper.find('.kd-folder-heading .icon-button').trigger('click')
    await flush()
    expect(validatorResult).toBe('请输入目录名称')

    // 重复目录名 → warning
    boxMock.prompt.mockImplementation(async () => ({ value: '第一卷' }))
    await wrapper.find('.kd-folder-heading .icon-button').trigger('click')
    await flush()
    await flush()
    expect(messageMock.warning).toHaveBeenCalledWith('此目录名称已存在')
  })

  it('目录重命名：合法名更新成功；取消弹窗静默返回', async () => {
    const wrapper = await mountDocs()
    // 第一卷是根目录（无 parentId）→ rename/delete 入口禁用；子卷可操作
    const dropdowns = wrapper.findAllComponents(ElDropdown)
    // 下拉与所在行闭包绑定：dropdowns[1] 才是「子卷」行的目录操作
    boxMock.prompt.mockResolvedValue({ value: '新名字' })
    dropdowns[1].vm.$emit('command', 'rename', { id: 'fold-2', name: '子卷', parentId: 'fold-1' })
    await flush()
    await flush()
    expect(dirApi.updateDirectory).toHaveBeenCalledWith('kb-1', 'fold-2', { title: '新名字' })
    expect(messageMock.success).toHaveBeenCalled()

    // 取消（prompt reject）→ catch 分支
    boxMock.prompt.mockRejectedValue(new Error('cancel'))
    dropdowns[1].vm.$emit('command', 'rename', { id: 'fold-2', name: '子卷', parentId: 'fold-1' })
    await flush()
    expect(messageMock.success).toHaveBeenCalledTimes(1)
  })

  it('目录删除：仅删目录；连文档删除；部分失败中止', async () => {
    const wrapper = await mountDocs()
    const dropdowns = wrapper.findAllComponents(ElDropdown)

    // 仅删除目录（无文档计数场景）
    dropdowns[1].vm.$emit('command', 'delete', { id: 'fold-2', name: '子卷', parentId: 'fold-1' })
    await flush()
    const deleteDialog = wrapper.find('.delete-folder-dialog')
    expect(deleteDialog.exists()).toBe(true)
    expect(deleteDialog.findAll('button.el-button')).toHaveLength(3) // 取消 / 仅删除 / 一并删除
    await deleteDialog.findAll('button.el-button').at(-2).trigger('click') // 仅删除目录
    await flush()
    await flush()
    expect(dirApi.deleteDirectory).toHaveBeenCalledWith('kb-1', 'fold-2')

    // 连文档删除：删光子目录树里的文件再删目录
    dirApi.deleteFile.mockClear()
    dirApi.deleteDirectory.mockClear()
    dropdowns[1].vm.$emit('command', 'delete', { id: 'fold-2', name: '子卷', parentId: 'fold-1' })
    await flush()
    const reopened = wrapper.find('.delete-folder-dialog')
    await reopened.findAll('button.el-button').at(-1).trigger('click') // 连文档删除
    await flush()
    await flush()
    expect(dirApi.deleteFile).toHaveBeenCalled()
    expect(dirApi.deleteDirectory).toHaveBeenCalledWith('kb-1', 'fold-2')

    // 部分失败：中止删除目录
    dirApi.deleteDirectory.mockClear()
    dirApi.deleteFile.mockRejectedValueOnce(new Error('x'))
    dropdowns[1].vm.$emit('command', 'delete', { id: 'fold-2', name: '子卷', parentId: 'fold-1' })
    await flush()
    await wrapper.find('.delete-folder-dialog').findAll('button.el-button').at(-1).trigger('click')
    await flush()
    await flush()
    expect(messageMock.error).toHaveBeenCalled()
    expect(dirApi.deleteDirectory).not.toHaveBeenCalled()
  })

  it('文件操作：预览（成功/失败）、下载、重试（仅失败文件）、单个删除', async () => {
    const wrapper = await mountDocs()
    // 预览：点击文件名
    await wrapper.findAll('.kd-file-name')[0].trigger('click')
    await flush()
    const previewDrawer = wrapper.find('.drawer-shell')
    expect(previewDrawer.text()).toContain('说明书.pdf')
    expect(previewDrawer.text()).toContain('第一章')

    // 预览抽屉里下载
    dirApi.downloadFileOut.mockClear()
    await previewDrawer.findAll('button.el-button')[0].trigger('click')
    expect(dirApi.downloadFileOut).toHaveBeenCalledWith({ kbaseId: 'kb-1', fileId: 'f-1' })

    // 预览失败 → 兜底文案
    kbApi.getFileDatasetApi.mockRejectedValue(new Error('x'))
    await wrapper.findAll('.kd-file-name')[1].trigger('click')
    await flush()
    expect(wrapper.find('.drawer-shell').text()).toContain('暂时无法预览文本内容')

    // 重试：走 command（失败文件；3 个目录下拉之后，f-2 行是第 5 个下拉）
    const fileDropdown = wrapper.findAllComponents(ElDropdown)[4]
    fileDropdown.vm.$emit('command', 'retry', FILES()[1])
    await flush()
    await flush()
    expect(dirApi.retryFile).toHaveBeenCalledWith('kb-1', 'f-2')
    expect(messageMock.success).toHaveBeenCalledWith('已重新提交处理，请稍候')

    // 重试非失败文件 → 直接返回（用 f-1 行的下拉，其闭包文件是可用的）
    dirApi.retryFile.mockClear()
    wrapper.findAllComponents(ElDropdown)[3].vm.$emit('command', 'retry')
    await flush()
    expect(dirApi.retryFile).not.toHaveBeenCalled()

    // 单个删除：删除确认走 requestDeletion（f-2 行下拉）
    deletionApi.requestDeletion.mockClear()
    fileDropdown.vm.$emit('command', 'delete')
    await flush()
    await flush()
    expect(deletionApi.requestDeletion).toHaveBeenCalled()
    expect(dirApi.deleteFile).toHaveBeenCalledWith('kb-1', 'f-2')
  })

  it('批量移动：目标目录默认选中、同名冲突拦截、成功后切到目标目录', async () => {
    const wrapper = await mountDocs()
    // 勾选 f-1 与 f-3（同在 fold-1）
    const checkboxes = wrapper.findAll('.list-table tbody input[type="checkbox"]')
    await checkboxes[0].setValue(true)
    await checkboxes[2].setValue(true)
    await flush()
    await wrapper.find('.kd-selection .danger-action').exists()
    const moveBtn = wrapper.findAll('.kd-selection button').find(b => b.text().includes('移动到'))
    await moveBtn.trigger('click')
    await flush()

    const moveDialog = wrapper.find('.test-dialog')
    expect(moveDialog.text()).toContain('说明书.pdf')
    // 目标目录：默认给第一个非当前所在目录 → 第一卷
    // 直接确认 → moveDocuments
    await moveDialog.findAll('button.el-button').at(-1).trigger('click')
    await flush()
    await flush()
    expect(dirApi.moveDocuments).toHaveBeenCalledWith('kb-1', ['f-1', 'f-3'], 'fold-2')
    expect(messageMock.success).toHaveBeenCalled()
    expect(wrapper.findAll('.test-dialog').some(d => d.text().includes('移动到目录'))).toBe(false)
  })

  it('批量移动：目标目录有同名文件 → 拦截', async () => {
    const wrapper = await mountDocs()
    dirApi.getAllFilesPageApi.mockResolvedValue({
      items: [
        { id: 'f-1', title: '同名.pdf', parentId: 'fold-1', fileSize: 1, status: 1, createdBy: 'u1', fullName: '张三' },
        { id: 'f-9', title: '同名.pdf', parentId: 'fold-2', fileSize: 1, status: 1, createdBy: 'u1', fullName: '张三' }
      ],
      total: 2
    })
    const fresh = await mountDocs()
    const checkboxes = fresh.findAll('.list-table tbody input[type="checkbox"]')
    await checkboxes[1].setValue(true) // f-9 → 移到 fold-1（与 f-1 同名）
    await flush()
    const moveBtn = fresh.findAll('.kd-selection button').find(b => b.text().includes('移动到'))
    await moveBtn.trigger('click')
    await flush()
    await fresh.find('.test-dialog').findAll('button.el-button').at(-1).trigger('click')
    await flush()
    expect(messageMock.warning).toHaveBeenCalledWith('目标目录存在同名文档，请先重命名')
    expect(dirApi.moveDocuments).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('批量删除：确认后逐个删除并提示部分失败', async () => {
    const wrapper = await mountDocs()
    const checkboxes = wrapper.findAll('.list-table tbody input[type="checkbox"]')
    await checkboxes[0].setValue(true)
    await checkboxes[1].setValue(true)
    await flush()
    // 第一个成功、第二个失败 → 成功 + 部分失败两条提示
    dirApi.deleteFile.mockRejectedValueOnce(new Error('x'))
    const deleteBtn = wrapper.findAll('.kd-selection button').find(b => b.text().includes('删除'))
    await deleteBtn.trigger('click')
    await flush()
    await flush()
    expect(deletionApi.requestDeletion).toHaveBeenCalledTimes(1)
    expect(messageMock.success).toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalled()
  })

  it('上传弹窗：默认目录回填、选文件后提交（扩展名归一 + FormData 装配）', async () => {
    const wrapper = await mountDocs()
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    expect(quickCreate.loadUploadLimits).toHaveBeenCalled()

    const dialog = wrapper.findAll('.test-dialog').find(d => d.find('.kd-upload-form').exists())
    // 选目录下拉默认选中当前目录
    // 塞两个文件（一个大写扩展名 → 归一为小写；一个无扩展名 → 原样）
    const picker = wrapper.findComponent({ name: 'KnowledgeFilePicker' })
    const rawLower = new File(['pdf'], '报告.PDF', { type: 'application/pdf' })
    const rawNoExt = new File(['txt'], '说明', { type: 'text/plain' })
    picker.vm.$emit('update:modelValue', [rawLower, rawNoExt])
    await flush()

    await dialog.findAll('button.el-button').at(-1).trigger('click')
    await flush()
    await flush()
    expect(kbaseApi.uploadFileAndSplitConfigApi).toHaveBeenCalledTimes(1)
    const [kbId, fd, config] = kbaseApi.uploadFileAndSplitConfigApi.mock.calls[0]
    expect(kbId).toBe('kb-1')
    expect(config).toEqual({})
    const files = fd.getAll('files')
    expect(files.some(f => f.name === '报告.pdf')).toBe(true)
    const metadata = JSON.parse(fd.get('metadata'))
    expect(metadata).toMatchObject({ kType: 'outer-document', directoryId: 'fold-1', kbaseId: 'kb-1', splitType: 'system' })
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('上传文件名冲突：确认覆盖后带 coverFlag 重传', async () => {
    const wrapper = await mountDocs()
    kbaseApi.uploadFileAndSplitConfigApi.mockRejectedValueOnce({ code: 'file_name_conflict' })
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    const picker = wrapper.findComponent({ name: 'KnowledgeFilePicker' })
    picker.vm.$emit('update:modelValue', [new File(['pdf'], '说明书.pdf', { type: 'application/pdf' })])
    await flush()

    boxMock.confirm.mockResolvedValue({})
    await wrapper.findAll('.test-dialog').at(-1).findAll('button.el-button').at(-1).trigger('click')
    await flush()
    await flush()
    await flush()
    expect(boxMock.confirm).toHaveBeenCalled()
    // 第二次调用带 coverFlag=true
    const secondCall = kbaseApi.uploadFileAndSplitConfigApi.mock.calls[1]
    expect(JSON.parse(secondCall[1].get('metadata')).coverFlag).toBe(true)
  })

  it('上传文件名冲突：取消覆盖则弹窗保持打开、不再重传', async () => {
    const wrapper = await mountDocs()
    kbaseApi.uploadFileAndSplitConfigApi.mockRejectedValue({ code: 'file_name_conflict' })
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    const picker = wrapper.findComponent({ name: 'KnowledgeFilePicker' })
    picker.vm.$emit('update:modelValue', [new File(['pdf'], '说明书.pdf', { type: 'application/pdf' })])
    await flush()

    boxMock.confirm.mockRejectedValue(new Error('cancel'))
    await wrapper.findAll('.test-dialog').at(-1).findAll('button.el-button').at(-1).trigger('click')
    await flush()
    await flush()
    // 只传过一次，弹窗未关
    expect(kbaseApi.uploadFileAndSplitConfigApi).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.test-dialog').at(-1).exists()).toBe(true)
  })

  it('?import=1 直达上传弹窗并清掉 query', async () => {
    const wrapper = await mountDocs('/knowledge/detail/kb-1/documents?import=1')
    await flush()
    await flush()
    expect(wrapper.router.currentRoute.value.query.import).toBeUndefined()
    expect(quickCreate.loadUploadLimits).toHaveBeenCalled()
  })

  it('5 秒轮询：有处理中文件时轮询，无处理中则跳过；卸载后停止', async () => {
    vi.useFakeTimers()
    const wrapper = await mountDocs()
    const callsBefore = dirApi.getAllFilesPageApi.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    // 有 pending 文件（f-3 status=0）→ 轮询了一次
    expect(dirApi.getAllFilesPageApi.mock.calls.length).toBeGreaterThan(callsBefore)

    // 把 pending 文件处理完：这一轮仍会拉（拉到的就是已可用数据），下一轮开始跳过
    dirApi.getAllFilesPageApi.mockResolvedValue({
      items: FILES().map(f => ({ ...f, status: f.id === 'f-3' ? 1 : f.status })),
      total: 4
    })
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    const after = dirApi.getAllFilesPageApi.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(dirApi.getAllFilesPageApi.mock.calls.length).toBe(after)

    activeWrapper.unmount()
    activeWrapper = null
    const stopped = dirApi.getAllFilesPageApi.mock.calls.length
    await vi.advanceTimersByTimeAsync(11000)
    await flush()
    expect(dirApi.getAllFilesPageApi.mock.calls.length).toBe(stopped)
    vi.useRealTimers()
  })

  it('切实体（kbId 变化）：状态全部重置并重新拉取', async () => {
    const wrapper = await mountDocs()
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), id: 'kb-2', name: '另一个库' })
    await wrapper.router.push('/knowledge/detail/kb-2/documents')
    await flush()
    await flush()
    expect(wrapper.text()).toContain('另一个库')
    expect(wrapper.text()).not.toContain('手册库')
  })

  it('无匹配文件时给空态文案', async () => {
    dirApi.getAllFilesPageApi.mockResolvedValue({ items: [], total: 0 })
    const wrapper = await mountDocs()
    expect(wrapper.findAll('.list-table tbody tr')).toHaveLength(0)
    expect(wrapper.find('.kd-files-table el-empty').exists()).toBe(true)
  })
})

describe('补充分支（导航 / 命令分流 / 防御守卫 / 预览兜底）', () => {
  it('概览页「文档管理」按钮 → goDocuments；文档页「查看分块」→ goDetail（isDocuments watch 重拉）', async () => {
    const wrapper = await mountPage()
    const docButton = wrapper.findAll('.workspace-actions button, [class*=actions] button')
      .find(b => b.text().includes('文档管理'))
    expect(docButton).toBeTruthy()
    await docButton.trigger('click')
    await flush()
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge-documents')
    // 切到文档模式后 isDocuments watch 又拉了一次文件
    const callsAfterSwitch = dirApi.getAllFilesPageApi.mock.calls.length
    expect(callsAfterSwitch).toBeGreaterThanOrEqual(2)

    const chunkButton = wrapper.findAll('button').find(b => b.text().includes('查看分块'))
    await chunkButton.trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.name).toBe('knowledge-detail')
  })

  it('?tab=info 下点「分块」页签：stripTabQuery 清掉 tab query', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1?tab=info')
    await wrapper.find('.el-tabs__item#tab-chunks').trigger('click')
    await flush()
    expect(wrapper.router.currentRoute.value.query.tab).toBeUndefined()
  })

  it('文档模式刷新按钮：refreshDocuments 夹页码保留勾选', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    const callsBefore = kbApi.getKnowledgeBaseInfo.mock.calls.length
    await wrapper.find('.table-refresh-control button').trigger('click')
    await flush()
    await flush()
    expect(kbApi.getKnowledgeBaseInfo.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('route.query.source 变化 → sourceId 跟随并按文件取切片', async () => {
    const wrapper = await mountPage()
    kbApi.getFileDatasetApi.mockClear()
    await wrapper.router.push('/knowledge/detail/kb-1?source=f-2')
    await flush()
    await flush()
    expect(kbApi.getFileDatasetApi).toHaveBeenCalled()
  })

  it('知识库没有描述 → 副标题回落「暂无描述」', async () => {
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), description: '' })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('暂无描述')
  })

  it('根目录行不响应重命名/删除命令；未知命令直接返回', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    const rootDropdown = wrapper.findAllComponents(ElDropdown)[0]
    rootDropdown.vm.$emit('command', 'rename')
    rootDropdown.vm.$emit('command', 'delete')
    rootDropdown.vm.$emit('command', 'other')
    await flush()
    expect(boxMock.prompt).not.toHaveBeenCalled()
    expect(wrapper.find('.delete-folder-dialog').exists()).toBe(false)
  })

  it('fileAction 分流：chunks 跳转带 source；preview 打开抽屉；move 打开移动弹窗', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    const f1Dropdown = wrapper.findAllComponents(ElDropdown)[3]

    f1Dropdown.vm.$emit('command', 'preview')
    await flush()
    expect(wrapper.find('.drawer-shell').text()).toContain('说明书.pdf')

    f1Dropdown.vm.$emit('command', 'move')
    await flush()
    expect(wrapper.find('.kd-move-form').exists()).toBe(true)

    // chunks：切到切片页并带 source（放最后，页面会离开文档模式）
    f1Dropdown.vm.$emit('command', 'chunks')
    await flush()
    await flush()
    expect(wrapper.router.currentRoute.value.query.source).toBe('f-1')
  })

  it('文件切片接口没给 total / 内容为空：预览计数回落、文案兜底', async () => {
    kbApi.getFileDatasetApi.mockResolvedValue({ items: [] })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    await wrapper.findAll('.kd-file-name')[0].trigger('click')
    await flush()
    expect(wrapper.find('.drawer-shell').text()).toContain('此文档尚未解析')
  })

  it('没有目录时打开上传并提交：警告「请选择导入目录」', async () => {
    dirApi.getDescendantsDirectoryList.mockResolvedValue([])
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    const picker = wrapper.findComponent({ name: 'KnowledgeFilePicker' })
    picker.vm.$emit('update:modelValue', [new File(['x'], 'a.pdf', { type: 'application/pdf' })])
    await flush()
    const dialog = wrapper.findAll('.test-dialog').find(d => d.find('.kd-upload-form').exists())
    await dialog.findAll('button.el-button').at(-1).trigger('click')
    await flush()
    expect(messageMock.warning).toHaveBeenCalledWith('请选择导入目录')
    expect(kbaseApi.uploadFileAndSplitConfigApi).not.toHaveBeenCalled()
  })

  it('上传接口报非冲突错误：弹窗保持打开，不走覆盖确认', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    kbaseApi.uploadFileAndSplitConfigApi.mockRejectedValue(new Error('网络炸了'))
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    const picker = wrapper.findComponent({ name: 'KnowledgeFilePicker' })
    picker.vm.$emit('update:modelValue', [new File(['x'], 'a.pdf', { type: 'application/pdf' })])
    await flush()
    const dialog = () => wrapper.findAll('.test-dialog').find(d => d.find('.kd-upload-form').exists())
    await dialog().findAll('button.el-button').at(-1).trigger('click')
    await flush()
    await flush()
    expect(boxMock.confirm).not.toHaveBeenCalled()
    expect(dialog().exists()).toBe(true)
  })

  it('目录已选时打开上传：默认目录用当前目录', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    await wrapper.findAll('.kd-folder')[3].trigger('click') // 孙卷
    await flush()
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    // 上传弹窗里的目录下拉默认选中孙卷
    const uploadSelects = wrapper.findAllComponents(SelectStub)
      .filter(s => s.attributes('aria-label') === '导入目录')
    expect(uploadSelects).toHaveLength(1)
    expect(uploadSelects[0].props('modelValue')).toBe('fold-3')
  })

  it('没有目录可移动：openMove 警告「没有可用的目标目录」', async () => {
    dirApi.getDescendantsDirectoryList.mockResolvedValue([])
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    const checkboxes = wrapper.findAll('.list-table tbody input[type="checkbox"]')
    await checkboxes[0].setValue(true)
    await flush()
    const moveBtn = wrapper.findAll('.kd-selection button').find(b => b.text().includes('移动到'))
    await moveBtn.trigger('click')
    await flush()
    expect(messageMock.warning).toHaveBeenCalledWith('没有可用的目标目录')
  })
})

describe('补充分支 II（数据形状兜底 / 刷新失败 / 校验边界）', () => {
  it('详情缺字段：id 回落路由 id、模型回落顶层字段、时间/创建者给 --', async () => {
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ name: '裸库', embeddingModel: 'top-model' })
    const wrapper = await mountPage('/knowledge/detail/kb-1?tab=info')
    expect(wrapper.text()).toContain('裸库')
    expect(wrapper.text()).toContain('top-model')
    expect(wrapper.text()).toContain('--')
  })

  it('状态码目录的其它分支（切分中 / 切分失败）', async () => {
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), status: 2 })
    let wrapper = await mountPage()
    expect(wrapper.text()).toContain('切分中')
    await activeWrapper.unmount()
    activeWrapper = null
    document.body.innerHTML = ''

    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), status: 102 })
    wrapper = await mountPage()
    expect(wrapper.text()).toContain('切分失败')
  })

  it('刷新时详情接口失败：rethrow 抛给刷新按钮，旧数据保留', async () => {
    const wrapper = await mountPage()
    kbApi.getKnowledgeBaseInfo.mockRejectedValue(new Error('down'))
    await wrapper.find('.table-refresh-control button').trigger('click')
    await flush()
    await flush()
    // 旧数据还在（loadKnowledge 的「保留已渲染数据」口径）
    expect(wrapper.text()).toContain('手册库')
    expect(wrapper.find('.table-refresh-error').exists()).toBe(true)
  })

  it('文件接口不带 items 数组：按空表处理', async () => {
    dirApi.getAllFilesPageApi.mockResolvedValue({ total: 0 })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(wrapper.findAll('.list-table tbody tr')).toHaveLength(0)
  })

  it('文件超过一页：按 pageSize 翻页拉全量', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `f-${i}`, title: `文件${i}.pdf`, parentId: 'fold-1', fileSize: 1, status: 1, createdBy: 'u'
    }))
    let page = 0
    dirApi.getAllFilesPageApi.mockImplementation(async () => {
      page += 1
      return page === 1
        ? { items: many, total: 101 }
        : { items: [{ id: 'f-100', title: '第101个.pdf', parentId: 'fold-1', fileSize: 1, status: 1, createdBy: 'u' }], total: 101 }
    })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(dirApi.getAllFilesPageApi.mock.calls.length).toBe(2)
    expect(wrapper.text()).toContain('101 篇文档')
  })

  it('目录接口返回非数组：目录列表置空', async () => {
    dirApi.getDescendantsDirectoryList.mockResolvedValue({ foo: 1 })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(wrapper.findAll('.kd-folder-row')).toHaveLength(0)
  })

  it('目录行缺 title/name：目录名回落用 id', async () => {
    dirApi.getDescendantsDirectoryList.mockResolvedValue([{ id: 'only-id', type: 'folder', parentId: null }])
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(wrapper.findAll('.kd-folder').map(b => b.text()).join('|')).toContain('only-id')
  })

  it('切片行缺 content / source：标题正文与来源兜底为空', async () => {
    kbApi.getDatasetList.mockResolvedValue({ items: [{ chunkId: 'c-9', effectFlag: 1 }], total: 1 })
    const wrapper = await mountPage()
    expect(wrapper.findAll('.kd-chunk')).toHaveLength(1)
  })

  it('预览接口返回 null：预览给兜底文案', async () => {
    kbApi.getFileDatasetApi.mockResolvedValue(null)
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    await wrapper.findAll('.kd-file-name')[0].trigger('click')
    await flush()
    expect(wrapper.find('.drawer-shell').text()).toContain('此文档尚未解析')
  })

  it('文件缺创建人三字段 → 显示 --', async () => {
    dirApi.getAllFilesPageApi.mockResolvedValue({
      items: [{ id: 'f-x', title: '无名.pdf', parentId: 'fold-1', fileSize: 1, status: 1 }],
      total: 1
    })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(wrapper.find('.list-table tbody').text()).toContain('--')
  })

  it('目录名校验：过短 / 超长 / 非法字符三种拒绝', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    const seen = []
    boxMock.prompt.mockImplementation(async (_m, _t, opts) => {
      seen.push(opts.inputValidator('x'), opts.inputValidator('名'.repeat(31)), opts.inputValidator('a@b'))
      return { value: '' }
    })
    await wrapper.find('.kd-folder-heading .icon-button').trigger('click')
    await flush()
    expect(seen.every(v => typeof v === 'string' && v !== '')).toBe(true)
    expect(seen[2]).toContain('目录名称需为')
  })

  it('新建目录后能在目录列表里找到 → 自动选中', async () => {
    dirApi.createDirectory.mockResolvedValue({ id: 'fold-new' })
    dirApi.getDescendantsDirectoryList.mockResolvedValueOnce(FOLDERS())
    boxMock.prompt.mockResolvedValue({ value: '新目录' })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    dirApi.getDescendantsDirectoryList.mockResolvedValue([
      ...FOLDERS(),
      { id: 'fold-new', title: '新目录', type: 'folder', parentId: 'fold-1' }
    ])
    await wrapper.find('.kd-folder-heading .icon-button').trigger('click')
    await flush()
    await flush()
    // folderId 切到新建目录 → 文件表只剩它的文件（没有 → 空态）
    expect(wrapper.findAll('.kd-folder').map(b => b.text()).join('|')).toContain('新目录')
  })

  it('重命名：名字没变直接返回；改成已存在的名字提示重复', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    const dropdowns = wrapper.findAllComponents(ElDropdown)
    dirApi.updateDirectory.mockClear()

    boxMock.prompt.mockResolvedValue({ value: '子卷' })
    dropdowns[1].vm.$emit('command', 'rename', { id: 'fold-2', name: '子卷', parentId: 'fold-1' })
    await flush()
    await flush()
    expect(dirApi.updateDirectory).not.toHaveBeenCalled()

    boxMock.prompt.mockResolvedValue({ value: '第一卷' })
    dropdowns[1].vm.$emit('command', 'rename', { id: 'fold-2', name: '子卷', parentId: 'fold-1' })
    await flush()
    await flush()
    expect(messageMock.warning).toHaveBeenCalledWith('此目录名称已存在')
    expect(dirApi.updateDirectory).not.toHaveBeenCalled()
  })

  it('删除当前选中目录：folderId 回到全部文档', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    // 先选中子卷
    await wrapper.findAll('.kd-folder')[2].trigger('click')
    await flush()
    // 删除子卷
    wrapper.findAllComponents(ElDropdown)[1].vm.$emit('command', 'delete')
    await flush()
    await wrapper.find('.delete-folder-dialog').findAll('button.el-button').at(-2).trigger('click')
    await flush()
    await flush()
    // 回到「全部文档」选中态
    expect(wrapper.findAll('.kd-folder')[0].classes()).toContain('active')
  })

  it('未知命令（既非 rename 也非 delete）直接返回', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    wrapper.findAllComponents(ElDropdown)[1].vm.$emit('command', 'export')
    await flush()
    expect(boxMock.prompt).not.toHaveBeenCalled()
    expect(wrapper.find('.delete-folder-dialog').exists()).toBe(false)
  })

  it('删除确认取消：不调删除接口', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    deletionApi.requestDeletion.mockResolvedValue(false)
    const checkboxes = wrapper.findAll('.list-table tbody input[type="checkbox"]')
    await checkboxes[0].setValue(true)
    await flush()
    const deleteBtn = wrapper.findAll('.kd-selection button').find(b => b.text().includes('删除'))
    await deleteBtn.trigger('click')
    await flush()
    await flush()
    expect(deletionApi.requestDeletion).toHaveBeenCalled()
    expect(dirApi.deleteFile).not.toHaveBeenCalled()
  })

  it('批量删除全部失败：只有错误提示，没有成功提示', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    dirApi.deleteFile.mockRejectedValue(new Error('x'))
    const checkboxes = wrapper.findAll('.list-table tbody input[type="checkbox"]')
    await checkboxes[0].setValue(true)
    await checkboxes[1].setValue(true)
    await flush()
    const deleteBtn = wrapper.findAll('.kd-selection button').find(b => b.text().includes('删除'))
    await deleteBtn.trigger('click')
    await flush()
    await flush()
    expect(messageMock.success).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalled()
  })

  it('上传弹窗：没选文件时提交直接返回', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    const dialog = wrapper.findAll('.test-dialog').find(d => d.find('.kd-upload-form').exists())
    await dialog.findAll('button.el-button').at(-1).trigger('click')
    await flush()
    expect(kbaseApi.uploadFileAndSplitConfigApi).not.toHaveBeenCalled()
  })

  it('切片页也有处理中文件时：轮询会补拉切片', async () => {
    vi.useFakeTimers()
    const wrapper = await mountPage()
    const chunkCallsBefore = kbApi.getDatasetList.mock.calls.length
    // 轮询拉回的文件全部处理完 → 本次轮询结束后补拉一次切片
    dirApi.getAllFilesPageApi.mockResolvedValue({
      items: FILES().map(f => ({ ...f, status: f.id === 'f-3' ? 1 : f.status })),
      total: 4
    })
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    await flush()
    expect(kbApi.getDatasetList.mock.calls.length).toBeGreaterThan(chunkCallsBefore)
    vi.useRealTimers()
  })

  it('文档模式下 source query 变化不触发切片重拉', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    kbApi.getDatasetList.mockClear()
    kbApi.getFileDatasetApi.mockClear()
    await wrapper.router.push('/knowledge/detail/kb-1/documents?source=f-2')
    await flush()
    await flush()
    expect(kbApi.getDatasetList).not.toHaveBeenCalled()
    expect(kbApi.getFileDatasetApi).not.toHaveBeenCalled()
  })
})

describe('补充分支 III（状态目录补全 / 接口空形状 / 杂项兜底）', () => {
  it('状态码目录再补三个分支（生成中 / 入库中 / 发布失败）', async () => {
    for (const [status, word] of [[3, '生成中'], [4, '入库中'], [105, '状态未知']]) {
      kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), status })
      const wrapper = await mountPage()
      expect(wrapper.text()).toContain(word)
      await activeWrapper.unmount()
      activeWrapper = null
      document.body.innerHTML = ''
    }
  })

  it('失败文件未指明原因 → 通用失败文案', async () => {
    dirApi.getAllFilesPageApi.mockResolvedValue({
      items: [{ id: 'f-bad', title: '坏件.pdf', parentId: 'fold-1', fileSize: 1, status: 2, failReason: 'other.reason', createdBy: 'u' }],
      total: 1
    })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(wrapper.find('.list-table tbody').text()).toContain('处理失败')
  })

  it('详情完全缺模型与文件数：模型显示 --、文件数回落到文件清单长度', async () => {
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ name: '无模型库' })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('--')
    expect(wrapper.text()).toContain('4')
  })

  it('文件总数小于已拉取条数：循环按 total 收口', async () => {
    dirApi.getAllFilesPageApi.mockResolvedValue({
      items: [{ id: 'f-1', title: '说明书.pdf', parentId: 'fold-1', fileSize: 1, status: 1, createdBy: 'u' }],
      total: 0
    })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(dirApi.getAllFilesPageApi.mock.calls.length).toBe(1)
    expect(wrapper.text()).toContain('说明书.pdf')
  })

  it('目录接口行缺 type 字段也收进目录列表', async () => {
    dirApi.getDescendantsDirectoryList.mockResolvedValue([
      { id: 'fold-9', title: '无类型目录', parentId: null }
    ])
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(wrapper.text()).toContain('无类型目录')
  })

  it('切片行缺 effectFlag：默认启用；切片接口返回 null：列表为空', async () => {
    kbApi.getDatasetList.mockResolvedValue({ items: [{ chunkId: 'c-x', content: '## 无旗标\n正文', source: 'x.pdf' }], total: 1 })
    let wrapper = await mountPage()
    expect(wrapper.text()).toContain('已启用')
    await activeWrapper.unmount()
    activeWrapper = null
    document.body.innerHTML = ''

    kbApi.getDatasetList.mockResolvedValue(null)
    wrapper = await mountPage()
    expect(wrapper.findAll('.kd-chunk')).toHaveLength(0)
  })

  it('目录没有根目录：上传默认目录回落第一项', async () => {
    dirApi.getDescendantsDirectoryList.mockResolvedValue([
      { id: 'sub-1', title: '唯一子目录', type: 'folder', parentId: 'p-1' }
    ])
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    const uploadSelect = wrapper.findAllComponents(SelectStub)
      .find(s => s.attributes('aria-label') === '导入目录')
    expect(uploadSelect.props('modelValue')).toBe('sub-1')
  })

  it('重命名提交空名字：直接返回不调接口', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    dirApi.updateDirectory.mockClear()
    boxMock.prompt.mockResolvedValue({ value: '   ' })
    wrapper.findAllComponents(ElDropdown)[1].vm.$emit('command', 'rename', { id: 'fold-2', name: '子卷', parentId: 'fold-1' })
    await flush()
    await flush()
    expect(dirApi.updateDirectory).not.toHaveBeenCalled()
  })

  it('文件下拉未知命令：整条 if/else 链走完无副作用', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    wrapper.findAllComponents(ElDropdown)[3].vm.$emit('command', 'share')
    await flush()
    expect(boxMock.confirm).not.toHaveBeenCalled()
    expect(wrapper.find('.kd-move-form').exists()).toBe(false)
  })

  it('空知识库上点刷新：页码夹回 1', async () => {
    kbApi.getKnowledgeBaseInfo.mockResolvedValue({ ...KB_DETAIL(), status: 0, currentFileCount: 0, chunkCount: 0 })
    dirApi.getAllFilesPageApi.mockResolvedValue({ items: [], total: 0 })
    kbApi.getDatasetList.mockResolvedValue({ items: [], total: 0 })
    const wrapper = await mountPage()
    await wrapper.find('.table-refresh-control button').trigger('click')
    await flush()
    await flush()
    expect(wrapper.text()).toContain('前往文档管理')
  })

  it('上传中重复点击提交被忽略', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    let release
    kbaseApi.uploadFileAndSplitConfigApi.mockImplementation(() => new Promise(resolve => { release = resolve }))
    await wrapper.find('.kd-doc-toolbar button').trigger('click')
    await flush()
    await flush()
    const picker = wrapper.findComponent({ name: 'KnowledgeFilePicker' })
    picker.vm.$emit('update:modelValue', [new File(['x'], 'a.pdf', { type: 'application/pdf' })])
    await flush()
    const dialog = () => wrapper.findAll('.test-dialog').find(d => d.find('.kd-upload-form').exists())
    await dialog().findAll('button.el-button').at(-1).trigger('click')
    const callsAfterFirst = kbaseApi.uploadFileAndSplitConfigApi.mock.calls.length
    await dialog().findAll('button.el-button').at(-1).trigger('click')
    expect(kbaseApi.uploadFileAndSplitConfigApi.mock.calls.length).toBe(callsAfterFirst)
    release && release({})
    await flush()
  })

  it('documents 下先带 source 再去掉：sourceId 清空回到全量', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents?source=f-1')
    await wrapper.router.push('/knowledge/detail/kb-1/documents')
    await flush()
    await flush()
    // 回到文档模式且未重拉切片（isDocuments 时 source watch 直接跳过）
    expect(kbApi.getDatasetList).not.toHaveBeenCalled()
  })

  it('detail 页带 import=1：非文档模式不打开上传', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1?import=1')
    await flush()
    expect(quickCreate.loadUploadLimits).not.toHaveBeenCalled()
  })

  it('文件缺 title / fileSize / 创建人：行内兜底渲染', async () => {
    dirApi.getAllFilesPageApi.mockResolvedValue({
      items: [{ id: 'f-blank', parentId: 'fold-1', status: 1, chunkCount: 0 }],
      total: 1
    })
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    expect(wrapper.findAll('.list-table tbody tr')).toHaveLength(1)
    expect(wrapper.find('.list-table tbody').text()).toContain('--')
  })
})

describe('补充分支 IV（刷新链路 rethrow / 来源切片空响应）', () => {
  it('刷新时文件/目录接口失败：各自 rethrow 分支执行，旧数据保留', async () => {
    const wrapper = await mountPage('/knowledge/detail/kb-1/documents')
    dirApi.getAllFilesPageApi.mockRejectedValue(new Error('files down'))
    dirApi.getDescendantsDirectoryList.mockRejectedValue(new Error('folders down'))
    await wrapper.find('.table-refresh-control button').trigger('click')
    await flush()
    await flush()
    expect(wrapper.text()).toContain('说明书.pdf')
    expect(wrapper.find('.table-refresh-error').exists()).toBe(true)
  })

  it('刷新时切片接口失败：loadChunks 的 rethrow 分支执行', async () => {
    const wrapper = await mountPage()
    kbApi.getDatasetList.mockRejectedValue(new Error('chunks down'))
    await wrapper.find('.table-refresh-control button').trigger('click')
    await flush()
    await flush()
    expect(wrapper.find('.table-refresh-error').exists()).toBe(true)
  })

  it('带来源时切片接口返回 null：列表与计数兜底为空', async () => {
    kbApi.getFileDatasetApi.mockResolvedValue(null)
    const wrapper = await mountPage('/knowledge/detail/kb-1?source=f-1')
    await flush()
    expect(wrapper.findAll('.kd-chunk')).toHaveLength(0)
    expect(wrapper.text()).toContain('共 0 个分块')
  })
})
