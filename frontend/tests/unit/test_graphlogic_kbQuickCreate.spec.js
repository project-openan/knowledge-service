// @vitest-environment jsdom
// 「新建知识库」弹窗的真实建库 + 上传实现（features/knowledge-base/lib/quick-create.ts）。
// 现有 spec 只盖了 fallbackUploadLimits / toUploadLimits（23.75%），这里补齐
// 目录回退 / 算子挑选 / 文件名归一 / 上传与建库链路的全分支。
import { vi, beforeEach, describe, expect, it } from 'vitest'

vi.mock('@/app/i18n/i18n.js', () => ({ $t: (key, params) => `${key}:${params?.ext ?? ''}` }))
vi.mock('@/features/knowledge-base/api/knowledgeBase', () => ({ createKnowledgeBase: vi.fn() }))
vi.mock('@/features/knowledge-base/api/kbaseApi.js', () => ({
  getSupportOperatorApi: vi.fn(),
  getFileSizeInfoApi: vi.fn(),
  uploadFileAndSplitConfigApi: vi.fn()
}))
vi.mock('@/features/knowledge-base/api/directory', () => ({ getDescendantsDirectoryList: vi.fn() }))
vi.mock('@/shared/composables/useCrypto', () => ({
  useCrypto: vi.fn(() => ({ getConfig: async () => ({ headers: { Signature: 'sig' } }) }))
}))
vi.mock('@/features/knowledge-base/lib/operator-config', () => ({ cleanOperatorList: vi.fn() }))

import { createKnowledgeBase } from '@/features/knowledge-base/api/knowledgeBase'
import {
  getSupportOperatorApi,
  getFileSizeInfoApi,
  uploadFileAndSplitConfigApi
} from '@/features/knowledge-base/api/kbaseApi.js'
import { getDescendantsDirectoryList } from '@/features/knowledge-base/api/directory'
import { useCrypto } from '@/shared/composables/useCrypto'
import { cleanOperatorList } from '@/features/knowledge-base/lib/operator-config'
import { TOTAL_UPLOAD_SIZE_MB } from '@/features/knowledge-base/lib/file-limits'
import {
  fallbackUploadLimits,
  toUploadLimits,
  loadUploadLimits,
  fetchDefaultDirectoryId,
  buildDefaultSplitOperator,
  uploadFilesToKbase,
  createKnowledgeBaseWithFiles
} from '@/features/knowledge-base/lib/quick-create'

const KB_CATEGORY = { DOCUMENT: 0 }
const DIRECTORY_PAYLOAD = { kbaseId: 'kb-1', category: KB_CATEGORY.DOCUMENT }

beforeEach(() => {
  vi.clearAllMocks()
})

function makeFile (name, size = 10) {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' })
}

describe('fallbackUploadLimits', () => {
  it('缺省分组与总量上限（650MB 来自 nginx client_max_body_size）', () => {
    const limits = fallbackUploadLimits()
    expect(limits.groups).toEqual([
      { extensions: ['txt'], maxMB: 5 },
      { extensions: ['xlsx', 'csv', 'html'], maxMB: 10 },
      { extensions: ['pptx'], maxMB: 20 },
      { extensions: ['json'], maxMB: 50 },
      { extensions: ['docx', 'md'], maxMB: 100 },
      { extensions: ['pdf'], maxMB: 150 },
      { extensions: ['zedx'], maxMB: 650 }
    ])
    expect(limits.maxFiles).toBe(50)
    expect(limits.maxTotalBytes).toBe(TOTAL_UPLOAD_SIZE_MB * 1024 * 1024)
  })
})

describe('toUploadLimits', () => {
  it('maxSizeMap 缺失 / 非对象时回落 fallback', () => {
    expect(toUploadLimits(null)).toEqual(fallbackUploadLimits())
    expect(toUploadLimits(undefined)).toEqual(fallbackUploadLimits())
    expect(toUploadLimits('nope')).toEqual(fallbackUploadLimits())
    expect(toUploadLimits({})).toEqual(fallbackUploadLimits())
  })

  it('按大小分组、升序排序、后缀统一小写；非法值跳过', () => {
    const limits = toUploadLimits({ maxSizeMap: { PDF: 150, DOCX: 100, txt: 5, bad: 'x', zero: 0, negative: -3 } })
    expect(limits.groups).toEqual([
      { extensions: ['txt'], maxMB: 5 },
      { extensions: ['docx'], maxMB: 100 },
      { extensions: ['pdf'], maxMB: 150 }
    ])
  })

  it('number 缺省用 fallback.maxFiles，给出则用给定值；全非法值回落 fallback', () => {
    expect(toUploadLimits({ maxSizeMap: { pdf: 150 }, number: 20 }).maxFiles).toBe(20)
    expect(toUploadLimits({ maxSizeMap: { pdf: 150 } }).maxFiles).toBe(50)
    expect(toUploadLimits({ maxSizeMap: { pdf: 150 }, number: 'abc' }).maxFiles).toBe(50)
    expect(toUploadLimits({ maxSizeMap: { bad: NaN } })).toEqual(fallbackUploadLimits())
  })

  it('直接给映射表（无 maxSizeMap 包装）也能解析', () => {
    const limits = toUploadLimits({ txt: 5 })
    expect(limits.groups).toEqual([{ extensions: ['txt'], maxMB: 5 }])
    // number 键缺席 → maxFiles 用 fallback
    expect(limits.maxFiles).toBe(50)
  })
})

