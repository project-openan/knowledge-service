/**
 * 算子抽屉共享骨架（retriever / postretriever / responsesynthesizer 三个 Drawer）。
 *
 * 三个抽屉的表单骨架完全同构：挂载时从 props.formData[<key>] 深拷贝载入 →
 * 逐条补默认值 → 发 operator-count → 组装「新增算子」下拉 → 附加加载；
 * 列表操作（新增 / 换算子 / 上移 / 下移 / 删除）、校验循环（定位到第一个
 * 出错的算子并 emit config-error）与提交收集（剥离抽屉私有 UI 字段、包成
 * { [formDataKey]: list }）也一模一样。差异只在「每个算子怎么补默认值 /
 * 怎么建新算子 / 怎么校验 / 怎么序列化」，全部以钩子传入 —— 各抽屉独有的
 * 表单项与数据加载仍留在各自文件里（配套外壳见 OperatorDrawerShell.vue）。
 *
 * 对外契约不变：抽屉仍以 `defineExpose({ sendOperatorListData, validate })`
 * 暴露给父组件（useFlowDrawer 的动态 require 只认这两个）。
 */
import { computed, getCurrentInstance, onMounted, reactive, ref } from 'vue'
import { defaultTopkMapper } from '@/features/workflow/lib/workflow'
import { workflowState } from '@/features/workflow/store'
import { useCustomOperator } from '@/features/workflow/modules/useCustomOperator.js'

/** 各引擎类型（Blended / Sequential / Conditional）下的默认 top_k；三个抽屉原本各有一份。 */
export function getDefaultTopKWithType (operatorType) {
  const workflowType = workflowState.ragWorkflowType
  if (workflowType === 'BlendedQueryEngine') {
    return defaultTopkMapper[operatorType].BlendedQueryEngine
  }
  if (workflowType === 'SequentialQueryEngine') {
    return defaultTopkMapper[operatorType].SequentialQueryEngine
  }
  return defaultTopkMapper[operatorType].ConditionalQueryEngine
}

/**
 * @param {Object} options
 * @param {Object} options.props        组件 props（formData / nodeId）
 * @param {Function} options.emit       组件 emit（config-error / operator-count）
 * @param {string} options.type         useCustomOperator 的节点类型（拉自定义算子列表用）
 * @param {string} options.formDataKey  props.formData 里的列表键（retriever / postretriever / responsesynthesizer）
 * @param {Function} options.builtinOperators    () => [{ name, id }]，「新增算子」下拉项
 * @param {Function} options.buildOperator       (id) => { package, operator, kwargs }
 * @param {Function} options.isKnownOperator     operator => boolean；未知算子走 JSON 编辑器
 * @param {Function} options.validateOperator    operator => '' | 错误文案（校验循环逐算子调用）
 * @param {Function} [options.beforeValidate]    () => boolean；校验前置闸门（如知识库存在性），false 则直接 callback(false)
 * @param {Function} [options.normalizeItem]     item => void；载入时逐条补默认值（各自独特逻辑）
 * @param {Function} [options.afterLoad]         () => void；列表就绪后的附加加载（模型清单 / KB 分组等）
 * @param {Function} [options.seedNewOperator]   next => void；新增算子时沿用同类算子的已选来源（retriever）
 * @param {Function} [options.beforeOperatorChange] operator => any；换算子前读取旧 kwargs（retriever 判断 hadSources）
 * @param {Function} [options.afterOperatorChange]  (operator, id, hadSources) => void；换算子后的附加处理（retriever 的 _sourceNotice）
 * @param {Function} [options.beforeSend]        () => void；提交前对列表的就地收敛（retriever）
 * @param {Function} options.serializeOperator   operator => 提交形态（剥离 UI 字段的拷贝，深浅拷贝语义各自保留）
 * @param {Function} [options.isAddDisabled]     (operatorList) => boolean；「新增算子」入口的禁用闸门
 */
