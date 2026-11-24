// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'

// features/model/api：models.js（画布下拉的三个模型清单）与 model.js 的单查接口。
// 与 modelManagement.spec 互补：那里没打到的动词/适配逻辑在这里补齐。
const { client } = vi.hoisted(() => ({
  client: {
    get: vi.fn(() => Promise.resolve({})),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve({}))
  }
}))

vi.mock('@/shared/api/client', () => ({ default: client }))

import { getModelList, getLLMModel, getRerankModels } from '@/features/model/api/models'
import { getModelApi, queryModelsApi } from '@/features/model/api/model'

beforeEach(() => {
  client.get.mockReset().mockResolvedValue({})
  client.post.mockReset().mockResolvedValue({})
})

describe('api/models：画布下拉的模型清单', () => {
  it('getModelList：GET /system/embedding-models，返回原样', async () => {
    client.get.mockResolvedValue([{ modelName: 'bge-m3' }])
    const result = await getModelList()
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/system/embedding-models'), {})
    expect(result).toEqual([{ modelName: 'bge-m3' }])
  })

  it('getLLMModel：{value,label} 适配成 {modelValue,nameZh}（视图层历史形状）', async () => {
    client.get.mockResolvedValue([
      { value: 'qwen-max', label: 'Qwen Max' },
      { value: 'deepseek', label: 'DeepSeek' }
    ])
    const result = await getLLMModel()
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/system/llm-models'), {})
    expect(result).toEqual([
      { modelValue: 'qwen-max', nameZh: 'Qwen Max' },
      { modelValue: 'deepseek', nameZh: 'DeepSeek' }
    ])
  })

  it('getLLMModel：非数组返回（网关错误包装）回落空列表', async () => {
    client.get.mockResolvedValue({ message: 'boom' })
    await expect(getLLMModel()).resolves.toEqual([])
    client.get.mockResolvedValue(null)
    await expect(getLLMModel()).resolves.toEqual([])
  })

  it('getRerankModels：/system/rerank-models 原样透传；非数组回落空列表', async () => {
    const list = [{ value: 'bge-reranker', label: 'BGE', isDefault: true }]
    client.get.mockResolvedValue(list)
    await expect(getRerankModels()).resolves.toBe(list)
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/system/rerank-models'), {})

    client.get.mockResolvedValue({ message: 'x' })
    await expect(getRerankModels()).resolves.toEqual([])
  })
})

describe('api/model：单查与列表参数（与 modelManagement.spec 互补的边角）', () => {
  it('getModelApi：GET /models/<id>', async () => {
    await getModelApi('mdl-9', { skipErrorHandler: true })
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/models/mdl-9'), { skipErrorHandler: true })
  })

  it('queryModelsApi：params 走 query、config 透传', async () => {
    await queryModelsApi({ kind: 'llm', currentPage: 3 }, { skipErrorMessage: true })
    const [url, config] = client.get.mock.calls[0]
    expect(url).toContain('/models')
    expect(config.params).toEqual({ kind: 'llm', currentPage: 3 })
    expect(config.skipErrorMessage).toBe(true)
  })
})
