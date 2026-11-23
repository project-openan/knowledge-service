// @vitest-environment jsdom
// knowledge-base/lib 与 composables 的残余分支 + kb/workflow 两条 api 模块的契约：
// - kbNames.js（模块级缓存 Map：两种响应形状、失败回落、同名短名回落）
// - useKbOptions.ts（getCurrentInstance 上下文里的分组/扁平化/同库互斥选中）
// - useValidateFiles.js（FileReader 读首字节：可读 / 读失败聚合报错 / 后缀名）
// - workflow/store.js（reactive 单例 + 旧 $store 兼容桥）
// - api：kbaseApi.js / knowledgeBase.js / workflow/api/workflow.js（动词与路径）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

vi.mock('@/shared/api/client', () => {
  const client = {
    get: vi.fn(() => Promise.resolve({})),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve({}))
  }
  return { default: client }
})

import client from '@/shared/api/client'
const axios = client

import { useKbOptions } from '@/features/knowledge-base/composables/useKbOptions'
import { useValidateFiles } from '@/features/knowledge-base/composables/useValidateFiles'

// kbNames 的缓存是模块级单例：每个用例重置模块注册表后重新 import，保证互不串味
async function freshKbNames () {
  vi.resetModules()
  return await import('@/features/knowledge-base/lib/kbNames')
}

