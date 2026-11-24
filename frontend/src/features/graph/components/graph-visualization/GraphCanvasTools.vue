<template>
  <!-- 左下角：缩略图、缩放、图例、连线配置 -->
  <div class="kg-bottom-left">
    <div v-if="thumbnail.thumbnailEnabled" class="kg-thumbnail-panel">
      <svg class="kg-thumbnail-svg" viewBox="0 0 260 150" preserveAspectRatio="none">
        <!-- 整体灰底：视图外节点区域 -->
        <rect class="kg-thumbnail-svg__bg" x="0.5" y="0.5" width="259" height="149" fill="#e8eaef" stroke="#dcdfe6" />
        <!-- 当前主画布视口：白底高亮（无蓝框） -->
        <rect
          v-if="thumbnail.clampedThumbnailViewportRect"
          class="kg-thumbnail-svg__viewport"
          :x="thumbnail.clampedThumbnailViewportRect.x"
          :y="thumbnail.clampedThumbnailViewportRect.y"
          :width="thumbnail.clampedThumbnailViewportRect.width"
          :height="thumbnail.clampedThumbnailViewportRect.height"
          fill="#ffffff"
        />
        <line
          v-for="edgeItem in thumbnail.thumbnailSvgEdges"
          :key="edgeItem.id"
          class="kg-thumbnail-svg__edge"
          :x1="edgeItem.x1"
          :y1="edgeItem.y1"
          :x2="edgeItem.x2"
          :y2="edgeItem.y2"
          stroke="#b0b7c3"
          stroke-width="1"
        />
        <circle
          v-for="node in thumbnail.thumbnailSvgNodes"
          :key="node.id"
          :cx="node.x"
          :cy="node.y"
          r="3"
          :fill="node.color"
        />
      </svg>
    </div>

    <div class="zoom-controls">
      <el-tooltip :content="$t('modules.kb.thumbnail')" placement="top">
        <el-button size="small" class="zoom-btn zoom-btn--thumbnail" :class="{ 'is-active': thumbnail.thumbnailEnabled }" @click="thumbnail.toggleThumbnail">
          <img :src="thumbnail.thumbnailEnabled ? ThumbnailIconActive : ThumbnailIcon" alt="thumbnail" />
        </el-button>
      </el-tooltip>
      <div class="zoom-divider"></div>
      <el-tooltip :content="$t('modules.kb.zoomOut')" placement="top">
        <el-button @click="viewport.zoomOut" size="small" class="zoom-btn">
          <img :src="ZoomInIcon" alt="zoom-out" />
        </el-button>
      </el-tooltip>

      <div class="zoom-select-wrap">
        <button type="button" class="zoom-select-btn" @click.stop="viewport.toggleZoomOptions">
          {{ viewport.zoomLevel }}%
        </button>
        <div v-show="viewport.zoomOptionsVisible" class="zoom-options">
          <button
            v-for="option in viewport.zoomPresetOptions"
            :key="option"
            type="button"
            class="zoom-option-btn"
            @click.stop="viewport.setZoomByPercent(option)"
          >
            {{ option }}%
          </button>
        </div>
      </div>

      <el-tooltip :content="$t('modules.kb.zoomIn')" placement="top">
        <el-button @click="viewport.zoomIn" size="small" class="zoom-btn">
          <img :src="ZoomOutIcon" alt="zoom-in" />
        </el-button>
      </el-tooltip>
      <div class="zoom-divider"></div>
      <el-tooltip :content="$t('modules.kb.reset')" placement="top">
        <el-button @click="viewport.resetZoom" size="small" class="zoom-btn">
          <img :src="ZoomResetIcon" alt="reset" />
        </el-button>
      </el-tooltip>
      <el-tooltip :content="$t('modules.kb.center')" placement="top">
        <el-button @click="viewport.centerGraph" size="small" class="zoom-btn">
          <img :src="CenteredIcon" alt="center" />
        </el-button>
      </el-tooltip>
      <el-tooltip :content="$t('modules.kb.fullScreen')" placement="top">
        <el-button size="small" class="zoom-btn" @click="viewport.fitView">
          <img :src="FullScreenIcon" alt="fullscreen" />
        </el-button>
      </el-tooltip>
      <div class="zoom-divider"></div>
      <el-tooltip :content="$t('modules.kb.legend')" placement="top">
        <el-button size="small" class="zoom-btn" :class="{ 'is-active': viewport.legendVisible }" @click="viewport.toggleLegend">
          <img :src="viewport.legendVisible ? LegendIconActive : LegendIcon" alt="legend" />
        </el-button>
      </el-tooltip>
      <div class="line-config-wrap">
        <el-tooltip :content="$t('modules.kb.lineConfig')" placement="top">
          <el-button
            size="small"
            class="zoom-btn"
            :class="{ 'is-active': viewport.lineModeOptionsVisible || viewport.edgeLabelDisplayMode === 'hover' }"
            @click.stop="viewport.toggleLineModeOptions"
          >
            <img :src="(viewport.lineModeOptionsVisible || viewport.edgeLabelDisplayMode === 'hover') ? AssemblyIpipelineIconActive : AssemblyIpipelineIcon" alt="line-config" />
          </el-button>
        </el-tooltip>
        <div v-show="viewport.lineModeOptionsVisible" class="line-mode-options" @click.stop>
          <el-radio-group v-model="viewport.edgeLabelDisplayMode" @change="viewport.handleEdgeLabelModeChange">
            <el-radio label="inline" value="inline">{{ $t('modules.kb.edgeLabelInline') }}</el-radio>
            <el-radio label="hover" value="hover">{{ $t('modules.kb.edgeLabelHover') }}</el-radio>
          </el-radio-group>
        </div>
      </div>
    </div>
  </div>

  <!-- 左下角图例（仅实体类型、颜色、数量）；全屏时隐藏 -->
  <div v-show="viewport.legendVisible && !fullscreen" class="legend">
    <div class="legend-header">
      <div class="legend-title">{{ $t('modules.kb.entityTypes') }}</div>
      <button type="button" class="legend-close-btn" @click="viewport.legendVisible = false">
        <el-icon><Close /></el-icon>
      </button>
    </div>
    <div v-for="item in tones.entityLegendItems" :key="item.type" class="legend-item">
      <div class="legend-color" :style="{ background: item.color }"></div>
      <span>{{ item.type }}（{{ item.count }}）</span>
    </div>
  </div>
