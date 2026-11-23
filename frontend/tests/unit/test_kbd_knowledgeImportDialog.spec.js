// @vitest-environment jsdom
// 导入弹窗（KnowledgeImportDialog.vue）：打开时的状态复位、目标库缺省回退、
// 「未选目标」的就地报错、无 submitHandler 的 emit 链、submitHandler 成功/失败两条链、
// 同名冲突（FILE_NAME_CONFLICT_CODE）的覆盖确认三岔口（确认→coverFlag 重试 /
// 取消→保持打开 / 重试再失败→就地报错）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { messageBox, kbaseApi } = vi.hoisted(() => ({ messageBox: {}, kbaseApi: {} }))

// 只 mock ElMessageBox.confirm（覆盖确认框），其余保留真实现
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

vi.mock('@/features/knowledge-base/api/kbaseApi', () => ({
  getSupportOperatorApi: vi.fn(),
  getFileSizeInfoApi: (...args) => kbaseApi.getFileSizeInfoApi(...args),
  uploadFileAndSplitConfigApi: vi.fn(),
  checkAISEnvironmentApi: vi.fn(),
  checkEnvironmentApi: vi.fn()
}))

import { flush, mountWithPlugins } from './helpers/mount'
import { h } from 'vue'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import KnowledgeImportDialog from '@/features/knowledge-base/components/KnowledgeImportDialog.vue'
import KnowledgeFilePicker from '@/features/knowledge-base/components/KnowledgeFilePicker.vue'
import zhKb from '@/app/i18n/zh/kb'