beforeEach(() => {
  vi.clearAllMocks()
  axios.get.mockResolvedValue({})
  axios.post.mockResolvedValue({})
  axios.patch.mockResolvedValue({})
  axios.delete.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('kbNames：画布卡片的知识库名称映射', () => {
  it('buildMap 的 {running, dev} 形状：tableName 与 |#| 前缀都能查到', async () => {
    axios.get.mockResolvedValue({
      running: [{ tableName: 'graph_a', name: '图谱A' }],
      dev: [{ tableName: 'kb_b', name: '知识库B' }]
    })
    const { loadKbNames, kbDisplayName } = await freshKbNames()

    const map = await loadKbNames()
    expect(map.graph_a).toBe('图谱A')
    expect(map.kb_b).toBe('知识库B')
    // 带状态后缀的节点名剥掉后缀仍能命中（addOption 的第二行）
    expect(kbDisplayName('kb_b|#|dev')).toBe('知识库B')
    expect(kbDisplayName('graph_a')).toBe('图谱A')
  })

  it('分组数组形状 [{label, options}]：取 option.value/label', async () => {
    axios.get.mockResolvedValue([
      { label: '已发布', options: [{ value: 'graph_x', label: '图谱X' }] },
      { label: '开发中', options: [{ value: 'kb_y|#|dev', label: '库Y' }] }
    ])
    const { loadKbNames, kbDisplayName } = await freshKbNames()

    await loadKbNames()
    expect(kbDisplayName('graph_x')).toBe('图谱X')
    expect(kbDisplayName('kb_y|#|dev')).toBe('库Y')
  })

  it('请求失败：保持空表返回，卡片走短名；且允许下次再请求（缓存被清）', async () => {
    axios.get.mockRejectedValueOnce(new Error('network down'))
    const { loadKbNames, kbDisplayName } = await freshKbNames()

    await expect(loadKbNames()).resolves.toEqual({})
    expect(kbDisplayName('graph_a')).toBe('')
    expect(kbDisplayName('')).toBe('')

    // 失败后 promise 被清空：第二次调用会真的再打一次请求
    axios.get.mockResolvedValue({ running: [{ tableName: 'g2', name: '名2' }] })
    await loadKbNames()
    expect(axios.get).toHaveBeenCalledTimes(2)
  })

  it('只请求一次：并发/后续调用复用同一个 promise', async () => {
    axios.get.mockResolvedValue({ running: [] })
    const { loadKbNames } = await freshKbNames()

    const [a, b] = [loadKbNames(), loadKbNames()]
    await Promise.all([a, b])
    await loadKbNames()
    expect(axios.get).toHaveBeenCalledTimes(1)
  })

  it('空值与残缺条目不进表；未命中返回空串', async () => {
    axios.get.mockResolvedValue({
      running: [null, { tableName: '', name: '无名' }, { tableName: 'ok', name: '' }],
      dev: []
    })
    const { loadKbNames, kbDisplayName } = await freshKbNames()

    await loadKbNames()
    expect(kbDisplayName('ok')).toBe('')
    expect(kbDisplayName('miss')).toBe('')
  })
})

// useKbOptions / useValidateFiles 都要在组件 setup 里调（getCurrentInstance / proxy）：
// 用一个探针组件把组合函数的返回值抓出来。
async function mountProbe (bindSetup) {
  const { mountWithPlugins, flush } = await import('./helpers/mount')
  const wrapper = await mountWithPlugins({ name: 'KbdProbe', setup: bindSetup }, { router: null })
  await flush()
  return wrapper
}

describe('useKbOptions：知识库下拉的分组与互斥选中', () => {
  it('transKbsToGroupOptions：running 在前带「已发布」组名，dev 选项值带 |#|dev 后缀', async () => {
    let api
    await mountProbe(() => {
      api = useKbOptions()
      return () => h('div')
    })
    const groups = api.transKbsToGroupOptions({
      running: [{ tableName: 'graph_a', name: '图谱A' }],
      dev: [{ tableName: 'kb_b', name: '库B' }]
    })

    expect(groups).toHaveLength(2)
    // 探针挂的是真 i18n：组名走真词条（缺键会渲染成键名并被 expectNoI18nMisses 抓到）
    expect(groups[0].label).toBe('已发布')
    expect(groups[0].options).toEqual([
      { value: 'graph_a', label: '图谱A', status: 'running' }
    ])
    expect(groups[1].label).toBe('未发布')
    expect(groups[1].options).toEqual([
      { value: 'kb_b|#|dev', label: '库B', status: 'dev' }
    ])
  })

  it('空分组（缺 key 或空数组）不产组', async () => {
    let api
    await mountProbe(() => {
      api = useKbOptions()
      return () => h('div')
    })
    expect(api.transKbsToGroupOptions({ running: [], dev: [] })).toEqual([])
    expect(api.transKbsToGroupOptions({})).toEqual([])
  })

  it('transKbsToPublishedOptions：running+dev 合并成无标题的单组；全空返回 []', async () => {
    let api
    await mountProbe(() => {
      api = useKbOptions()
      return () => h('div')
    })
    const groups = api.transKbsToPublishedOptions({
      running: [{ tableName: 'g1', name: '图1' }],
      dev: [{ tableName: 'd1', name: '开1' }]
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('')
    // dev 也纳入且统一按 running 回显（后端剥后缀）
    expect(groups[0].options).toEqual([
      { value: 'g1', label: '图1', status: 'running' },
      { value: 'd1', label: '开1', status: 'running' }
    ])
    expect(api.transKbsToPublishedOptions({ running: [], dev: [] })).toEqual([])
  })

  it('kbOptionClickHandler：同库换状态先移旧再选新；取消选中/空列表不动', async () => {
    let api
    await mountProbe(() => {
      api = useKbOptions()
      return () => h('div')
    })
    // 空列表 / 取消选中 → 原样返回
    const none = []
    api.kbOptionClickHandler('kb|#|dev', none)
    expect(none).toEqual([])

    const selected = ['kb_a|#|dev', 'kb_b|#|dev']
    // 重复点已选中的 kb_a（running 态）：把同库条目全部移除后再把本值压回，kb_b 不受影响
    api.kbOptionClickHandler('kb_a|#|dev', selected)
    expect(selected).toEqual(['kb_b|#|dev', 'kb_a|#|dev'])

    // 点了未选中的值（如取消选中场景）→ 忽略，列表不动
    api.kbOptionClickHandler('kb_z', selected)
    expect(selected).toEqual(['kb_b|#|dev', 'kb_a|#|dev'])
  })

  it('transGroupOptions：running 带 assetId key、dev 带 kbasePkId key', async () => {
    let api
    await mountProbe(() => {
      api = useKbOptions()
      return () => h('div')
    })
    const groups = api.transGroupOptions({
      running: [{ assetId: 7, name: '图', tableName: 't' }],
      dev: [{ kbasePkId: 'pk-1', name: '库', tableName: 'k' }]
    })
    expect(groups[0].options[0]).toMatchObject({ key: 'assetId7', status: 'running' })
    expect(groups[1].options[0]).toMatchObject({ key: 'kbasePkIdpk-1', status: 'dev' })
  })

  it('createKbOptionClickHandler：按 tableName 互斥；新库直接返回', async () => {
    let api
    await mountProbe(() => {
      api = useKbOptions()
      return () => h('div')
    })
    const existing = [{ tableName: 'a', name: 'A' }, { tableName: 'b', name: 'B' }]
    // 新选择（没有同 tableName）→ 不动
    api.createKbOptionClickHandler({ tableName: 'c', name: 'C' }, existing)
    expect(existing).toHaveLength(2)

    // 重复选 b → 先移旧的 b，再 push 新引用（同库换状态）
    const next = { tableName: 'b', name: 'B2' }
    api.createKbOptionClickHandler(next, existing)
    expect(existing).toHaveLength(2)
    expect(existing[1]).toBe(next)

    // 空列表 / 取消选中 → 忽略
    const empty = []
    api.createKbOptionClickHandler({ tableName: 'a' }, empty)
    expect(empty).toEqual([])
  })
})

describe('useValidateFiles：上传前读首字节验证', () => {
  function fakeProxy () {
    return {
      $t: (key, params) => {
        if (key === 'public.comma') {
          return ','
        }
        return params ? `${key}?${JSON.stringify(params)}` : key
      }
    }
  }

  async function setup () {
    let api
    await mountProbe(() => {
      api = useValidateFiles(fakeProxy())
      return () => h('div')
    })
    return api
  }

  it('文件可读：validateFiles 返回 true', async () => {
    const api = await setup()
    const good = { name: 'a.txt', raw: { slice: () => new Blob(['x']) } }
    await expect(api.validateFiles([good])).resolves.toBe(true)
  })

  it('读失败的文件聚合进一条错误；消息带全部失败文件名', async () => {
    const api = await setup()
    const bad1 = { name: 'bad1.pdf', raw: { slice: () => new Blob(['x']) } }
    const bad2 = { name: 'bad2.docx', raw: { slice: () => new Blob(['x']) } }
    const good = { name: 'good.txt', raw: { slice: () => new Blob(['x']) } }

    const OriginalFileReader = global.FileReader
    class FlakyReader extends OriginalFileReader {
      readAsArrayBuffer () {
        if (this._isBad === undefined) {
          // 按创建顺序标记：前两次创建的 reader 都失败
          FlakyReader.calls = (FlakyReader.calls || 0) + 1
          this._isBad = FlakyReader.calls <= 2
        }
        setTimeout(() => {
          if (this._isBad) {
            this.onerror(new Event('error'))
          } else {
            this.onload(new Event('load'))
          }
        })
      }
    }
    global.FileReader = FlakyReader
    try {
      await expect(api.validateFiles([bad1, bad2, good]))
        .rejects.toThrow('public.readFilesFailure?{"fileName":"bad1.pdf,bad2.docx"}')
    } finally {
      global.FileReader = OriginalFileReader
      delete FlakyReader.calls
    }
  })

  it('getFileSuffix：取最后一个点之后并转小写', async () => {
    const api = await setup()
    expect(api.getFileSuffix({ name: 'a.B.PDF' })).toBe('pdf')
    expect(api.getFileSuffix({ name: 'noext' })).toBe('noext')
  })
})

describe('workflow/store：reactive 单例与旧 $store 兼容桥', () => {
  it('workflowState 是同一份单例，installLegacyWorkflowStateCompat 双向转发', async () => {
    const { workflowState, installLegacyWorkflowStateCompat } = await import('@/features/workflow/store')
    const rootState = {}
    installLegacyWorkflowStateCompat(rootState)

    workflowState.ragWorkflowType = 'SequentialQueryEngine'
    expect(rootState.ragWorkflowType).toBe('SequentialQueryEngine')

    rootState.ragWorkflowType = 'BlendedQueryEngine'
    expect(workflowState.ragWorkflowType).toBe('BlendedQueryEngine')

    workflowState.isAdvancedFlowEditMode = true
    expect(workflowState.isAdvancedFlowEditMode).toBe(true)
    expect(Object.keys(rootState)).toContain('ragWorkflowType')
  })
})

describe('api/kbaseApi.js：算子与文件上限的契约', () => {
  it('getSupportOperatorApi：module/formats 走 query 数组、keyword 单值', async () => {
    const { getSupportOperatorApi } = await import('@/features/knowledge-base/api/kbaseApi')
    await getSupportOperatorApi({ module: 'kb', formats: ['pdf', 'docx'], keyword: 'split' })
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/operators/available?module=kb&format=pdf&format=docx&keyword=split')
    )

    // 全默认：module 兜空串，没有 format/keyword 段
    await getSupportOperatorApi()
    const url = axios.get.mock.calls.at(-1)[0]
    expect(url).toContain('module=')
    expect(url).not.toContain('keyword')
  })

  it('uploadFileAndSplitConfigApi / getFileSizeInfoApi / checkAISEnvironmentApi 的动词与参数', async () => {
    const kbaseApi = await import('@/features/knowledge-base/api/kbaseApi')
    await kbaseApi.uploadFileAndSplitConfigApi('kb-9', { files: [] }, { headers: { X: '1' } })
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/knowledge-bases/kb-9/documents'),
      { files: [] },
      { headers: { X: '1' } }
    )

    await kbaseApi.getFileSizeInfoApi({ params: { category: 3 } })
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/system/file-size-limits'),
      { params: { category: 3 } }
    )

    await kbaseApi.checkAISEnvironmentApi()
    expect(axios.get).toHaveBeenLastCalledWith(expect.stringContaining('/system/info'))
    await kbaseApi.checkEnvironmentApi()
    expect(axios.get).toHaveBeenLastCalledWith(expect.stringContaining('/system/info'))
  })
})

describe('api/knowledgeBase.js：库 CRUD 与数据集查询', () => {
  it('建库 / 删库 / 单查 / 改库', async () => {
    const api = await import('@/features/knowledge-base/api/knowledgeBase')
    await api.createKnowledgeBase({ name: 'n' })
    expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/knowledge-bases'), { name: 'n' })

    await api.deleteKnowledgeBase('kb-1')
    expect(axios.delete).toHaveBeenCalledWith(expect.stringContaining('/knowledge-bases/kb-1'))

    await api.getKnowledgeBaseInfo('kb-2')
    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/knowledge-bases/kb-2'))

    await api.updatedKnowledgeBaseInfo('kb-3', { name: 'x' })
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/knowledge-bases/kb-3'),
      { name: 'x' }
    )
  })

  it('searchKbasesByName：categories=1 的模糊查询', async () => {
    const { searchKbasesByName } = await import('@/features/knowledge-base/api/knowledgeBase')
    await searchKbasesByName('merge-verify')
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/knowledge-bases'),
      { params: { categories: '1', page: 1, size: 50, keyword: 'merge-verify' } }
    )
  })

  it('getDatasetList：分页参数解包与默认值', async () => {
    const { getDatasetList } = await import('@/features/knowledge-base/api/knowledgeBase')
    await getDatasetList({ kbaseId: 'kb-4', currentPage: 2, pageSize: 5, keyword: 'k', extra: 1 })
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/knowledge-bases/kb-4/chunks'),
      { params: { keyword: 'k', page: 2, size: 5, extra: 1 } }
    )

    await getDatasetList({ kbaseId: 'kb-4' })
    expect(axios.get).toHaveBeenLastCalledWith(
      expect.any(String),
      { params: { keyword: '', page: 1, size: 20 } }
    )
  })

  it('getFileDatasetApi：单文件切片查询透传 config', async () => {
    const { getFileDatasetApi } = await import('@/features/knowledge-base/api/knowledgeBase')
    await getFileDatasetApi('f-1', { kbaseId: 'kb-5' }, { signal: 'sig' })
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/knowledge-bases/kb-5/documents/f-1/chunks'),
      { params: { keyword: '', page: 1, size: 10 }, signal: 'sig' }
    )
  })
})

