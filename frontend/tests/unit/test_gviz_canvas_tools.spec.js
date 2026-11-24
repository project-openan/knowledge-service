// @vitest-environment jsdom
/**
 * GraphCanvasTools.vue —— 画布左下角工具簇（缩略图 / 缩放 / 图例 / 连线标签模式）。
 *
 * viewport / thumbnail / tones 传手工 reactive 桩，逐个钉控件 → store 方法的绑定：
 * - 缩略图开关按钮（含 is-active 态）与 svg 快照渲染（视口矩形 / 边线 / 节点圆点）；
 * - 缩放按钮、预设比例下拉（点百分比开、点选项设值）、居中 / 适配 / 图例开关；
 * - 连线模式开关与 radio 双选；图例浮层项渲染与关闭按钮。
 */
import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'
import GraphCanvasTools from '@/features/graph/components/graph-visualization/GraphCanvasTools.vue'

function makeStores (overrides = {}) {
  const viewport = reactive({
    zoomLevel: 100,
    zoomPresetOptions: [25, 50, 75, 100, 200],
    zoomOptionsVisible: false,
    lineModeOptionsVisible: false,
    legendVisible: false,
    edgeLabelDisplayMode: 'hover',
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
    centerGraph: vi.fn(),
    fitView: vi.fn(),
    toggleLegend: vi.fn(),
    toggleZoomOptions: vi.fn(),
    toggleLineModeOptions: vi.fn(),
    setZoomByPercent: vi.fn(),
    handleEdgeLabelModeChange: vi.fn(),
    ...overrides.viewport
  })
  const thumbnail = reactive({
    thumbnailEnabled: false,
    thumbnailSvgNodes: [],
    thumbnailSvgEdges: [],
    clampedThumbnailViewportRect: null,
    toggleThumbnail: vi.fn(),
    ...overrides.thumbnail
  })
  const tones = reactive({
    entityLegendItems: [
      { type: 'Scene', color: '#8045ff', count: 3 },
      { type: 'Resource', color: '#1677ff', count: 1 }
    ],
    ...overrides.tones
  })
  return { viewport, thumbnail, tones }
}

async function mountTools (stores, fullscreen = false) {
  return mountWithPlugins(GraphCanvasTools, {
    router: null,
    props: { ...stores, fullscreen },
    global: {
      components: {
        ElTooltip: { name: 'ElTooltip', setup (_, { slots }) { return () => slots.default?.() } },
        // 连线模式的双选在 jsdom 里不真开 teleport 弹层，用替身收 change 事件
        ElRadioGroup: {
          name: 'ElRadioGroup',
          props: { modelValue: { type: String, default: '' } },
          emits: ['update:modelValue', 'change'],
          template: '<div class="radio-group-stub"><slot /></div>'
        },
        ElRadio: { name: 'ElRadio', template: '<label class="radio-stub"><slot /></label>' }
      }
    }
  })
}

