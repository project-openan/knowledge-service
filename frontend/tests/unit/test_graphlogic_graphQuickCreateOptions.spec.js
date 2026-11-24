// 图谱「快速新建」弹窗的取数纯函数（lib/graph-quick-create.ts 0.1.3 新增部分）。
// 名称校验与草稿生命周期已有 graphQuickCreate.spec.js 覆盖，这里补齐
// extractRows / normalizeModels / graphUploadLimits / loadGraphCreateOptions 的分支。
import { vi, beforeEach, describe, expect, it } from 'vitest'

vi.mock('@/features/model/api/models', () => ({ getModelList: vi.fn() }))
vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  knowledgeGraphListApi: vi.fn(),
  getKbaseFileLimitApi: vi.fn()
}))
// 只 mock 公共出口转出的两个纯函数，避免拉进 .vue 组件链
vi.mock('@/features/knowledge-base/api', () => ({
  fallbackUploadLimits: vi.fn(),
  toUploadLimits: vi.fn()
}))

import { getModelList } from '@/features/model/api/models'
import { knowledgeGraphListApi, getKbaseFileLimitApi } from '@/features/graph/api/knowledgeGraph'
import { fallbackUploadLimits, toUploadLimits } from '@/features/knowledge-base/api'
import { loadGraphCreateOptions, isValidGraphQuickName } from '@/features/graph/lib/graph-quick-create'

const FALLBACK_LIMITS = {
  groups: [
    { extensions: ['txt'], maxMB: 5 },
    { extensions: ['ofd'], maxMB: 200 },
    { extensions: ['pdf'], maxMB: 150 },
    { extensions: ['zedx'], maxMB: 650 }
  ],
  maxFiles: 50,
  maxTotalBytes: 1024
}

beforeEach(() => {
  vi.clearAllMocks()
  fallbackUploadLimits.mockReturnValue(FALLBACK_LIMITS)
  toUploadLimits.mockImplementation(payload => ({ groups: [{ extensions: ['pdf'], maxMB: 150 }], maxFiles: 9, maxTotalBytes: 1 }))
  getModelList.mockResolvedValue([])
  knowledgeGraphListApi.mockResolvedValue([])
  getKbaseFileLimitApi.mockResolvedValue({})
})

describe('弹窗名称规则（与整页 validateName 同口径）', () => {
  it('边界长度与非法字符', () => {
    expect(isValidGraphQuickName('ab')).toBe(true)
    expect(isValidGraphQuickName('a'.repeat(30))).toBe(true)
    expect(isValidGraphQuickName('a')).toBe(false)
    expect(isValidGraphQuickName('a'.repeat(31))).toBe(false)
    expect(isValidGraphQuickName('  ')).toBe(false)
    expect(isValidGraphQuickName('a/b')).toBe(false)
  })
})

describe('extractRows：多形态响应都能取到行数组', () => {
  it('直接数组 / data 数组 / data.data / items / data.items / 兜底空数组', async () => {
    const row = { name: 'g1' }
    getModelList.mockResolvedValue([row])
    expect((await loadGraphCreateOptions()).models).toEqual([{ name: 'g1' }])

    getModelList.mockResolvedValue({ data: [{ modelName: 'm1' }] })
    expect((await loadGraphCreateOptions()).models).toEqual([{ name: 'm1' }])

    getModelList.mockResolvedValue({ data: { data: ['m2'] } })
    expect((await loadGraphCreateOptions()).models).toEqual([{ name: 'm2' }])

    getModelList.mockResolvedValue({ items: [{ name: 'm3' }] })
    expect((await loadGraphCreateOptions()).models).toEqual([{ name: 'm3' }])

    getModelList.mockResolvedValue({ data: { items: ['m4'] } })
    expect((await loadGraphCreateOptions()).models).toEqual([{ name: 'm4' }])

    getModelList.mockResolvedValue({ whatever: 1 })
    expect((await loadGraphCreateOptions()).models).toEqual([])

    getModelList.mockResolvedValue(null)
    expect((await loadGraphCreateOptions()).models).toEqual([])
  })
})

