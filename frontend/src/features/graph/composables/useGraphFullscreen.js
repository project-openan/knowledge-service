/**
 * useGraphFullscreen —— 窗口内沉浸画布（不调用浏览器原生全屏）。
 *
 * 拆分缘由：沉浸模式原先混在 GraphVisualization.vue 里：fullscreen/toolsOpen 状态、
 * 进出全屏的画布重排与按钮聚焦、Esc 键的优先级分发（先关抽屉/弹窗 → 再收「查询与
 * 操作」浮层 → 最后退出沉浸）。Esc 判定已抽到 lib/graph-fullscreen（纯函数，
 * resolveFullscreenEscape），这个 composable 负责状态、DOM 事件挂载与画布联动。
 */
import { reactive, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { resolveFullscreenEscape } from '../lib/graph-fullscreen'

export function useGraphFullscreen (ctx) {
  const { graphCanvasRef, fullscreenButton, emit } = ctx

  const fullscreen = ref(false)
  const toolsOpen = ref(false)

  function closeTools () {
    toolsOpen.value = false
  }

  function toggleFullscreen () {
    // 进出全屏按当前页面尺寸重排节点坐标并重新居中。
    // 只平移相机会让节点在大画布上仍挤在中间；
    // 这里让子组件回到基准布局再按新画布收拢 / 撑开。
    fullscreen.value = !fullscreen.value
    closeTools()
    emit('fullscreen-change', fullscreen.value)
    nextTick(() => {
      graphCanvasRef.value?.relayoutForViewport?.()
      fullscreenButton.value?.$el?.focus?.()
    })
  }

  function exitFullscreen () {
    if (fullscreen.value) {
      toggleFullscreen()
    }
  }

  /**
   * Esc 优先级：先让已打开的抽屉 / 弹窗自己关闭，
   * 再收起「查询与操作」浮层，最后退出沉浸画布。
   */
  function handleFullscreenKey (event) {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return
    }
    const overlayOpen = [...document.querySelectorAll('.el-drawer,.el-dialog,.el-message-box,.el-select__popper')]
      .some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
    const action = resolveFullscreenEscape({ fullscreen: fullscreen.value, toolsOpen: toolsOpen.value, overlayOpen })
    if (action === 'close-tools') {
      closeTools()
    } else if (action === 'exit') {
      toggleFullscreen()
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', handleFullscreenKey)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleFullscreenKey)
  })

  return reactive({
    fullscreen,
    toolsOpen,
    closeTools,
    toggleFullscreen,
    exitFullscreen
  })
}