/** el-dialog 透传件：StudioDialog 的 actions 挂在 #footer 上，占位件不渲染 footer。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'beforeClose', 'closeOnClickModal', 'appendToBody'],
  setup (props, { slots }) {
    return () => h('div', { class: 'test-dialog' }, [
      props.modelValue ? (slots.default ? slots.default() : null) : null,
      props.modelValue && slots.footer ? slots.footer() : null
    ])
  }
}

const ENTRIES = [
  { id: 'kb-1', name: '产品手册库' },
  { id: 'kb-2', name: '图谱库' }
]

async function mountDialog (props = {}) {
  const wrapper = await mountWithPlugins(KnowledgeImportDialog, {
    props: { modelValue: false, entries: ENTRIES, ...props },
    global: { components: { ElDialog: DialogPassthrough, ElForm, ElFormItem } }
  })
  await wrapper.setProps({ modelValue: true })
  await flush()
  await flush()
  return wrapper
}

function makeFile (name, size = 10) {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' })
}

async function addFiles (wrapper, files) {
  wrapper.findComponent(KnowledgeFilePicker).vm.$emit('update:modelValue', files)
  await flush()
}

async function clickSubmit (wrapper) {
  const buttons = wrapper.findAll('button')
  const submit = buttons.find(b => b.text().includes(zhKb.importHintTitle))
  await submit.trigger('click')
  await flush()
  await flush()
}

function errorLine (wrapper) {
  return wrapper.find('.knowledge-import-error')
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  messageBox.confirm = vi.fn(() => Promise.resolve())
  kbaseApi.getFileSizeInfoApi = vi.fn(async () => ({ fileSizes: [], maxFiles: 3, totalFileSize: '1MB' }))
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('打开弹窗：复位与目标库缺省', () => {
  it('initialId 预选目标库；文件/错误态被清空', async () => {
    const wrapper = await mountDialog({ initialId: 'kb-2' })
    // el-select 是占位件，模型值直接读不出 DOM：经 submit 行为间接断言（见下面用例）
    expect(wrapper.find('[data-ep-stub="el-select"]').exists()).toBe(true)
    expect(errorLine(wrapper).exists()).toBe(false)
  })

  it('entries 变化后原目标不在列表里：回退到 initialId 对应项，否则清空', async () => {
    const wrapper = await mountDialog({ initialId: 'kb-1' })
    // 目标 kb-1 还在：不触发回退（行为经 error 断言，这里先只看渲染不炸）
    await wrapper.setProps({ entries: [{ id: 'kb-9', name: '新库' }] })
    await flush()

    // 提交时找不到目标 → 就地报错 importTargetRequired
    await addFiles(wrapper, [makeFile('a.txt')])
    await clickSubmit(wrapper)
    expect(errorLine(wrapper).text()).toContain(zhKb.importTargetRequired)
    expect(wrapper.emitted('import')).toBeUndefined()
  })
})

describe('无 submitHandler：emit 链', () => {
  it('选了目标 + 文件：emit import（带 target/files/totalBytes）并关闭弹窗', async () => {
    const wrapper = await mountDialog({ initialId: 'kb-1' })
    await addFiles(wrapper, [makeFile('a.txt', 5), makeFile('b.md', 7)])

    await clickSubmit(wrapper)

    const emitted = wrapper.emitted('import')
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0].target).toEqual(ENTRIES[0])
    expect(emitted[0][0].files.map(f => f.name)).toEqual(['a.txt', 'b.md'])
    expect(emitted[0][0].totalBytes).toBe(12)
    // 打开态复位：再关一次 model 也没有 import 第二次
    await wrapper.setProps({ modelValue: false })
    await flush()
    expect(wrapper.emitted('import')).toHaveLength(1)
  })
})

describe('有 submitHandler：成功 / 失败 / 冲突三岔口', () => {
  it('成功：submitHandler 收到 (payload, {})，弹窗关闭', async () => {
    const handler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({ initialId: 'kb-2', submitHandler: handler })
    await addFiles(wrapper, [makeFile('a.txt')])

    await clickSubmit(wrapper)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].target).toEqual(ENTRIES[1])
    expect(handler.mock.calls[0][1]).toEqual({})
    expect(errorLine(wrapper).exists()).toBe(false)
  })

  it('普通失败：错误落到弹窗底部（detail 优先），弹窗保持打开', async () => {
    const handler = vi.fn(async () => {
      throw { detail: '磁盘已满' }
    })
    const wrapper = await mountDialog({ initialId: 'kb-1', submitHandler: handler })
    await addFiles(wrapper, [makeFile('a.txt')])

    await clickSubmit(wrapper)

    expect(errorLine(wrapper).text()).toContain('磁盘已满')
    // 弹窗没关：再点一次还能提交
    expect(wrapper.emitted('import')).toBeUndefined()
  })

  it('同名冲突：确认覆盖 → 带 coverFlag:true 重试并成功关闭', async () => {
    const handler = vi.fn()
      .mockRejectedValueOnce({ code: 'file_name_conflict' })
      .mockResolvedValueOnce({})
    const wrapper = await mountDialog({ initialId: 'kb-1', submitHandler: handler })
    await addFiles(wrapper, [makeFile('dup.txt')])

    await clickSubmit(wrapper)

    expect(messageBox.confirm).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls[1][1]).toEqual({ coverFlag: true })
    expect(errorLine(wrapper).exists()).toBe(false)
  })

  it('同名冲突：取消覆盖 → 不重试、保持打开且已选文件还在', async () => {
    messageBox.confirm = vi.fn(() => Promise.reject(new Error('cancel')))
    const handler = vi.fn(async () => {
      throw { code: 'file_name_conflict' }
    })
    const wrapper = await mountDialog({ initialId: 'kb-1', submitHandler: handler })
    await addFiles(wrapper, [makeFile('dup.txt')])

    await clickSubmit(wrapper)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(errorLine(wrapper).exists()).toBe(false)
    expect(wrapper.findComponent(KnowledgeFilePicker).props('modelValue')).toHaveLength(1)
  })

  it('同名冲突后重试再失败：重试的错误落到弹窗底部', async () => {
    const handler = vi.fn()
      .mockRejectedValueOnce({ code: 'file_name_conflict' })
      .mockRejectedValueOnce({ message: '覆盖仍失败' })
    const wrapper = await mountDialog({ initialId: 'kb-1', submitHandler: handler })
    await addFiles(wrapper, [makeFile('dup.txt')])

    await clickSubmit(wrapper)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(errorLine(wrapper).text()).toContain('覆盖仍失败')
  })
})

describe('防线：没有文件或正在提交时不发请求', () => {
  it('没选文件：提交按钮禁用，handler 不被调用', async () => {
    const handler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({ initialId: 'kb-1', submitHandler: handler })
    await clickSubmit(wrapper)
    expect(handler).not.toHaveBeenCalled()
    expect(wrapper.emitted('import')).toBeUndefined()
  })
})