describe('loadUploadLimits', () => {
  it('成功走 toUploadLimits，失败回落 fallback', async () => {
    getFileSizeInfoApi.mockResolvedValue({ maxSizeMap: { pdf: 150 } })
    expect((await loadUploadLimits()).groups).toEqual([{ extensions: ['pdf'], maxMB: 150 }])
    getFileSizeInfoApi.mockRejectedValue(new Error('boom'))
    expect(await loadUploadLimits()).toEqual(fallbackUploadLimits())
  })
})

describe('fetchDefaultDirectoryId', () => {
  it('优先 title=Default 的目录，否则取第一条', async () => {
    getDescendantsDirectoryList.mockResolvedValue([
      { id: 'dir-2', title: 'Other' },
      { id: 'dir-default', title: 'Default' }
    ])
    expect(await fetchDefaultDirectoryId('kb-1')).toBe('dir-default')
    expect(getDescendantsDirectoryList).toHaveBeenCalledWith(DIRECTORY_PAYLOAD)

    getDescendantsDirectoryList.mockResolvedValue([{ id: 'dir-1', title: 'A' }, { id: 'dir-2', title: 'B' }])
    expect(await fetchDefaultDirectoryId('kb-1')).toBe('dir-1')
  })

  it('空列表 / 非数组抛「未找到默认目录」', async () => {
    getDescendantsDirectoryList.mockResolvedValue([])
    await expect(fetchDefaultDirectoryId('kb-1')).rejects.toThrow('未找到默认目录')
    getDescendantsDirectoryList.mockResolvedValue(null)
    await expect(fetchDefaultDirectoryId('kb-1')).rejects.toThrow('未找到默认目录')
  })
})

describe('buildDefaultSplitOperator', () => {
  it('无有效后缀（无扩展名文件 / 空列表）返回空对象，不请求接口', async () => {
    expect(await buildDefaultSplitOperator([])).toEqual({})
    expect(await buildDefaultSplitOperator([makeFile('noext')])).toEqual({})
    expect(getSupportOperatorApi).not.toHaveBeenCalled()
  })

  it('优先 id=-1 的系统算子，否则取第一个；args 深拷贝', async () => {
    const sharedArg = { argName: 'chunkSize', defaultValue: '512' }
    getSupportOperatorApi.mockResolvedValue({
      txt: [
        { id: 5, args: [sharedArg] },
        { id: -1, args: [{ argName: 'llm' }] }
      ]
    })
    const op = await buildDefaultSplitOperator([makeFile('a.TXT')])
    expect(op.txt).toEqual({ operatorId: -1, args: [{ argName: 'llm' }] })
    // 请求参数：去重后的小写后缀 + text_split 模块
    expect(getSupportOperatorApi).toHaveBeenCalledWith({ formats: ['txt'], module: 'text_split' })

    getSupportOperatorApi.mockResolvedValue({ md: [{ id: 3, args: [sharedArg] }] })
    const opMd = await buildDefaultSplitOperator([makeFile('b.md')])
    expect(opMd.md.operatorId).toBe(3)
    // 拷贝而非引用：改动结果不影响原算子定义
    expect(opMd.md.args[0]).not.toBe(sharedArg)
  })

  it('响应形态不是数组时按空处理 → 该后缀无算子时抛错（带 i18n 文案）', async () => {
    getSupportOperatorApi.mockResolvedValue({ pdf: 'not-array' })
    await expect(buildDefaultSplitOperator([makeFile('x.pdf')]))
      .rejects.toThrow('modules.studioDialogs.createKnowledge.noSplitOperator:pdf')

    getSupportOperatorApi.mockResolvedValue({})
    await expect(buildDefaultSplitOperator([makeFile('x.pdf')]))
      .rejects.toThrow('modules.studioDialogs.createKnowledge.noSplitOperator:pdf')
  })
})

