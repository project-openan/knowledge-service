// 缩略图坐标投影与视口裁剪的纯数学单测（lib/graph-thumbnail.js）。
import {
  THUMBNAIL_SVG_W,
  THUMBNAIL_SVG_H,
  projectThumbnailLayout,
  clampThumbnailViewportRect
} from '@/features/graph/lib/graph-thumbnail'

describe('常量', () => {
  it('缩略图 viewBox 尺寸 260x150', () => {
    expect(THUMBNAIL_SVG_W).toBe(260)
    expect(THUMBNAIL_SVG_H).toBe(150)
  })
})

describe('projectThumbnailLayout', () => {
  it('无节点返回 null（调用方据此清空快照）', () => {
    expect(projectThumbnailLayout({ rawNodes: [], rawEdges: [] })).toBeNull()
  })

  it('节点投影进 svg 内且按包围盒等比缩放居中；边端点同步换算', () => {
    const result = projectThumbnailLayout({
      rawNodes: [
        { id: 'a', x: 0, y: 0, color: 'red' },
        { id: 'b', x: 100, y: 100, color: 'blue' }
      ],
      rawEdges: [{ id: 'e1', x1: 0, y1: 0, x2: 100, y2: 100 }]
    })
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]).toEqual(expect.objectContaining({ id: 'a', color: 'red' }))
    // 图为正方形，缩放受高度约束：(150-16)/100 = 1.34
    const scale = (THUMBNAIL_SVG_H - 16) / 100
    expect(result.nodes[0].x).toBeCloseTo((THUMBNAIL_SVG_W - 100 * scale) / 2, 5)
    expect(result.nodes[1].y).toBeCloseTo((THUMBNAIL_SVG_H + 100 * scale) / 2, 5)
    expect(result.edges[0]).toEqual({
      id: 'e1',
      x1: result.nodes[0].x,
      y1: result.nodes[0].y,
      x2: result.nodes[1].x,
      y2: result.nodes[1].y
    })
    // 无视口信息时不产视口矩形
    expect(result.viewportRect).toBeNull()
  })

  it('退化包围盒（所有点重合）按 1x1 处理不除零', () => {
    const result = projectThumbnailLayout({
      rawNodes: [{ id: 'a', x: 5, y: 5 }],
      rawEdges: []
    })
    // graphWidth/Height 取下限 1 → scale = min(244, 134) = 134；
    // offsetX = (260-134)/2 - 5*134 = -607，mapX(5) = 5*134-607 = 63；mapY(5) = 8
    expect(result.nodes[0].x).toBeCloseTo(63, 5)
    expect(result.nodes[0].y).toBeCloseTo(8, 5)
  })

  it('非有限端点的边被过滤掉', () => {
    const result = projectThumbnailLayout({
      rawNodes: [{ id: 'a', x: 0, y: 0 }],
      rawEdges: [
        { id: 'bad', x1: NaN, y1: 0, x2: 1, y2: 1 },
        { id: 'good', x1: 0, y1: 0, x2: 0, y2: 0 }
      ]
    })
    expect(result.edges.map(e => e.id)).toEqual(['good'])
  })

  it('视口矩形按 zoomScale 换算；缩放/容器尺寸非法时不产矩形', () => {
    const base = {
      rawNodes: [{ id: 'a', x: 0, y: 0 }],
      rawEdges: []
    }
    // 非法组合：view 缺失 / zoom<=0 / 容器<=0
    expect(projectThumbnailLayout({ ...base, view: { x: 0, y: 0 }, zoomScale: 1, containerWidth: 0, containerHeight: 100 }).viewportRect).toBeNull()
    expect(projectThumbnailLayout({ ...base, view: { x: 0, y: 0 }, zoomScale: 0, containerWidth: 100, containerHeight: 100 }).viewportRect).toBeNull()
    expect(projectThumbnailLayout({ ...base, view: { x: 0, y: 0 }, zoomScale: NaN, containerWidth: 100, containerHeight: 100 }).viewportRect).toBeNull()
    expect(projectThumbnailLayout({ ...base, zoomScale: 1, containerWidth: 100, containerHeight: 100 }).viewportRect).toBeNull()

    const result = projectThumbnailLayout({
      ...base,
      view: { x: 5, y: 5 },
      zoomScale: 2,
      containerWidth: 200,
      containerHeight: 100
    })
    // 单点图 graphWidth/Height 均取下限 1，pad 8 → scale = min(244,134) = 134；
    // 视口宽 = containerWidth * scale / zoomScale = 200*134/2 = 13400
    expect(result.viewportRect).not.toBeNull()
    expect(result.viewportRect.width).toBe(13400)
    expect(result.viewportRect.height).toBe(6700)
  })
})

describe('clampThumbnailViewportRect', () => {
  it('null / 非有限字段 → null', () => {
    expect(clampThumbnailViewportRect(null)).toBeNull()
    expect(clampThumbnailViewportRect(undefined)).toBeNull()
    expect(clampThumbnailViewportRect({ x: NaN, y: 0, width: 10, height: 10 })).toBeNull()
    expect(clampThumbnailViewportRect({ x: 0, y: 0, width: 'bad', height: 10 })).toBeNull()
  })

  it('完全在画布外 → null', () => {
    expect(clampThumbnailViewportRect({ x: 260, y: 0, width: 10, height: 10 })).toBeNull()
    expect(clampThumbnailViewportRect({ x: 0, y: 150, width: 10, height: 10 })).toBeNull()
  })

  it('负坐标与超界宽高被夹回画布内', () => {
    expect(clampThumbnailViewportRect({ x: -10, y: -10, width: 400, height: 400 }))
      .toEqual({ x: 0, y: 0, width: 260, height: 150 })
    expect(clampThumbnailViewportRect({ x: 250, y: 140, width: 100, height: 100 }))
      .toEqual({ x: 250, y: 140, width: 10, height: 10 })
  })

  it('裁剪后不足 1px → null（不渲染高亮）', () => {
    expect(clampThumbnailViewportRect({ x: 259.5, y: 0, width: 3, height: 10 })).toBeNull()
    expect(clampThumbnailViewportRect({ x: 0, y: 149.5, width: 10, height: 3 })).toBeNull()
    expect(clampThumbnailViewportRect({ x: 0, y: 0, width: 0, height: 0 })).toBeNull()
  })

  it('字符串数字被 Number 化后正常裁剪', () => {
    expect(clampThumbnailViewportRect({ x: '10', y: '10', width: '20', height: '20' }))
      .toEqual({ x: 10, y: 10, width: 20, height: 20 })
  })
})