export function useOperatorDrawer ({
  props,
  emit,
  type,
  formDataKey,
  builtinOperators,
  buildOperator,
  isKnownOperator,
  validateOperator,
  beforeValidate = null,
  normalizeItem = null,
  afterLoad = null,
  seedNewOperator = null,
  beforeOperatorChange = null,
  afterOperatorChange = null,
  beforeSend = null,
  serializeOperator,
  isAddDisabled = null
}) {
  const { proxy } = getCurrentInstance()
  const operatorList = ref([])
  const builtinOperatorList = ref([])
  let sequence = 0

  const disableAddOperator = computed(() => (isAddDisabled ? isAddDisabled(operatorList.value) : false))

  const { generateRandomUUID } = useCustomOperator(proxy, {
    props,
    type,
    operatorList,
    showAddOperatorPopover: ref(false)
  })

  /** 抽屉私有 UI 字段（_key/_collapsed）在拷贝时补上，不回写 props.formData。 */
  function editable (operator) {
    return {
      ...JSON.parse(JSON.stringify(operator)),
      _key: `op-${++sequence}`,
      _collapsed: false
    }
  }

  onMounted(() => {
    const source = JSON.parse(JSON.stringify(props.formData[formDataKey] || []))
    source.forEach(item => {
      normalizeItem?.(item)
    })
    operatorList.value = source.map(editable)
    emit('operator-count', operatorList.value.length)
    refreshBuiltinOperators()
    afterLoad?.()
  })

  /** 「新增算子」下拉项变化时重算（retriever 按部署环境增删图谱检索算子）。 */
  function refreshBuiltinOperators () {
    builtinOperatorList.value = builtinOperators()
  }

  function addOperatorWithType (id) {
    const next = buildOperator(id)
    seedNewOperator?.(next)
    operatorList.value.push(editable({
      id: `${props.nodeId}_${generateRandomUUID()}`,
      ...next
    }))
    emit('operator-count', operatorList.value.length)
  }

  function changeOperator (operator, id) {
    if (!id || operator.operator === id) {
      return
    }
    const hadSources = beforeOperatorChange ? beforeOperatorChange(operator) : undefined
    const next = buildOperator(id)
    operator.operator = next.operator
    operator.package = next.package
    operator.kwargs = next.kwargs
    afterOperatorChange?.(operator, id, hadSources)
  }

  function move (index, delta) {
    const target = index + delta
    if (target < 0 || target >= operatorList.value.length) {
      return
    }
    const [operator] = operatorList.value.splice(index, 1)
    operatorList.value.splice(target, 0, operator)
  }

  function remove (index) {
    if (operatorList.value.length <= 1) {
      return
    }
    operatorList.value.splice(index, 1)
    emit('operator-count', operatorList.value.length)
  }

  function displayName (operator) {
    return operator?.custom
      ? operator.operatorName
      : proxy.$t(`ragFlow.${operator.operator}Operator`)
  }

  /** 校验：前置闸门 → 逐算子校验；出错时展开该算子并 emit config-error 定位。 */
  function validate () {
    return callback => {
      if (beforeValidate && !beforeValidate()) {
        callback(false)
        return
      }
      for (const operator of operatorList.value) {
        const error = validateOperator(operator)
        if (error) {
          operator._collapsed = false
          emit('config-error', `${displayName(operator)}：${error}`)
          callback(false)
          return
        }
      }
      emit('config-error', '')
      callback(true)
    }
  }

  /** 提交收集：先跑就地收敛（可选），再把列表映射成提交形态并按键包装。 */
  function sendOperatorListData () {
    beforeSend?.()
    const list = operatorList.value.map(serializeOperator)
    return { [formDataKey]: list }
  }

  // reactive 包一层：Shell 以 prop 拿到的是解包后的 operatorList / builtinOperatorList
  return reactive({
    operatorList,
    builtinOperatorList,
    disableAddOperator,
    isKnownOperator,
    refreshBuiltinOperators,
    addOperatorWithType,
    changeOperator,
    move,
    remove,
    displayName,
    validate,
    sendOperatorListData
  })
}
