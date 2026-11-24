// @vitest-environment jsdom
// workflow 模块的轻 composable：useNode（输入变量上移/下移）、useRowDrop（表格行
// 拖拽排序，Sortable 换桩）、flowNodeDefaults（新节点默认 variables）、
// useCustomOperator（自定义算子拉取与加入算子链，挂在真组件 setup 里驱动）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

// ── useNode.ts ───────────────────────────────────────────────────────────────
import { useNode } from '@/features/workflow/useNode'

describe('useNode：输入变量上移 / 下移', () => {
  function makeProps (keys) {
    return { nodeInfo: { inputVariables: keys.map(key => ({ key })) } }
  }

  /** 源码交换后会把数组再包一层 ref（依赖父级 reactive 自动解包）；测试里手动取值。 */
  function listOf (props) {
    const list = props.nodeInfo.inputVariables
    return (Array.isArray(list) ? list : list.value).map(v => v.key)
  }

  it('inputUpHandle：与前一项交换位置', () => {
    const props = makeProps(['a', 'b', 'c'])
    const { inputUpHandle } = useNode(props)
    inputUpHandle(1)
    expect(listOf(props)).toEqual(['b', 'a', 'c'])
  })

  it('inputDownHandle：与后一项交换位置', () => {
    const props = makeProps(['a', 'b', 'c'])
    const { inputDownHandle } = useNode(props)
    inputDownHandle(1)
    expect(listOf(props)).toEqual(['a', 'c', 'b'])
  })

  it('交换后包一层 ref（配合父级 reactive 自动解包保持响应式）', () => {
    const props = makeProps(['a', 'b'])
    const { inputUpHandle } = useNode(props)
    inputUpHandle(1)
    expect(props.nodeInfo.inputVariables).not.toBe(props.nodeInfo.inputVariables.value)
  })
})

// ── flowNodeDefaults.js ──────────────────────────────────────────────────────
import { createDefaultVariables } from '@/features/workflow/modules/flowNodeDefaults'
import {
  EXTERNAL_MODEL_RERANKER_OPERATOR
} from '@/features/workflow/lib/externalModelReranker'

describe('flowNodeDefaults：新拖入节点的默认 variables', () => {
  it('四个业务节点各有一份默认算子链', () => {
    expect(createDefaultVariables('PRE_RETRIEVER')).toEqual({
      preretriever: [expect.objectContaining({
        operator: 'LLMQueryRewriter',
        kwargs: expect.objectContaining({ multi_chat_limit: 0 })
      })]
    })
    expect(createDefaultVariables('RETRIEVER')).toEqual({
      retriever: [expect.objectContaining({
        operator: 'VectorRetriever',
        kwargs: expect.objectContaining({
          strategy: 0,
          knowledge_info_list: [expect.objectContaining({ top_k: 8, score: 0.3, priority: 10 })]
        })
      })]
    })
    expect(createDefaultVariables('POST_RETRIEVER')).toEqual({
      postretriever: [expect.objectContaining({
        operator: EXTERNAL_MODEL_RERANKER_OPERATOR,
        kwargs: expect.objectContaining({ model: '', top_n: 4 })
      })]
    })
    expect(createDefaultVariables('RESPONSE_SYNTHESIZER')).toEqual({
      responsesynthesizer: [expect.objectContaining({
        operator: 'RagSimpleSummarizer',
        kwargs: expect.objectContaining({ 'generator-config': [expect.objectContaining({ temperature: 0.01 })] })
      })]
    })
  })

  it('每次调用返回全新对象（节点之间不共享引用）', () => {
    const a = createDefaultVariables('RETRIEVER')
    const b = createDefaultVariables('RETRIEVER')
    expect(a).not.toBe(b)
    expect(a.retriever[0]).not.toBe(b.retriever[0])
  })

  it('固定节点（QUERY / RESPONSE / 未知 shape）返回 null', () => {
    expect(createDefaultVariables('QUERY')).toBeNull()
    expect(createDefaultVariables('RESPONSE')).toBeNull()
    expect(createDefaultVariables('Whatever')).toBeNull()
  })
})

// ── useRowDrop.js ────────────────────────────────────────────────────────────
const sortableCreate = vi.hoisted(() => vi.fn())
vi.mock('sortablejs', () => ({ default: { create: sortableCreate } }))

import { useRowDrop } from '@/features/workflow/modules/useRowDrop'