describe('normalizeModels', () => {
  it('字符串 / modelName / name 三种来源，空值过滤', async () => {
    getModelList.mockResolvedValue(['raw-model', { modelName: 'mn' }, { name: 'n' }, {}, null, { modelName: '' }])
    expect((await loadGraphCreateOptions()).models).toEqual([
      { name: 'raw-model' }, { name: 'mn' }, { name: 'n' }
    ])
  })
})

describe('graphUploadLimits：剔除建图页不支持的 ofd/zedx', () => {
  it('maxSizeMap 缺失时用 fallback 分组并剔除', async () => {
    getKbaseFileLimitApi.mockResolvedValue({ data: null })
    const { limits } = await loadGraphCreateOptions()
    expect(limits.groups).toEqual([
      { extensions: ['txt'], maxMB: 5 },
      { extensions: ['pdf'], maxMB: 150 }
    ])
    expect(toUploadLimits).not.toHaveBeenCalled()
  })

  it('maxSizeMap 存在时走 toUploadLimits 的分组再剔除', async () => {
    toUploadLimits.mockReturnValue({
      groups: [
        { extensions: ['docx', 'ofd'], maxMB: 100 },
        { extensions: ['zedx'], maxMB: 650 },
        { extensions: ['pdf'], maxMB: 150 }
      ],
      maxFiles: 30,
      maxTotalBytes: 2
    })
    getKbaseFileLimitApi.mockResolvedValue({ data: { maxSizeMap: { docx: 100, ofd: 200, zedx: 650, pdf: 150 } } })
    const { limits } = await loadGraphCreateOptions()
    expect(limits.groups).toEqual([
      { extensions: ['docx'], maxMB: 100 },
      { extensions: ['pdf'], maxMB: 150 }
    ])
    expect(limits.maxFiles).toBe(30)
  })

  it('分组被剔光时回落到 fallback 分组再剔除', async () => {
    toUploadLimits.mockReturnValue({
      groups: [{ extensions: ['ofd', 'zedx'], maxMB: 650 }],
      maxFiles: 30,
      maxTotalBytes: 2
    })
    getKbaseFileLimitApi.mockResolvedValue({ maxSizeMap: { ofd: 650 } })
    const { limits } = await loadGraphCreateOptions()
    expect(limits.groups).toEqual([
      { extensions: ['txt'], maxMB: 5 },
      { extensions: ['pdf'], maxMB: 150 }
    ])
  })

  it('文件上限接口失败时也兜底（不挡弹窗）', async () => {
    getKbaseFileLimitApi.mockRejectedValue(new Error('boom'))
    const { limits } = await loadGraphCreateOptions()
    expect(limits.groups).toEqual([
      { extensions: ['txt'], maxMB: 5 },
      { extensions: ['pdf'], maxMB: 150 }
    ])
  })
})

describe('loadGraphCreateOptions', () => {
  it('三路并发取数；图谱名列表去重；单路失败互不拖垮', async () => {
    knowledgeGraphListApi.mockResolvedValue([
      { name: 'graph-a' }, { name: 'graph-a' }, { name: 'graph-b' }, {}
    ])
    const { existingNames } = await loadGraphCreateOptions()
    expect(existingNames).toEqual(['graph-a', 'graph-b'])
    // 只拉图谱类目（category=10）第一页
    const [params, config] = knowledgeGraphListApi.mock.calls[0]
    expect(params).toEqual({ categories: [10], currentPage: 1, pageSize: 500 })
    expect(config).toEqual({ skipErrorHandler: true })
  })

  it('模型 / 名称接口失败时分别为空数组', async () => {
    getModelList.mockRejectedValue(new Error('boom'))
    knowledgeGraphListApi.mockRejectedValue(new Error('boom'))
    const result = await loadGraphCreateOptions()
    expect(result.models).toEqual([])
    expect(result.existingNames).toEqual([])
  })
})