describe('workflow/api：工作流 CRUD 的动词与路径', () => {
  it('flow 配置的读写与校验', async () => {
    const api = await import('@/features/workflow/api/workflow')
    await api.getFlowConfig('app-1')
    expect(axios.get).toHaveBeenLastCalledWith(expect.stringContaining('/workflows/app-1/flow'), {})

    await api.getPublishedFlowConfig('app-1')
    expect(axios.get).toHaveBeenLastCalledWith(expect.stringContaining('/workflows/app-1/publication'))

    await api.checkSaveFlowConfig('app-1', { a: 1 }, { headers: {} })
    expect(axios.post).toHaveBeenLastCalledWith(
      expect.stringContaining('/workflows/app-1/validate'),
      { a: 1 },
      { headers: {} }
    )

    await api.saveFlowConfig('app-1', { nodes: [] })
    expect(axios.put).toHaveBeenLastCalledWith(
      expect.stringContaining('/workflows/app-1/flow'),
      { nodes: [] },
      {}
    )
  })

  it('列表 / 创建 / 更新（三种 id 字段兜底）/ 删除', async () => {
    const api = await import('@/features/workflow/api/workflow')
    await api.getFlowList(2, 20, '关键词')
    expect(axios.get).toHaveBeenLastCalledWith(
      expect.stringContaining('/workflows'),
      { params: { page: 2, size: 20, keyword: '关键词' } }
    )

    await api.createFlow({ name: 'wf' })
    expect(axios.post).toHaveBeenLastCalledWith(expect.stringContaining('/workflows'), { name: 'wf' }, {})

    await api.updateFlow({ workFlowId: 'id-1', name: 'a' })
    await api.updateFlow({ workflowId: 'id-2', name: 'b' })
    await api.updateFlow({ appId: 'id-3', name: 'c' })
    const patchUrls = axios.patch.mock.calls.map(call => call[0])
    expect(patchUrls.some(url => String(url).includes('id-1'))).toBe(true)
    expect(patchUrls.some(url => String(url).includes('id-2'))).toBe(true)
    expect(patchUrls.some(url => String(url).includes('id-3'))).toBe(true)

    await api.deleteFlowApi('wf-9')
    expect(axios.delete).toHaveBeenCalledWith(expect.stringContaining('/workflows/wf-9'))
  })

  it('知识库下拉（getAllStatusKbase / getAllKBList 同路径不同函数）', async () => {
    const api = await import('@/features/workflow/api/workflow')
    await api.getAllStatusKbase({ keyword: 'x' })
    await api.getAllKBList()
    expect(axios.get).toHaveBeenCalledTimes(2)
    expect(String(axios.get.mock.calls[0][0])).toContain('/workflows/knowledge-bases')
    expect(String(axios.get.mock.calls[1][0])).toContain('/workflows/knowledge-bases')
  })

  it('导出（blob）/ 发布（带 auto-install 头）/ 取消发布', async () => {
    const api = await import('@/features/workflow/api/workflow')
    await api.exportWorkFlow('app-2')
    expect(axios.get).toHaveBeenLastCalledWith(
      expect.stringContaining('/workflows/app-2/export'),
      { responseType: 'blob' }
    )

    await api.publishWorkFlow('app-3')
    expect(axios.post).toHaveBeenLastCalledWith(
      expect.stringContaining('/workflows/app-3/publication'),
      null,
      { headers: { 'auto-install': 'true' } }
    )

    await api.unpublishWorkFlow('app-3')
    expect(axios.delete).toHaveBeenLastCalledWith(
      expect.stringContaining('/workflows/app-3/publication')
    )
  })
})
