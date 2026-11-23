// @vitest-environment jsdom
/**
 * useGraphThumbnail —— 左下角缩略图（minimap）快照。
 *
 * 投影数学在 lib/graph-thumbnail（有独立单测），这里钉的是「取数 + 计时器生命周期」：
 * - 开启时立即刷两次 + 300ms 补刷 + 800ms 轮询；关闭时清快照并停表；
 * - 画布重绘（after-drawing）与节点/边数量变化只在开启时刷新；
 * - 取不到 network / 没有可见节点 / 投影失败 → 清空快照而不是留残影。
 * 轮询用 fake timer；composable 挂了 onBeforeUnmount/watch，包进宿主组件挂载。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'

import { useGraphThumbnail } from '@/features/graph/composables/useGraphThumbnail'
import { projectThumbnailLayout } from '@/features/graph/lib/graph-thumbnail'

/** 造一个够用的假 vis-network：body 里放节点/边，供 refreshThumbnailSnapshot 取数 */
function makeNetwork (nodeSpecs, edgeSpecs = []) {
  const body = {
    nodes: Object.fromEntries(nodeSpecs.map(n => [n.id, n])),
    edges: Object.fromEntries(edgeSpecs.map(e => [e.id, e]))
  }
  return {
    body,
    getViewPosition: () => ({ x: 0, y: 0 }),
    getScale: () => 1
  }
}

const TONES = { colorMap: { Scene: '#8045ff' } }

function mountThumbnail ({ graphData = { entities: [], edges: [] }, network = null, container = { clientWidth: 800, clientHeight: 600 } } = {}) {
  const graphCanvasRef = ref(network ? { getNetwork: () => network } : {})
  const graphContainer = ref(container)
  const graphDataCache = ref(graphData)
  const store = ref(null)
  const Host = defineComponent({
    setup () {
      store.value = useGraphThumbnail({
        graphCanvasRef,
        graphContainer,
        graphDataCache,
        tones: TONES
      })
      return () => h('div')
    }
  })
  const wrapper = mount(Host)
  return { wrapper, thumb: store.value, graphDataCache }
}

async function enableThumbnail (thumb) {
  thumb.toggleThumbnail()
  await nextTick()
}