</template>

<script setup>
/**
 * 画布左下角工具簇：缩略图、缩放控件、图例浮层、连线标签模式（从 GraphVisualization.vue 拆出的子组件）。
 *
 * 拆分缘由：这组控件原先是主模板里约 130 行的 absolute 定位块 + 主样式里约 220 行
 * 的 .kg-* / .zoom-* / .legend 样式，只依赖「视野/缩略图/配色」三个 composable 的
 * 状态。拆出后主组件模板只剩布局骨架。
 *
 * 与主文件的约定：
 * - 多根模板（fragment）：.kg-bottom-left 与 .legend 按原 DOM 顺序原位渲染，
 *   不包额外壳元素，absolute 定位仍以主组件的 .graph-container 为基准；
 * - viewport / thumbnail / tones 三个 prop 是对应 composable 的 reactive store，
 *   模板直接读写 store 字段（如 v-model 到 viewport.edgeLabelDisplayMode），
 *   与原先在主组件里绑定同名 ref 等价；
 * - fullscreen prop 控制图例浮层的显隐（全屏时隐藏，行为不变）。
 */
import { Close } from '@element-plus/icons-vue'
import ZoomInIcon from '@/assets/zoom-in-16.svg'
import ZoomOutIcon from '@/assets/zoom-out-16.svg'
import ZoomResetIcon from '@/assets/fonts/zoom-reset-16.svg'
import CenteredIcon from '@/assets/fonts/centered-16.svg'
import FullScreenIcon from '@/assets/fonts/full-screen-16.svg'
import ThumbnailIcon from '@/assets/thumbnail.svg'
import ThumbnailIconActive from '@/assets/thumbnail-active.svg'
import LegendIcon from '@/assets/legend-16.svg'
import LegendIconActive from '@/assets/legend-16-active.svg'
import AssemblyIpipelineIcon from '@/assets/assembly-ipipeline-16.svg'
import AssemblyIpipelineIconActive from '@/assets/assembly-ipipeline-16-active.svg'

defineProps({
  /** useGraphViewport store：缩放/图例/连线标签模式 */
  viewport: {
    type: Object,
    required: true
  },
  /** useGraphThumbnail store：缩略图开关与快照 */
  thumbnail: {
    type: Object,
    required: true
  },
  /** useGraphTones store：图例的实体类型配色与数量 */
  tones: {
    type: Object,
    required: true
  },
  /** 主组件当前是否处于沉浸画布（全屏时隐藏图例浮层） */
  fullscreen: {
    type: Boolean,
    default: false
  }
})
</script>

