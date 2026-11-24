// @vitest-environment jsdom
/**
 * useEntityExpand —— 实体展开/收起（画布节点右上角 +/- 图标）的状态落盘。
 *
 * 图遍历（DFS 收出向子孙）在 lib/graph-descendants 有独立单测，这里钉的是：
 * - 收起：子孙 id 记入 hiddenNodeIds（Set 整体替换触发响应式），节点标成「已收起」；
 * - 展开：整棵出向子树恢复可见，仍有出向边的中间节点标「已展开」（右上角显示减号）；
 * - toggle：默认展开态，stopPropagation 防止触发节点点击；画布可见性 nextTick 同步。
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import { useEntityExpand } from '@/features/graph/composables/useEntityExpand'

function makeGraph () {
  // a → b → c；c → d；d → a（环：展开/收起都必须能终止）
  const entities = [
    { entity_id: 'a', entity_type: 'Scene' },
    { entity_id: 'b', entity_type: 'Scene' },
    { entity_id: 'c', entity_type: 'Scene' },
    { entity_id: 'd', entity_type: 'Scene' }
  ]
  const edges = [
    { edge_id: 'r1', source_id: 'a', target_id: 'b' },
    { edge_id: 'r2', source_id: 'b', target_id: 'c' },
    { edge_id: 'r3', source_id: 'c', target_id: 'd' },
    { edge_id: 'r4', source_id: 'd', target_id: 'a' }
  ]
  return { entities, edges }
}

function makeCtx ({ graphCanvasRef = ref(null) } = {}) {
  const { entities, edges } = makeGraph()
  const proxy = {
    $t: vi.fn((key) => key),
    $message: { success: vi.fn(), error: vi.fn() }
  }
  const ctx = {
    proxy,
    graphDataCache: ref({ entities, edges }),
    graphCanvasRef
  }
  return { ctx, expand: useEntityExpand(ctx) }
}

describe('useEntityExpand', () => {
  it('收起实体：整棵出向子树进 hiddenNodeIds，节点标记为已收起，并同步画布可见性', async () => {
    const graphCanvasRef = ref({ syncVisibilityFromHiddenProps: vi.fn() })
    const { expand } = makeCtx({ graphCanvasRef })

    expand.toggleEntityExpand({ entity_id: 'a' }, { stopPropagation: vi.fn() })
    await nextTick()

    expect([...expand.persistentlyHiddenNodeIdsList]).toEqual(['b', 'c', 'd'])
    expect(expand.entityExpandStateForCanvas).toEqual({ a: false })
    expect(graphCanvasRef.value.syncVisibilityFromHiddenProps).toHaveBeenCalledTimes(1)
  })

  it('展开实体：子树恢复可见，仍有出向边的中间节点保持「已展开」（显示减号）', async () => {
    const { expand } = makeCtx()
    expand.toggleEntityExpand({ entity_id: 'a' }, { stopPropagation: vi.fn() })
    expand.toggleEntityExpand({ entity_id: 'a' }, { stopPropagation: vi.fn() })
    await nextTick()

    expect(expand.persistentlyHiddenNodeIdsList).toEqual([])
    // b 有出向边（b→c）→ 已展开；c 有出向边（c→d）→ 已展开；d 的出向边指向已可见的 a，同样标已展开
    expect(expand.entityExpandStateForCanvas).toEqual({ a: true, b: true, c: true, d: true })
  })

  it('toggle 默认按「已展开」处理：第一次点击是收起，事件冒泡被阻止', () => {
    const { expand } = makeCtx()
    const stopPropagation = vi.fn()

    expand.toggleEntityExpand({ entity_id: 'a' }, { stopPropagation })

    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(expand.persistentlyHiddenNodeIdsList).toEqual(['b', 'c', 'd'])
  })

  it('toggle 无实体时直接返回', () => {
    const { expand } = makeCtx()
    expand.toggleEntityExpand(null, { stopPropagation: vi.fn() })
    expect(expand.persistentlyHiddenNodeIdsList).toEqual([])
  })

  it('handleToggleExpandFromCanvas：nodeId 换回实体对象再切换；未知 id 是空操作', async () => {
    const { expand } = makeCtx()

    expand.handleToggleExpandFromCanvas('a')
    expect(expand.persistentlyHiddenNodeIdsList).toEqual(['b', 'c', 'd'])

    expand.handleToggleExpandFromCanvas('ghost')
    expect(expand.persistentlyHiddenNodeIdsList).toEqual(['b', 'c', 'd'])

    expand.handleToggleExpandFromCanvas('a')
    expect(expand.persistentlyHiddenNodeIdsList).toEqual([])
  })

  it('收起后再次收起幂等（重复点减号不重复追加/不报错）', async () => {
    const { expand } = makeCtx()
    expand.toggleEntityExpand({ entity_id: 'a' }, { stopPropagation: vi.fn() })
    expand.toggleEntityExpand({ entity_id: 'a' }, { stopPropagation: vi.fn() })
    expand.toggleEntityExpand({ entity_id: 'a' }, { stopPropagation: vi.fn() })

    expect(expand.persistentlyHiddenNodeIdsList).toEqual(['b', 'c', 'd'])
  })

  it('只收起中间节点：b 的整棵出向子树（c→d→a 环）都藏，但不动 b 自己', () => {
    const { expand } = makeCtx()
    expand.handleToggleExpandFromCanvas('b')

    expect(expand.persistentlyHiddenNodeIdsList).toEqual(['c', 'd', 'a'])
    expect(expand.entityExpandStateForCanvas).toEqual({ b: false })
  })

  it('没有画布（ref 为空）时收起不炸，照常落状态', () => {
    const { expand } = makeCtx({ graphCanvasRef: ref(null) })

    expand.handleToggleExpandFromCanvas('a')

    expect(expand.persistentlyHiddenNodeIdsList).toEqual(['b', 'c', 'd'])
  })

  it('收起/展开都有成功提示（用户可见反馈出口）', () => {
    const { ctx, expand } = makeCtx()

    expand.handleToggleExpandFromCanvas('a')
    expect(ctx.proxy.$message.success).toHaveBeenCalledTimes(1)

    expand.handleToggleExpandFromCanvas('a')
    expect(ctx.proxy.$message.success).toHaveBeenCalledTimes(2)
  })

  it('entityExpandStateForCanvas 把未显式收起的键视为展开（v !== false）', () => {
    const { expand } = makeCtx()
    expand.handleToggleExpandFromCanvas('b')

    expect(expand.entityExpandStateForCanvas).toEqual({ b: false })
  })
})