describe('useGraphThumbnail', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // mock requestAnimationFrame：scheduleUpdateExpandOverlays 等走 rAF 的逻辑在 jsdom 无头环境下不会跑
    vi.stubGlobal('requestAnimationFrame', (cb) => { cb(Date.now()) })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('未开启时 refreshThumbnailSnapshot / handleCanvasAfterDrawing 都是空操作', async () => {
    const network = makeNetwork([{ id: 'n1', x: 0, y: 0, options: {} }])
    const { thumb } = mountThumbnail({ network })

    thumb.refreshThumbnailSnapshot()
    thumb.handleCanvasAfterDrawing()
    await nextTick()
    vi.advanceTimersByTime(1000)

    expect(thumb.thumbnailEnabled).toBe(false)
    expect(thumb.thumbnailSvgNodes).toEqual([])
  })

  it('toggleThumbnail 开启：nextTick 后立即刷一次，0ms 与 300ms 各补刷一次，800ms 轮询', async () => {
    const network = makeNetwork([{ id: 'n1', x: 0, y: 0, options: {} }])
    const { thumb } = mountThumbnail({ network })

    await enableThumbnail(thumb)
    expect(thumb.thumbnailEnabled).toBe(true)
    expect(thumb.thumbnailSvgNodes).toHaveLength(1)

    const afterImmediate = thumb.thumbnailSvgNodes.length
    vi.advanceTimersByTime(1)
    expect(thumb.thumbnailSvgNodes.length).toBe(afterImmediate)
    vi.advanceTimersByTime(300)
    expect(thumb.thumbnailSvgNodes.length).toBe(afterImmediate)

    // 800ms 轮询持续推进（两次周期后快照仍在刷新，说明 interval 活着）
    vi.advanceTimersByTime(1600)
    expect(thumb.thumbnailEnabled).toBe(true)
    expect(thumb.thumbnailSvgNodes).toHaveLength(1)
  })

  it('toggleThumbnail 关闭：清空快照并停表（800ms 轮询不再推进）', async () => {
    const network = makeNetwork([{ id: 'n1', x: 0, y: 0, options: {} }])
    const { thumb } = mountThumbnail({ network })

    await enableThumbnail(thumb)
    // 先让开启时补刷的 0ms / 300ms 一次性计时器走完，只剩 800ms 轮询
    vi.advanceTimersByTime(400)

    thumb.toggleThumbnail()
    expect(thumb.thumbnailEnabled).toBe(false)
    expect(thumb.thumbnailSvgNodes).toEqual([])
    expect(thumb.thumbnailSvgEdges).toEqual([])
    expect(thumb.clampedThumbnailViewportRect).toBeNull()

    thumb.refreshThumbnailSnapshot()
    vi.advanceTimersByTime(2000)
    expect(thumb.thumbnailSvgNodes).toEqual([])
  })

  it('快照取数：隐藏节点与非有限坐标被过滤，边端点取 from/to，颜色按 colorMap 兜底', async () => {
    const network = makeNetwork(
      [
        { id: 'n1', x: 10, y: 20, options: {}, from: undefined },
        { id: 'n2', x: NaN, y: 0, options: {} },
        { id: 'n3', x: 5, y: 5, options: { hidden: true } }
      ],
      [
        { id: 'r1', options: {}, from: { x: 10, y: 20 }, to: { x: 30, y: 40 } },
        { id: 'r2', options: { hidden: true }, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }
      ]
    )
    const { thumb } = mountThumbnail({
      network,
      graphData: { entities: [{ entity_id: 'n1', entity_type: 'Scene' }], edges: [] }
    })

    await enableThumbnail(thumb)

    expect(thumb.thumbnailSvgNodes).toHaveLength(1)
    expect(thumb.thumbnailSvgNodes[0].color).toBe('#8045ff')
    expect(thumb.thumbnailSvgEdges).toHaveLength(1)
    expect(thumb.clampedThumbnailViewportRect).not.toBeNull()
    // 投影结果确实来自 lib/graph-thumbnail 的纯函数
    expect(thumb.thumbnailSvgNodes[0].x).toBe(
      projectThumbnailLayout({
        rawNodes: [{ id: 'n1', x: 10, y: 20, color: '#8045ff' }],
        rawEdges: [{ id: 'r1', x1: 10, y1: 20, x2: 30, y2: 40 }],
        view: { x: 0, y: 0 },
        zoomScale: 1,
        containerWidth: 800,
        containerHeight: 600
      }).nodes[0].x
    )
  })

  it('没有可见节点时清空快照（不留上一帧的残影）', async () => {
    const network = makeNetwork([{ id: 'n1', x: 0, y: 0, options: {} }])
    const { thumb } = mountThumbnail({ network })

    await enableThumbnail(thumb)
    expect(thumb.thumbnailSvgNodes).toHaveLength(1)

    // 节点全部隐藏后再刷
    network.body.nodes.n1.options.hidden = true
    thumb.refreshThumbnailSnapshot()

    expect(thumb.thumbnailSvgNodes).toEqual([])
    expect(thumb.clampedThumbnailViewportRect).toBeNull()
  })

  it('画布没挂载 / network 为 null 时刷新是安全空操作', async () => {
    const { thumb } = mountThumbnail({ network: null })

    await enableThumbnail(thumb)
    expect(() => thumb.refreshThumbnailSnapshot()).not.toThrow()
    expect(thumb.thumbnailSvgNodes).toEqual([])
  })

  it('projectThumbnailLayout 返回 null（无节点）时同样清空快照', async () => {
    const network = makeNetwork([])
    const { thumb } = mountThumbnail({ network })

    await enableThumbnail(thumb)
    expect(thumb.thumbnailSvgNodes).toEqual([])
  })

  it('handleCanvasAfterDrawing：开启时 nextTick 后刷新；关闭时不刷', async () => {
    const network = makeNetwork([{ id: 'n1', x: 0, y: 0, options: {} }])
    const { thumb } = mountThumbnail({ network })

    await enableThumbnail(thumb)
    network.body.nodes.n1.x = 50
    thumb.handleCanvasAfterDrawing()
    await nextTick()
    const moved = thumb.thumbnailSvgNodes[0].x
    expect(moved).not.toBeNaN()

    thumb.toggleThumbnail()
    thumb.handleCanvasAfterDrawing()
    await nextTick()
    expect(thumb.thumbnailSvgNodes).toEqual([])
  })

  it('节点/边数量变化（watch 缓存）时同步刷新缩略图', async () => {
    const network = makeNetwork([{ id: 'n1', x: 0, y: 0, options: {} }])
    const { thumb, graphDataCache } = mountThumbnail({
      network,
      graphData: { entities: [{ entity_id: 'n1', entity_type: 'Scene' }], edges: [] }
    })

    await enableThumbnail(thumb)
    expect(thumb.thumbnailSvgNodes).toHaveLength(1)

    network.body.nodes.n2 = { id: 'n2', x: 30, y: 30, options: {} }
    graphDataCache.value = {
      entities: [{ entity_id: 'n1', entity_type: 'Scene' }, { entity_id: 'n2', entity_type: 'Scene' }],
      edges: []
    }
    // watch 回调自身排在 nextTick 里，两层 flush 才能落到快照
    await nextTick()
    await nextTick()

    expect(thumb.thumbnailSvgNodes).toHaveLength(2)
  })

  it('卸载时停掉轮询计时器（先把补刷用的一次性计时器走完再卸载）', async () => {
    const network = makeNetwork([{ id: 'n1', x: 0, y: 0, options: {} }])
    const { wrapper, thumb } = mountThumbnail({ network })

    await enableThumbnail(thumb)
    vi.advanceTimersByTime(400)
    wrapper.unmount()

    vi.advanceTimersByTime(3000)
    expect(thumb.thumbnailSvgNodes).toEqual([])
  })

  it('clampedThumbnailViewportRect 对越界视口矩形做裁剪（交给 lib 纯函数）', async () => {
    const network = makeNetwork([{ id: 'n1', x: 0, y: 0, options: {} }])
    const { thumb } = mountThumbnail({
      network,
      container: { clientWidth: 8000, clientHeight: 6000 }
    })

    await enableThumbnail(thumb)
    const rect = thumb.clampedThumbnailViewportRect
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(260)
    expect(rect.y + rect.height).toBeLessThanOrEqual(150)
  })
})
