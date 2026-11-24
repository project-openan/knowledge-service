import { debounce } from 'lodash'
import { workflowState } from '@/features/workflow/store'
import { getFlowConfig, saveFlowConfig, exportWorkFlow, checkSaveFlowConfig } from '@/features/workflow/api/workflow'
import { download } from '@/shared/lib/utils'
import { DEBOUNCETIMELONG } from '@/shared/constants/index.js'

/**
 * 发布与校验 · 与后端 flow api 的装配（composable）。
 *
 * 职责：加载工作流配置（getAdvancedFlowConfig / reloadAdvancedFlow）、
 * 保存链路（saveConfigHandler 防抖 → exportGraph 导出 → check 校验 →
 * 二次确认 → save）、结构化知识库标志与编排引擎推导、导出与撤销。
 *
 * 注意：`ragWorkflowType` 直接写 feature 的 workflowState 单例
 * （@/features/workflow/store）；`ragWorkflowIsStructKnowledge` 仍写在
 * 全局根 state —— 该字段未迁入单例，读取方（responsesynthesizer 抽屉）
 * 仍从 `$store.state` 读。
 */
export function useFlowPersistence () {
  return {
    // 切换到另一个工作流时重建画布。必须先清空旧节点再取数：切到「还没有草稿」的
    // 新工作流时后端返回空配置、走 initDefaultNode()，而它只在画布为空时才补默认节点，
    // 不清空的话画布上会继续留着上一个工作流的节点
    reloadAdvancedFlow () {
      // 清空之后这张图不再属于任何工作流，把归属一并清掉 —— 在新数据落地前点保存，
      // 会被 exportGraph 的 graphAppId 守卫拦下，不会把这张空图存进新工作流
      this.cancelConnection()
      this.selectedEdge = null
      this.clearNodeSelection()
      this.portSideCache = {}
      this.graph?.clearCells()
      this.graphAppId = ''
      // 路由参数变化时标题/版本也要跟着清空：请求失败（如 ID 不存在）时若保留旧值，
      // 页面会显示「上一个工作流的名称 + URL 里的新 ID」，与实际内容不一致。
      this.workflowName = ''
      this.workflowId = ''
      this.version = 1
      this.workflowPublishType = 0
      this.queryEngineType = ''
      this.nodeLoaded = false
      this.getAdvancedFlowConfig()
    },
    // 获取当前高级编排配置
    // shouldArrange：加载完成后是否检查/整理布局（始终 100%，不缩放）。
    // 保存后重新拉取时传 false，保持用户当前的视图与节点位置。
    getAdvancedFlowConfig (shouldArrange = true) {
      // 记下本次请求对应的 appId：连续切换工作流时先发出的请求可能后返回，
      // 拿旧返回渲染会把上一个工作流的图盖回新画布，所以只认当前 URL 对应的返回
      const requestAppId = this.$route.params.id
      // 404 由本页提示并回列表，跳过拦截器的通用 toast，避免一次失败弹两条；
      // 用 skipErrorMessage 而不是 skipErrorHandler，保留 401 的会话处理。
      getFlowConfig(requestAppId, { skipErrorMessage: true }).then(res => {
        if (requestAppId !== this.$route.params.id) {
          return
        }
        if (res.nodeConfigDTOList?.length) {
          this.version = res.version || 1
          this.workflowName = res.name || ''
          this.workflowId = res.appId || ''
          this.workflowPublishType = Number(res.publishType || 0)
          // this.currentAppVersion = res.currentAppVersion
          let nodeDTO = JSON.parse(JSON.stringify(res.nodeConfigDTOList))
          nodeDTO.forEach(item => {
            item.id = item.nodeId
            item.shape = item.componentType
            item.position = {
              x: item.xPosition,
              y: item.yPosition
            }
          })
          this.jsonDTO = nodeDTO
          this.importGraph(shouldArrange)
          this.graphAppId = requestAppId

          let queryengineObj = res.otherNodeConfigList.find(item => item.componentType === 'QUERY_ENGINE')
          this.queryEngineType = queryengineObj.variables.queryengine.operator
          workflowState.ragWorkflowType = this.queryEngineType
          // 是否实际使用结构化知识库（SQL检索算子）：不能仅凭工作流类型判断，
          // 顺序工作流同样可能绑定文档知识库
          this.$store.state.ragWorkflowIsStructKnowledge = this.checkIsStructKnowledgeFlow(res.nodeConfigDTOList)
        } else {
          // 新工作流还没有草稿时走这里。若只 initDefaultNode()，
          // queryEngineType 会保持 data() 里的 ''，exportGraph() 会写出
          // `variables.queryengine = queryengineMap[''] = undefined` —— 保存下来的画布
          // **没有编排引擎**，后端 preCheck 会直接拒（"画布缺少编排引擎"），等于新建的流存不下来。
          // 引擎只能由工作流模板推出来（节点里看不出来），所以后端 GET /flow 返回了 template。
          this.workflowName = res.name || ''
          this.workflowId = res.appId || ''
          this.version = res.version || 1
          this.workflowPublishType = Number(res.publishType || 0)
          this.queryEngineType = this.engineOfTemplate(res.template)
          workflowState.ragWorkflowType = this.queryEngineType
          this.nodeLoaded = false
          this.initDefaultNode()
          this.graphAppId = requestAppId
        }
      })
        .catch(error => {
          // 同上：路由已切走（或有更新的请求接管）时，不要再往画布上补默认节点
          if (requestAppId !== this.$route.params.id) {
            return
          }
          // 401 由会话层统一提示并跳登录；这里不要再补一条“加载失败”并初始化空画布。
          if (error?.status === 401) {
            return
          }
          // 不存在的 ID 不再渲染一个「看起来可编辑」的空画布：明确提示并回列表，
          // 否则用户会以为这是新建流程，保存时才收到 404。
          if (error?.status === 404) {
            this.$message.error(this.$t('modules.workflow.flowNotFound'))
            this.$router.replace({ name: 'flow' })
            return
          }
          this.$message.error(this.$t('modules.workflow.loadFailed'))
          this.nodeLoaded = false
          this.initDefaultNode()
          this.graphAppId = requestAppId
        })
        .finally(() => {
          this.loading = false;
        })
    },
    /**
     * @description: 工作流模板 → 编排引擎。
     * 模板取自后端 GET /flow 的返回（对应建流时选的 Sequential/Blended/Conditional），
     * 缺省与无法识别的一律按顺序引擎处理，与画布默认模板 Blended 不同 ——
     * 后者只是建流弹窗的默认选项，引擎必须显式定下来，否则会存出没有引擎的画布。
     */
    engineOfTemplate (template) {
      const mapper = {
        Sequential: 'SequentialQueryEngine',
        Blended: 'BlendedQueryEngine',
        Conditional: 'ConditionalQueryEngine'
      }
      return mapper[template] || 'SequentialQueryEngine'
    },
    /**
     * @description: 判断节点变量中是否包含 SQL 检索算子（结构化知识库特征）
     */
    isSqlOperatorVariables (variables) {
      const sqlOperatorNames = ['SqlRetriever', 'SqlExecutor', 'SqlRetrieverOperator', 'SqlExecutorOperator']
      return Object.values(variables || {}).some(ops => {
        return Array.isArray(ops) && ops.some(op => sqlOperatorNames.includes(op?.operator))
      })
    },
    /**
     * @description: 判断工作流是否实际使用结构化知识库（SQL检索算子）
     * 顺序工作流(SequentialQueryEngine)既可能绑定结构化知识库，也可能绑定文档知识库，
     * 因此不能仅凭工作流类型判断，需扫描各节点变量中是否存在 SQL 检索算子
     */
    checkIsStructKnowledgeFlow (nodeList) {
      return (nodeList || []).some(node => this.isSqlOperatorVariables(node.variables))
    },
    /**
     * @description: 从当前 graph 节点数据刷新结构化知识库标志，
     * 以覆盖会话中途修改检索器算子（SQL/向量）的场景
     */
    refreshStructKnowledgeFlag () {
      const nodes = this.graph?.getNodes?.() || []
      const isStruct = nodes.some(node => {
        const variables = node.store?.data?.data?.variables || node.store?.data?.variables
        return this.isSqlOperatorVariables(variables)
      })
      this.$store.state.ragWorkflowIsStructKnowledge = isStruct
    },
    saveConfigHandler () {
      this.toolsOpen = false
      // 保存是一条异步多步链（防抖 → 从图上导出 → check → 可能二次确认 → save），中途用户
      // 可能切走画布甚至切到别的工作流。目标 appId 在点击这一刻定死、整条链都用它，不能每次
      // 调用时现读 $route.params.id —— 否则 check 用的是 A、save 时路由已切到 B，
      // 会把 A 的画布内容写进 B。
      this.saveAppId = this.$route.params.id
      this.loading = true;
      if (this.debouncedInput) {
        // 取消之前的防抖函数
        this.debouncedInput.cancel();
      }
      // 创建新的防抖函数
      this.debouncedInput = debounce(() => {
        this.exportGraph()
      }, DEBOUNCETIMELONG);
      // 调用防抖函数
      this.debouncedInput();
    },
    /**
     * 保存成功提示：已发布的工作流要额外说明「这次只改了草稿」。
     * 对话测试/编排层只读发布快照，不说清楚的话用户会以为保存即生效。
     */
    notifySaveSuccess () {
      if (Number(this.workflowPublishType) !== 0) {
        this.$message({
          type: 'success',
          message: this.$t('modules.workflow.saveDraftOnlySuccess')
        })
        // 线上仍是旧快照：本地发布态同步成「发布后修改」
        this.workflowPublishType = 2
        return
      }
      this.$message({
        type: 'success',
        message: this.$t('public.saveSuccess')
      })
    },
    exportGraph () {
      // 防抖到期时，图可能已经不属于 saveAppId 了（用户切走了，或切过去的新流还没加载完、
      // 图上还是空的）—— 这时候存下去就是把别的内容/空图写进库里，直接放弃这次保存。
      if (this.graphAppId !== this.saveAppId) {
        this.loading = false
        return
      }
      const result = this.graph.toJSON()
      const cells = result.cells || []
      const nodes = cells.filter(item => item.shape !== 'edge')
      const edges = cells.filter(item => item.shape === 'edge' && !item.data?.preview)
      nodes.map(item => {
        item.nodeId = item.id || '';
        item.componentType = item.shape;
        item.xPosition = item.position.x;
        item.yPosition = item.position.y;
        item.outputVariables = [];
        item.inputVariables = [];
        const targetItem = this.graph.getCellById(item.id)
        // 该段是必要的，将当前的最新值赋到json体中
        item.variables = targetItem.store.data?.data?.variables;
      })
      edges.forEach(item => {
        let source = item.source.cell;
        let sourceKey = item.source.port;
        let target = item.target.cell;
        const input = nodes.find(item => item.id === source)

        input.outputVariables.push({
          key: sourceKey,
          targetNode: target
        })

        const output = nodes.find(item => item.id === target)

        output.inputVariables.push({
          key: sourceKey,
          sourceNode: source,
          label: this.graph.getCellById(source).store.data.label
        })
      })
      this.jsonDTO = nodes

      const edgesDTO = []
      edges.forEach(item => {
        edgesDTO.push({
          source: item.source.cell,
          target: item.target.cell
        })
      })

      const otherNodeConfigList = [
        {
          componentType: 'QUERY_ENGINE',
          inputVariables: [],
          variables: {
            queryengine: this.queryengineMap[this.queryEngineType]
          }
        }
      ]
      otherNodeConfigList.push(
        {
          componentType: 'EDGES',
          inputVariables: [],
          variables: {
            edges: edgesDTO
          }
        }
      )

      const params = {
        flowType: 'workflow',
        version: this.version,
        nodeConfigDTOList: this.jsonDTO,
        otherNodeConfigList
      }
      // 调用 check 接口
      checkSaveFlowConfig(this.saveAppId, params).then(res => {
        if (!res.success) {
          // 如果 check 接口返回 true，弹出二次确认弹框

          // 优先显示后端 preCheck 给出的原因（res.message，例如「编排引擎
          // BlendedQueryEngine 在当前版本不可执行」），否则警告内容与真实原因对不上，
          // 用户只能靠猜。后端没给原因时才回落到原文案。
          this.$confirm(res.message || this.$t('ragFlow.inferenceModelCheck', {
            name: this.workflowName || this.$route.params.id
          }), this.$t('public.save'), {
            confirmButtonText: this.$t('advancedFlow.yes'),
            cancelButtonText: this.$t('ragFlow.backEdit'),
            type: 'warning',
            describe: this.$t('ragFlow.inferenceModelCheck1')
          })
            .then(() => {
              // 点击二次确认弹框的确定按钮，调用 saveFlowConfig 接口
              saveFlowConfig(this.saveAppId, params)
                .then(() => {
                  this.notifySaveSuccess();
                  this.getAdvancedFlowConfig(false);
                })
                .catch(() => {
                  // to-do 保存接口如果失败 前端增加处理
                  this.loading = false;
                });
            })
            .catch(() => {
              // 点击二次确认弹框的取消按钮，关闭弹框，留在页面
              this.loading = false;
            });
        } else {
        // 如果 check 接口返回 false，直接调用 saveFlowConfig 接口
          saveFlowConfig(this.saveAppId, params)
            .then(() => {
              this.notifySaveSuccess();
              this.getAdvancedFlowConfig();
            })
            .catch(error => {
              // 失败提示由接口拦截器统一弹出，这里只记录并恢复按钮状态
              console.error('保存工作流配置失败:', error);
              this.loading = false;
            });
        }
      })
      // ⚠️ 这里必须留一个 catch，**不能**改成 finally：
      //   `checkSaveFlowConfig` 被 reject 时（网络/网关错，或业务前置校验失败），
      //   上面那段 then 整段都不执行，而唯一的 `loading = false` 都在**内层**
      //   saveFlowConfig 的 catch 里 → 保存按钮**永久转圈**。
      //   用 finally 也不行：内层「二次确认弹窗」是**没有被 return** 的游离链，
      //   外层在这里就已经 settle 了，finally 会在弹窗还开着时提前把按钮解冻。
        .catch(() => {
        // 错误提示由 api/base.js 的响应拦截器统一弹（业务码/HTTP 码各一条），此处只负责复位。
          this.loading = false;
        });
    },
    exportWorkflow () {
      exportWorkFlow(this.$route.params.id).then(res => {
        download(res, '', '')
      })
    },
    undoChanges () {
      // 从服务端重新载入当前工作流，丢弃画布上尚未保存的改动。
      this.toolsOpen = false
      this.cancelConnection()
      this.selectedEdge = null
      this.clearNodeSelection()
      this.getAdvancedFlowConfig(false)
    }
  }
}