describe('GraphCanvasTools', () => {
  it('缩略图关闭时不渲染面板；点击缩略图按钮调 toggleThumbnail', async () => {
    const stores = makeStores()
    const wrapper = await mountTools(stores)

    expect(wrapper.find('.kg-thumbnail-panel').exists()).toBe(false)

    const thumbBtn = wrapper.find('.zoom-btn--thumbnail')
    expect(thumbBtn.classes()).not.toContain('is-active')
    await thumbBtn.trigger('click')
    expect(stores.thumbnail.toggleThumbnail).toHaveBeenCalledTimes(1)
  })

  it('缩略图开启：is-active 态 + svg 画视口矩形 / 边线 / 节点圆点', async () => {
    const stores = makeStores({
      thumbnail: {
        thumbnailEnabled: true,
        thumbnailSvgNodes: [{ id: 'n1', x: 10, y: 20, color: '#8045ff' }],
        thumbnailSvgEdges: [{ id: 'r1', x1: 1, y1: 2, x2: 3, y2: 4 }],
        clampedThumbnailViewportRect: { x: 5, y: 6, width: 100, height: 50 },
        toggleThumbnail: vi.fn()
      }
    })
    const wrapper = await mountTools(stores)

    const panel = wrapper.find('.kg-thumbnail-panel')
    expect(panel.exists()).toBe(true)
    expect(wrapper.find('.zoom-btn--thumbnail').classes()).toContain('is-active')
    expect(wrapper.find('.kg-thumbnail-svg__viewport').exists()).toBe(true)
    expect(wrapper.findAll('.kg-thumbnail-svg__edge')).toHaveLength(1)
    const dot = wrapper.findAll('.kg-thumbnail-svg circle')[0]
    expect(dot.attributes('fill')).toBe('#8045ff')
    expect(dot.attributes('cx')).toBe('10')
  })

  it('缩放按钮：放大/缩小/复位/居中/适配各绑一个 store 方法', async () => {
    const stores = makeStores()
    const wrapper = await mountTools(stores)

    const buttons = wrapper.findAll('.zoom-controls .zoom-btn')
    // 顺序：缩略图、缩小、[百分比]、放大、复位、居中、适配(全屏)、图例、连线配置
    await buttons[1].trigger('click')
    expect(stores.viewport.zoomOut).toHaveBeenCalledTimes(1)

    await buttons[2].trigger('click')
    expect(stores.viewport.zoomIn).toHaveBeenCalledTimes(1)

    await buttons[3].trigger('click')
    expect(stores.viewport.resetZoom).toHaveBeenCalledTimes(1)

    await buttons[4].trigger('click')
    expect(stores.viewport.centerGraph).toHaveBeenCalledTimes(1)

    await buttons[5].trigger('click')
    expect(stores.viewport.fitView).toHaveBeenCalledTimes(1)
  })

  it('缩放百分比按钮显示当前比例，点击开预设下拉；点选项设值并收起', async () => {
    const stores = makeStores({ viewport: { zoomOptionsVisible: false, toggleZoomOptions: vi.fn() } })
    const wrapper = await mountTools(stores)

    const percentBtn = wrapper.find('.zoom-select-btn')
    expect(percentBtn.text()).toBe('100%')
    expect(wrapper.find('.zoom-options').isVisible()).toBe(false)

    await percentBtn.trigger('click')
    expect(stores.viewport.toggleZoomOptions).toHaveBeenCalledTimes(1)

    stores.viewport.zoomOptionsVisible = true
    await flush()
    const options = wrapper.findAll('.zoom-option-btn')
    expect(options.map(o => o.text())).toEqual(['25%', '50%', '75%', '100%', '200%'])

    await options[3].trigger('click')
    expect(stores.viewport.setZoomByPercent).toHaveBeenCalledWith(100)
  })

  it('图例按钮切换开关；图例浮层渲染类型/数量，全屏时隐藏，关闭按钮直写 store', async () => {
    const stores = makeStores({ viewport: { legendVisible: true, toggleLegend: vi.fn() } })
    const wrapper = await mountTools(stores)

    const legend = wrapper.find('.legend')
    expect(legend.isVisible()).toBe(true)
    expect(legend.text()).toContain('Scene（3）')
    // jsdom 会把内联样式里的 hex 归一化成 rgb()
    expect(legend.find('.legend-color').attributes('style')).toContain('rgb(128, 69, 255)')

    const legendBtn = wrapper.findAll('.zoom-btn')[6]
    await legendBtn.trigger('click')
    expect(stores.viewport.toggleLegend).toHaveBeenCalledTimes(1)

    await wrapper.find('.legend-close-btn').trigger('click')
    expect(stores.viewport.legendVisible).toBe(false)

    const fullscreenWrapper = await mountTools(stores, true)
    expect(fullscreenWrapper.find('.legend').isVisible()).toBe(false)
  })

  it('连线模式：按钮 is-active 态与 radio 展示由 lineModeOptionsVisible / edgeLabelDisplayMode 驱动', async () => {
    const stores = makeStores()
    const wrapper = await mountTools(stores)

    const lineBtn = wrapper.findAll('.zoom-btn')[7]
    expect(lineBtn.classes()).toContain('is-active') // hover 模式按钮高亮
    expect(wrapper.find('.line-mode-options').isVisible()).toBe(false)

    await lineBtn.trigger('click')
    expect(stores.viewport.toggleLineModeOptions).toHaveBeenCalledTimes(1)

    stores.viewport.edgeLabelDisplayMode = 'inline'
    await flush()
    expect(wrapper.findAll('.zoom-btn')[7].classes()).not.toContain('is-active')
  })
})