<style lang="less" scoped>
// 以下样式随模板一起从主组件的 .graph-container 嵌套块中拆出；
// 定位基准不变：absolute 相对主组件的 .graph-container（position: relative）。

.kg-bottom-left {
  position: absolute;
  left: 18px;
  bottom: 18px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kg-thumbnail-panel {
  width: 260px;
  height: 150px;
  background: var(--rs-bg-soft);
  border-radius: 4px;
  border: 1px solid var(--rs-border);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.kg-thumbnail-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.legend {
  position: absolute;
  left: 20px;
  top: 20px;
  background: color-mix(in srgb, var(--rs-bg-card) 95%, transparent);
  padding: 12px;
  border-radius: 3px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  z-index: 100;
  min-width: 190px;

  .legend-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .legend-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--rs-text);
  }

  .legend-close-btn {
    border: none;
    background: transparent;
    color: var(--rs-text-3);
    cursor: pointer;
    font-size: 14px;
    width: 20px;
    height: 20px;
    line-height: 20px;
    text-align: center;
    border-radius: 4px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .legend-close-btn:hover {
    background: var(--rs-bg-hover);
    color: var(--rs-text-2);
  }

  .legend-item {
    display: flex;
    align-items: center;
    margin-bottom: 8px;

    &:last-child {
      margin-bottom: 0;
    }

    .legend-color {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      margin-right: 8px;
      border: 2px solid var(--rs-bg-card);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }

    span {
      font-size: 12px;
      color: var(--rs-text-2);
    }
  }
}

/* 与 .canvas-controls 一致：白底、1px 边框、4px 内距的小圆角胶囊 */
.zoom-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--rs-bg-card, #fff);
  padding: 4px;
  border: 1px solid var(--rs-border, #e5ebf4);
  border-radius: var(--rs-radius, 8px);
  box-shadow: 0 3px 12px rgba(16, 34, 73, 0.03);
}

.zoom-btn {
  padding: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s;
  border-radius: 4px;
  width: 28px;
  height: 30px;

  &:hover {
    background-color: var(--rs-bg-hover, #f5f9ff);
  }

  &:active {
    background-color: var(--rs-bg-selected, #edf5ff);
  }

  &.is-active {
    border: none !important;
    outline: none;
    box-shadow: none !important;
    background: var(--rs-bg-selected, #edf5ff);
  }

  img {
    width: 16px;
    height: 16px;
    display: block;
  }
}

.zoom-divider {
  width: 1px;
  height: 18px;
  background-color: var(--rs-border, #e5ebf4);
  margin: 0 4px;
  flex-shrink: 0;
}

.zoom-select-wrap {
  position: relative;
}

/* 缩放比例是纯文本（不是带框下拉），点击仍可展开预设比例 */
.zoom-select-btn {
  height: 30px;
  min-width: 48px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--rs-text-2, #536383);
  cursor: pointer;
  font-size: 12px;
  padding: 0 6px;

  &:hover {
    background: var(--rs-bg-hover, #f5f9ff);
  }
}

.zoom-options {
  position: absolute;
  left: 0;
  bottom: calc(100% + 4px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--rs-bg-card, #fff);
  border: 1px solid var(--rs-border, #dcdfe6);
  border-radius: 6px;
  padding: 6px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}

.zoom-option-btn {
  border: 0;
  background: transparent;
  font-size: 12px;
  color: var(--rs-text-2, #606266);
  cursor: pointer;
  text-align: left;
  padding: 4px 8px;
  border-radius: 4px;
}

.zoom-option-btn:hover {
  background: var(--rs-bg-hover, #f5f7fa);
}

.line-config-wrap {
  position: relative;
}

.line-mode-options {
  position: absolute;
  left: 0;
  bottom: calc(100% + 4px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--rs-bg-card, #fff);
  border: 1px solid var(--rs-border, #dcdfe6);
  border-radius: 6px;
  padding: 6px 6px 6px 16px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  min-width: 120px;
  :deep(.el-radio-group) {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  :deep(.el-radio) {
    margin-right: 0;
    height: 24px;
    line-height: 24px;
  }
}
</style>
