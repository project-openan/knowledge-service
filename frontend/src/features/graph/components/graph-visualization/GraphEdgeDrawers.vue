<template>
  <!-- 查看抽屉 -->
  <el-drawer
    v-model="edge.viewDrawerVisible"
    :title="edge.selectedEdge?.edge_id || edge.selectedEdge?.id || $t('modules.kb.relationshipDetails')"
    direction="rtl"
    size="450px"
  >
    <el-collapse v-model="edge.viewCollapse" type="ghost">
      <el-collapse-item :title="$t('modules.kb.basicInfo')" name="basic">
        <div class="drawer-section">
          <div class="drawer-item">
            <span class="drawer-label">{{ $t('modules.kb.relationshipId') }}：</span>
            <span class="drawer-value">{{ edge.selectedEdge?.edge_id || edge.selectedEdge?.id }}</span>
          </div>
          <div class="drawer-item">
            <span class="drawer-label">{{ $t('modules.kb.relationshipType') }}：</span>
            <span class="drawer-value">{{ edge.selectedEdge?.edge_type || edge.selectedEdge?.class }}</span>
          </div>
          <div class="drawer-item">
            <span class="drawer-label">{{ $t('modules.kb.sourceNodeId') }}：</span>
            <span class="drawer-value">{{ edge.selectedEdge?.source_id }}</span>
          </div>
          <div class="drawer-item">
            <span class="drawer-label">{{ $t('modules.kb.targetNodeId') }}：</span>
            <span class="drawer-value">{{ edge.selectedEdge?.target_id }}</span>
          </div>
        </div>
      </el-collapse-item>

      <el-collapse-item :title="$t('modules.kb.propertyInfo')" name="properties">
        <div class="drawer-section">
          <div v-if="edge.selectedEdge?.properties && Object.keys(edge.selectedEdge.properties).length > 0">
            <div v-for="(value, key) in edge.selectedEdge.properties" :key="key" class="drawer-item">
              <span class="drawer-label">{{ key }}：</span>
              <span class="drawer-value">{{ value }}</span>
            </div>
          </div>
          <div v-else class="empty-hint">
            {{ $t('modules.kb.noPropertyInfo') }}
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>

    <template #footer>
      <div class="drawer-footer">
        <el-button @click="edge.handleCloseEdgeDrawer">{{ $t('modules.kb.close') }}</el-button>
      </div>
    </template>
  </el-drawer>

  <!-- 边的编辑抽屉 -->
  <el-drawer
    v-model="edge.editDrawerVisible"
    :title="$t('modules.kb.editRelationship', { name: edge.selectedEdge?.edge_id || edge.selectedEdge?.id || $t('modules.kb.relationshipType') })"
    :modal="false"
    direction="rtl"
    size="450px"
  >
    <el-collapse v-model="edge.editCollapse" type="ghost">
      <el-collapse-item :title="$t('modules.kb.basicInfo')" name="basic">
        <div class="drawer-section">
          <div class="drawer-item">
            <span class="drawer-label">{{ $t('modules.kb.relationshipId') }}：</span>
            <el-input
              v-model="edge.editForm.edge_id"
              disabled
              :placeholder="$t('modules.kb.relationshipIdPlaceholder')"
              size="small"
            />
          </div>
          <div class="drawer-item">
            <span class="drawer-label">{{ $t('modules.kb.relationshipType') }}：</span>
            <el-input
              v-model="edge.editForm.class"
              disabled
              :placeholder="$t('modules.kb.relationshipTypePlaceholder')"
              size="small"
            />
          </div>
          <div class="drawer-item">
            <span class="drawer-label">{{ $t('modules.kb.sourceNodeId') }}：</span>
            <el-input
              v-model="edge.editForm.source_id"
              disabled
              :placeholder="$t('modules.kb.sourceNodeIdPlaceholder')"
              size="small"
            />
          </div>
          <div class="drawer-item">
            <span class="drawer-label">{{ $t('modules.kb.targetNodeId') }}：</span>
            <el-input
              v-model="edge.editForm.target_id"
              disabled
              :placeholder="$t('modules.kb.targetNodeIdPlaceholder')"
              size="small"
            />
          </div>
        </div>
      </el-collapse-item>

      <el-collapse-item :title="$t('modules.kb.relationshipPropertyInfo')" name="properties">
        <div class="drawer-section">
          <div v-if="edge.editForm.properties && Object.keys(edge.editForm.properties).length > 0">
            <div v-for="(value, key) in edge.editForm.properties" :key="key" class="drawer-item">
              <span class="drawer-label">{{ key }}：</span>
              <template v-if="edge.getEdgePropertyDef(edge.editForm.class, key)?.type === 'BOOLEAN'">
                <el-select
                  v-model="edge.editForm.properties[key]"
                  size="small"
                  clearable
                  class="boolean-select"
                  :placeholder="$t('modules.kb.inputPlaceholder')"
                >
                  <el-option label="true" value="true" />
                  <el-option label="false" value="false" />
                </el-select>
              </template>
              <el-input
                v-else
                v-model="edge.editForm.properties[key]"
                :placeholder="$t('modules.kb.inputPlaceholder')"
                clearable
                size="small"
              />
            </div>
          </div>
          <div v-else class="empty-hint">
            {{ $t('modules.kb.noPropertyInfo') }}
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>

    <template #footer>
      <div class="drawer-footer">
        <el-button type="primary" @click="edge.handleConfirmEditEdge">{{ $t('modules.kb.confirm') }}</el-button>
        <el-button @click="edge.handleCancelEditEdge">{{ $t('modules.kb.cancel') }}</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup>
/**
 * 边的查看/编辑抽屉（从 GraphVisualization.vue 拆出的子组件）。
 *
 * 拆分缘由：主组件模板里两个边抽屉共约 140 行，与实体抽屉、画布、工具条挤在同一个
 * SFC；连同 useGraphEdgeCrud（状态与提交逻辑）一起拆出后，主文件只保留组合。
 *
 * 与主文件的约定：通过 `edge` prop 拿到 useGraphEdgeCrud 的 reactive store，
 * v-model 直接读写 store 上的抽屉可见性/折叠项/表单字段（写 reactive 对象的属性
 * 会穿透回 composable 内部的 ref，行为与原先在主组件里 v-model 一致）。
 * 抽屉外壳的 :deep(.el-drawer) 样式仍留在主文件（实体抽屉也共用），
 * 这里只带走 drawer-section/footer 这两组本模板专属的样式。
 */
defineProps({
  /** useGraphEdgeCrud 返回的 reactive store */
  edge: {
    type: Object,
    required: true
  }
})
</script>

<style lang="less" scoped>
.drawer-section {
  padding-left: 20px;

  .drawer-item {
    padding: 8px 0;
    display: flex;
    align-items: center;
    gap: 8px;

    .drawer-label {
      font-weight: 600;
      color: var(--rs-text);
      font-size: 14px;
      min-width: 100px;
      flex-shrink: 0;
    }

    .drawer-value {
      color: var(--rs-text-2);
      font-size: 14px;
      word-break: break-word;
      flex: 1;
    }

    :deep(.el-input) {
      flex: 1;
    }

    :deep(.el-select) {
      flex: 1;
    }

    .boolean-select {
      width: 120px;
    }
  }

  .empty-hint {
    text-align: center;
    color: var(--rs-text-3);
    font-size: 14px;
    padding: 20px 0;
  }

}

.drawer-footer {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 16px 0;
}
</style>
