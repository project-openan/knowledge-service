<template>
  <div class="fc-content">
    <div class="fc-operators-toolbar">
      <div>
        <h3>
          {{ $t('modules.workflow.operatorConfig') }}
          <span class="text-caption">{{ drawer.operatorList.length }}</span>
        </h3>
        <p class="text-caption">{{ $t('modules.workflow.operatorConfigHint') }}</p>
      </div>
      <el-dropdown
        v-if="!drawer.disableAddOperator"
        trigger="click"
        @command="drawer.addOperatorWithType"
      >
        <el-button class="button-compact">
          <Plus />{{ $t('modules.workflow.addOperator') }}<ArrowDown />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="item in drawer.builtinOperatorList"
              :key="item.id"
              :command="item.id"
            >
              {{ item.name }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <OperatorSection
      v-for="(operator, index) in drawer.operatorList"
      :key="operator._key"
      :operator="operator"
      :index="index"
      :options="drawer.builtinOperatorList"
      :collapsed="operator._collapsed"
      :last="index === drawer.operatorList.length - 1"
      :single="drawer.operatorList.length === 1"
      @toggle="operator._collapsed = !operator._collapsed"
      @move="drawer.move(index, $event)"
      @remove="drawer.remove(index)"
      @change="drawer.changeOperator(operator, $event)"
    >
      <JsonEditorVue
        v-if="operator.custom || !drawer.isKnownOperator(operator)"
        v-model="operator.kwargs"
        v-bind="{ mode: 'text', stringified: false }"
        :main-menu-bar="false"
        class="ai-json-editor--drawer"
        :class="{ 'jse-theme-dark': theme === 'dark' }"
      />
      <el-form v-else label-position="top" @submit.prevent>
        <!-- 已知算子的表单项由各抽屉提供（retriever / postretriever / responsesynthesizer 各不相同） -->
        <slot :operator="operator" :index="index" />
      </el-form>
    </OperatorSection>

    <!-- 抽屉级附加件（如响应合成的提示词大编辑器）挂在列表之后 -->
    <slot name="after" />
  </div>
</template>

<script setup>
/**
 * 算子抽屉共享外壳：顶栏（标题 + 新增算子下拉）+ 算子分区循环 +
 * 自定义算子的 JSON 编辑器分支。三个抽屉（retriever / postretriever /
 * responsesynthesizer）只往默认插槽里放「已知算子」的表单项，
 * 列表状态与动作都来自 useOperatorDrawer() 返回的 drawer。
 */
import JsonEditorVue from 'json-editor-vue'
import OperatorSection from '@/features/workflow/OperatorSection.vue'
import { theme } from '@/shared/lib/theme'
import { ArrowDown, Plus } from '@/shared/lib/icons'

defineProps({
  /** useOperatorDrawer() 的返回值（reactive 对象） */
  drawer: { type: Object, required: true }
})
</script>

<style lang="less" scoped>
.ai-json-editor--drawer {
  height: 300px;
}
</style>