describe('useRowDrop：表格行拖拽排序', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <table class="el-table__body-wrapper"><tbody>
        <tr class="el-table__row"><td><span class="btn-drag"></span></td></tr>
        <tr class="el-table__row"><td><span class="btn-drag"></span></td></tr>
      </tbody></table>`
    sortableCreate.mockClear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('rowDrop：把手 .btn-drag，只允许拖 .el-table__row', () => {
    const { rowDrop } = useRowDrop([])
    rowDrop()
    expect(sortableCreate).toHaveBeenCalledTimes(1)
    const [tbody, config] = sortableCreate.mock.calls[0]
    expect(tbody).toBe(document.querySelector('.el-table__body-wrapper tbody'))
    expect(config.handle).toBe('.btn-drag')
    expect(config.draggable).toBe('.el-table__row')
    expect(config.animation).toBe(500)
  })

  it('onEnd：按 oldIndex 移除、newIndex 插回（拖拽排序的真实语义）', () => {
    const tableData = [{ id: 1 }, { id: 2 }, { id: 3 }]
    useRowDrop(tableData).rowDrop()
    const { onEnd } = sortableCreate.mock.calls[0][1]
    onEnd({ oldIndex: 2, newIndex: 0 })
    expect(tableData.map(row => row.id)).toEqual([3, 1, 2])
  })
})

// ── useCustomOperator.js ─────────────────────────────────────────────────────
const operatorsApi = vi.hoisted(() => ({ getCustomOperatorList: vi.fn() }))
vi.mock('@/features/operators/api/operators', () => ({
  getCustomOperatorListApi: (...args) => operatorsApi.getCustomOperatorList(...args)
}))

import { useCustomOperator } from '@/features/workflow/modules/useCustomOperator'

describe('useCustomOperator：自定义算子', () => {
  /** 在真组件 setup 里调用 composable（onMounted 需要 effect scope）。 */
  async function mountComposable (operatorList, options = {}) {
    let api = null
    const showAddOperatorPopover = ref(true)
    const Harness = defineComponent({
      setup () {
        api = useCustomOperator({ $refs: {} }, {
          props: { nodeId: 'node-9' },
          type: 'retriever',
          operatorList,
          showAddOperatorPopover,
          ...options
        })
        return () => h('div')
      }
    })
    const { mount } = await import('@vue/test-utils')
    const wrapper = mount(Harness)
    await Promise.resolve()
    await Promise.resolve()
    return { wrapper, api, showAddOperatorPopover }
  }

  beforeEach(() => {
    operatorsApi.getCustomOperatorList.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('挂载即拉自定义算子清单，结果进 customOperatorList', async () => {
    operatorsApi.getCustomOperatorList.mockResolvedValue([{ operator: 'MyOp' }])
    const { api, wrapper } = await mountComposable(ref([]))
    await Promise.resolve()
    expect(operatorsApi.getCustomOperatorList).toHaveBeenCalledWith('retriever')
    expect(api.customOperatorList.value).toEqual([{ operator: 'MyOp' }])
    wrapper.unmount()
  })

  it('接口失败只记日志，不炸组件', async () => {
    operatorsApi.getCustomOperatorList.mockRejectedValue(new Error('boom'))
    const { api, wrapper } = await mountComposable(ref([]))
    await Promise.resolve()
    await Promise.resolve()
    expect(console.error).toHaveBeenCalled()
    expect(api.customOperatorList.value).toEqual([])
    wrapper.unmount()
  })

  it('addCustomOperatorWithType：组好新算子（id=nodeId_3位uuid）并关掉弹层', async () => {
    const operatorList = ref([])
    const { api, showAddOperatorPopover, wrapper } = await mountComposable(operatorList)
    api.addCustomOperatorWithType({
      position: 'pkg.custom.MyOp',
      operator: 'MyOp',
      defaultArgs: { k: 1 },
      operatorName: '我的算子'
    })
    expect(operatorList.value).toHaveLength(1)
    const added = operatorList.value[0]
    expect(added.id).toMatch(/^node-9_[0-9a-f]{3}$/)
    expect(added).toEqual({
      id: added.id,
      package: 'pkg.custom.MyOp',
      operator: 'MyOp',
      kwargs: { k: 1 },
      showConfig: false,
      operatorName: '我的算子',
      custom: true
    })
    expect(showAddOperatorPopover.value).toBe(false)
    wrapper.unmount()
  })

  it('row 字段缺省时用 optional chaining 兜底', async () => {
    const operatorList = ref([])
    const { api, wrapper } = await mountComposable(operatorList)
    api.addCustomOperatorWithType(undefined)
    expect(operatorList.value[0].package).toBeUndefined()
    expect(operatorList.value[0].operator).toBeUndefined()
    wrapper.unmount()
  })

  it('generateRandomUUID：3 位、无连字符', async () => {
    const { api, wrapper } = await mountComposable(ref([]))
    const id = api.generateRandomUUID()
    expect(id).toMatch(/^[0-9a-f]{3}$/)
    expect(id).not.toContain('-')
    wrapper.unmount()
  })
})
