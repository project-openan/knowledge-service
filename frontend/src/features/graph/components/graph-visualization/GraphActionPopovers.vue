<template>
  <!-- 操作气泡卡片 - 点击触发（实体） -->
  <div
    v-show="selection.actionPopoverVisible && selection.selectedEntity"
    class="action-popover"
    :style="{ left: selection.actionPopoverPosition.x + 'px', top: selection.actionPopoverPosition.y + 'px' }"
  >
    <el-tooltip :content="$t('modules.kb.edit')" placement="top">
      <div class="action-btn" @click="selection.handleEdit">
        <el-icon><Edit /></el-icon>
      </div>
    </el-tooltip>
    <el-tooltip :content="$t('modules.kb.delete')" placement="top">
      <div class="action-btn" @click="entity.handleDeleteNode">
        <el-icon><Delete /></el-icon>
      </div>
    </el-tooltip>
    <el-tooltip :content="$t('modules.kb.addRelationship')" placement="top">
      <div class="action-btn" @click="relation.handleAddEdge">
        <el-icon><Link /></el-icon>
      </div>
    </el-tooltip>
  </div>

  <!-- 边的操作气泡卡片 -->
  <div
    v-show="edge.edgeActionPopoverVisible && edge.selectedEdge"
    class="action-popover"
    :style="{ left: edge.edgeActionPopoverPosition.x + 'px', top: edge.edgeActionPopoverPosition.y + 'px' }"
  >
    <el-tooltip :content="$t('modules.kb.edit')" placement="top">
      <div class="action-btn" @click="edge.handleEditEdge">
        <el-icon><Edit /></el-icon>
      </div>
    </el-tooltip>
    <el-tooltip :content="$t('modules.kb.delete')" placement="top">
      <div class="action-btn" @click="edge.handleDeleteEdge">
        <el-icon><Delete /></el-icon>
      </div>
    </el-tooltip>
  </div>
</template>

<script setup>
/**
 * 实体/边的操作气泡卡片（从 GraphVisualization.vue 拆出的子组件）。
 *
 * 拆分缘由：两个气泡卡片（编辑/删除/加关系、编辑/删除）原先是主模板里两个
 * absolute 定位块 + 一段 .action-popover 样式，和抽屉、工具条挤在一起。
 * 拆出后主模板只剩 GraphCanvasVis 与各子组件的组合。
 *
 * 与主文件的约定：
 * - 多根模板（fragment）：两个气泡按原 DOM 顺序原位渲染，不包额外壳元素，
 *   因此 absolute 定位仍以主组件的 .graph-container（position: relative）为基准；
 * - 通过 selection / entity / relation / edge 四个 prop 拿到对应 composable 的
 *   reactive store，按钮直接调用 store 上的方法（与原先调用主组件函数等价）。
 */
import { Edit, Delete, Link } from '@element-plus/icons-vue'

defineProps({
  /** useGraphSelection store：实体选中态与气泡位置 */
  selection: {
    type: Object,
    required: true
  },
  /** useGraphEntityCrud store：删除实体 */
  entity: {
    type: Object,
    required: true
  },
  /** useGraphRelationDrawer store：添加关系 */
  relation: {
    type: Object,
    required: true
  },
  /** useGraphEdgeCrud store：边选中态与边气泡 */
  edge: {
    type: Object,
    required: true
  }
})
</script>

<style lang="less" scoped>
// 操作气泡卡片样式
.action-popover {
  position: absolute;
  display: flex;
  gap: 8px;
  padding: 8px;
  background: var(--rs-bg-card);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 1001;

  .action-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
    background: var(--rs-bg-hover);

    &:hover {
      background: var(--rs-primary);
      transform: scale(1.1);

      :deep(.el-icon) {
        color: var(--rs-on-accent);
      }
    }

    :deep(.el-icon) {
      font-size: 18px;
      color: var(--rs-text-2);
      transition: color 0.2s;
    }
  }
}
</style>