describe('uploadFilesToKbase（顶部「导入」上传）', () => {
  it('建 metadata（含切分算子）并复用加密配置上传', async () => {
    getDescendantsDirectoryList.mockResolvedValue([{ id: 'dir-1', title: 'Default' }])
    getSupportOperatorApi.mockResolvedValue({ txt: [{ id: -1, args: [] }] })
    const file = makeFile('NOTE.TXT')
    await uploadFilesToKbase('kb-1', [file])

    const [kbId, data, config] = uploadFileAndSplitConfigApi.mock.calls[0]
    expect(kbId).toBe('kb-1')
    const metadata = JSON.parse(data.get('metadata'))
    expect(metadata).toMatchObject({
      kType: 'outer-document',
      directoryId: 'dir-1',
      kbaseId: 'kb-1',
      splitType: 'system',
      coverFlag: false
    })
    expect(metadata.splitOperator.txt).toEqual({ operatorId: -1, args: [] })
    expect(config).toEqual({ headers: { Signature: 'sig' } })
    expect(useCrypto).toHaveBeenCalledWith('kb-1')
    expect(cleanOperatorList).toHaveBeenCalled()
    // 上传的文件扩展名被归一为小写（主名不动）
    expect(data.get('files').name).toBe('NOTE.txt')
  })

  it('显式 directoryId 时不查目录；coverFlag / skipErrorHandler 透传', async () => {
    getSupportOperatorApi.mockResolvedValue({ txt: [{ id: -1, args: [] }] })
    await uploadFilesToKbase('kb-9', [makeFile('a.txt')], {
      directoryId: 'dir-explicit',
      coverFlag: true,
      skipErrorHandler: true
    })
    expect(getDescendantsDirectoryList).not.toHaveBeenCalled()
    const metadata = JSON.parse(uploadFileAndSplitConfigApi.mock.calls[0][1].get('metadata'))
    expect(metadata.directoryId).toBe('dir-explicit')
    expect(metadata.coverFlag).toBe(true)
    expect(uploadFileAndSplitConfigApi.mock.calls[0][2].skipErrorHandler).toBe(true)
  })

  it('取默认目录失败时异常上抛（调用方决定提示）', async () => {
    getDescendantsDirectoryList.mockRejectedValue(new Error('net'))
    await expect(uploadFilesToKbase('kb-1', [makeFile('a.txt')])).rejects.toThrow('net')
    expect(uploadFileAndSplitConfigApi).not.toHaveBeenCalled()
  })
})

describe('createKnowledgeBaseWithFiles（建库 + 上传）', () => {
  const payload = { name: 'nb', description: 'd', model: 'bge', files: () => [makeFile('A.TXT')] }

  it('建库成功 + 上传成功 → 返回真实 kbId / directoryId', async () => {
    createKnowledgeBase.mockResolvedValue({ id: 'kb-new' })
    getDescendantsDirectoryList.mockResolvedValue([{ id: 'dir-default', title: 'Default' }])
    getSupportOperatorApi.mockResolvedValue({ txt: [{ id: -1, args: [] }] })

    const result = await createKnowledgeBaseWithFiles({
      name: payload.name, description: payload.description, model: payload.model, files: payload.files()
    })
    expect(result).toEqual({ kbId: 'kb-new', directoryId: 'dir-default' })
    // 建库载荷：文档类目 + 向量模型 props
    expect(createKnowledgeBase).toHaveBeenCalledWith({
      name: 'nb',
      description: 'd',
      category: KB_CATEGORY.DOCUMENT,
      props: { embeddingModel: 'bge' }
    })
    const metadata = JSON.parse(uploadFileAndSplitConfigApi.mock.calls[0][1].get('metadata'))
    expect(metadata.kbaseId).toBe('kb-new')
    expect(metadata.directoryId).toBe('dir-default')
    expect(metadata.coverFlag).toBe(false)
  })

  it('kbId 兼容 kbaseId 字段与裸字符串', async () => {
    getSupportOperatorApi.mockResolvedValue({ txt: [{ id: -1, args: [] }] })
    getDescendantsDirectoryList.mockResolvedValue([{ id: 'dir-1', title: 'Default' }])

    createKnowledgeBase.mockResolvedValue({ kbaseId: 'kb-k' })
    expect((await createKnowledgeBaseWithFiles({ name: 'n', description: '', model: 'm', files: payload.files() })).kbId).toBe('kb-k')
    createKnowledgeBase.mockResolvedValue('kb-raw')
    expect((await createKnowledgeBaseWithFiles({ name: 'n', description: '', model: 'm', files: payload.files() })).kbId).toBe('kb-raw')
  })

  it('后续步骤失败时抛错并携带 kbId（调用方据此带用户去新库文档页）', async () => {
    createKnowledgeBase.mockResolvedValue({ id: 'kb-fail' })
    getDescendantsDirectoryList.mockRejectedValue(new Error('no dir'))
    const err = await createKnowledgeBaseWithFiles({ name: 'n', description: '', model: 'm', files: payload.files() }).catch(e => e)
    expect(err.message).toBe('no dir')
    expect(err.kbId).toBe('kb-fail')

    // 目录成功、上传失败同样带 kbId
    getDescendantsDirectoryList.mockResolvedValue([{ id: 'dir-1', title: 'Default' }])
    getSupportOperatorApi.mockResolvedValue({ txt: [{ id: -1, args: [] }] })
    uploadFileAndSplitConfigApi.mockRejectedValue(new Error('upload failed'))
    const err2 = await createKnowledgeBaseWithFiles({ name: 'n', description: '', model: 'm', files: payload.files() }).catch(e => e)
    expect(err2.message).toBe('upload failed')
    expect(err2.kbId).toBe('kb-fail')
  })
})
