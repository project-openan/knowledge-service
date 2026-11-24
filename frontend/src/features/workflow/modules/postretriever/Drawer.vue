<template>
  <OperatorDrawerShell :drawer="drawer">
    <template #default="{ operator }">
      <div class="fc-grid">
        <el-form-item v-if="operator.operator === 'LLMReranker'" :label="$t('kbEvaluation.llm')" required>
          <el-select
            v-model="operator.kwargs.llm"
            :placeholder="$t('kbEvaluation.llmPlaceholder')"
            :aria-label="$t('kbEvaluation.llm')"
          >
            <el-option
              v-for="item in LLMList"
              :key="item.modelValue"
              :label="item.nameZh"
              :value="item.modelValue"
            />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="isExternalModelReranker(operator)"
          :label="$t('modules.workflow.rerankModelLabel')"
        >
          <el-select
            v-model="operator.kwargs.model"
            :placeholder="followDefaultLabel"
            :aria-label="$t('modules.workflow.rerankModelLabel')"
          >
            <el-option :label="followDefaultLabel" value="" />
            <el-option
              v-for="item in RerankModelList"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="$t('modules.workflow.topNLabel')" required>
          <el-input-number
            v-model="operator.kwargs.top_n"
            :min="1"
            :max="20"
            :step="1"
            :precision="0"
            :aria-label="$t('modules.workflow.topNLabel')"
          />
        </el-form-item>
        <el-form-item
          v-if="isExternalModelReranker(operator)"
          :label="$t('ragFlow.score')"
        >
          <el-input-number
            v-model="operator.kwargs.score"
            :min="-100"
            :max="100"
            :step="0.01"
            :precision="2"
            :aria-label="$t('ragFlow.score')"
          />
        </el-form-item>
      </div>
      <p v-if="['相似度过滤', 'SimilarityFilter', '去重', 'Dedup'].includes(operator.operator)" class="text-secondary fc-no-params">
        {{ $t('modules.workflow.noParams') }}
      </p>
    </template>
  </OperatorDrawerShell>
</template>

<script setup>
// 表单骨架（载入 / 列表操作 / 校验提交）在 modules/shared/useOperatorDrawer.js，
// 这里只留后检索器独有的表单项与数据源。
import { computed, getCurrentInstance, ref } from 'vue'
import { getLLMModel, getRerankModels } from '@/features/model/api/models'
import { default_BGM_score } from '@/features/workflow/lib/workflow'
import {
  EXTERNAL_MODEL_RERANKER_OPERATOR,
  isExternalModelReranker
} from '@/features/workflow/lib/externalModelReranker'
import { getDefaultTopKWithType, useOperatorDrawer } from '@/features/workflow/modules/shared/useOperatorDrawer.js'
import OperatorDrawerShell from '@/features/workflow/modules/shared/OperatorDrawerShell.vue'

const { proxy } = getCurrentInstance()
const LLMList = ref([])
const RerankModelList = ref([])

const LLMRerankerOperatorId = 'LLMReranker'

const props = defineProps({
  formData: { type: Object, default: () => ({}) },
  nodeId: { type: String }
})
const emit = defineEmits(['config-error', 'operator-count'])

function isKnownOperator (operator) {
  return operator.operator === LLMRerankerOperatorId || isExternalModelReranker(operator)
}

// 「跟随部署默认」的展示文案：带上默认行的名字，避免用户以为这里没配模型
const followDefaultLabel = computed(() => {
  const fallback = RerankModelList.value.find(item => item.isDefault)
  return fallback
    ? proxy.$t('modules.workflow.rerankModelFollowDefault', { model: fallback.label })
    : proxy.$t('modules.workflow.rerankModelFollowDefaultEmpty')
})

async function getLLMList () {
  try {
    const res = await getLLMModel()
    LLMList.value = Array.isArray(res) ? res : []
  } catch (error) {
    LLMList.value = []
  }
}

async function getRerankModelList () {
  try {
    const res = await getRerankModels()
    RerankModelList.value = Array.isArray(res) ? res : []
  } catch (error) {
    // 接口失败时保留空清单：模型下拉仍可留空（= 跟随部署默认），保存不被卡住
    RerankModelList.value = []
  }
}

const drawer = useOperatorDrawer({
  props,
  emit,
  type: 'post-retriever',
  formDataKey: 'postretriever',
  builtinOperators: () => [
    { name: proxy.$t('ragFlow.LLMRerankerOperator'), id: LLMRerankerOperatorId },
    { name: proxy.$t('ragFlow.ExternalModelRerankerOperator'), id: EXTERNAL_MODEL_RERANKER_OPERATOR }
  ],
  buildOperator (id) {
    if (id === LLMRerankerOperatorId) {
      return {
        package: 'core.rag.post_retriever.llm_reranker',
        operator: LLMRerankerOperatorId,
        kwargs: {
          llm: '',
          top_n: getDefaultTopKWithType(LLMRerankerOperatorId)
        }
      }
    }
    return {
      package: 'core.rag.post_retriever.external_model_reranker',
      operator: EXTERNAL_MODEL_RERANKER_OPERATOR,
      kwargs: {
        model: '',
        top_n: getDefaultTopKWithType(EXTERNAL_MODEL_RERANKER_OPERATOR),
        score: default_BGM_score
      }
    }
  },
  isKnownOperator,
  validateOperator (operator) {
    if (operator.custom || !isKnownOperator(operator)) {
      return ''
    }
    if (operator.operator === 'LLMReranker' && !operator.kwargs?.llm) {
      return proxy.$t('kbEvaluation.llmPlaceholder')
    }
    const topN = Number(operator.kwargs?.top_n)
    if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
      return proxy.$t('ragFlow.topKTip')
    }
    return ''
  },
  normalizeItem (item) {
    item.kwargs = item.kwargs || {}
    if (item.kwargs.top_n === undefined) {
      item.kwargs.top_n = 5
    }
    // 空串 = 跟随部署默认；下拉才会选中「跟随部署默认」
    if (isExternalModelReranker(item) && item.kwargs.model === undefined) {
      item.kwargs.model = ''
    }
  },
  afterLoad () {
    getLLMList()
    getRerankModelList()
  },
  serializeOperator (operator) {
    // 这三个是抽屉自己的 UI 字段，提交前刻意剥离；解构出来的变量不参与计算。
    // eslint-disable-next-line no-unused-vars
    const { _key, _collapsed, showConfig, ...rest } = operator
    return { ...rest, kwargs: { ...(rest.kwargs || {}) } }
  }
})

function validate () {
  return drawer.validate()
}

function sendOperatorListData () {
  return drawer.sendOperatorListData()
}

defineExpose({
  sendOperatorListData,
  validate
})
</script>
