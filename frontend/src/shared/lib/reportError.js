/**
 * 用户操作失败的上报统一出口 —— 「console 留痕 + 用户可见提示」收成一处。
 *
 * 为什么需要它：
 *   全仓 catch 点此前有三类写法，行为不一致 ——
 *   ① 只 `console.error`，用户点了没反应，也不知道操作失败了（静默失败）；
 *   ② console + 手拼 `$t(key) + ': ' + error.message` 再 `$message.error`，
 *      同样的四行样板在十几个文件里各抄一份；
 *   ③ 直接弹 toast 但不留日志，排查时只能靠猜。
 *   本模块把两类动作绑死：**凡是用户需要知道「这件事失败了」的 catch 点，
 *   一律 `reportError(error, key)`**；纯开发调试路径（内部状态诊断、
 *   axios 拦截器已弹过 toast 的二次日志）**不要**用它，保留 console 即可，
 *   否则会造成双 toast。
 *
 * 用法：
 *   reportError(error, 'modules.kb.exportJsonFailed')   // 具体文案 key
 *   reportError(error, { key: 'public.loadFailed', label: 'GraphCanvas init' })
 *   reportError(error)                                   // 回落 public.operationFailed
 *
 * 文案 key 必须在 zh/en 两棵消息树同时存在（i18n.structure 对比测试守卫）。
 * toast 文案沿用全仓约定：`$t(key) + ': ' + error.message`（半角冒号 + 空格），
 * 与拦截器/页面既有拼接一致。
 */
import { $t } from '@/app/i18n/i18n.js';
import message from '@/shared/lib/message.js';

const DEFAULT_KEY = 'public.operationFailed';

function normalizeContext (context) {
  if (!context) {
    return { key: DEFAULT_KEY, label: DEFAULT_KEY };
  }
  if (typeof context === 'string') {
    return { key: context, label: context };
  }
  return {
    key: context.key || DEFAULT_KEY,
    // label 只进控制台（常给人话上下文），key 走 i18n
    label: context.label || context.key || DEFAULT_KEY
  };
}

/**
 * @param {unknown} error 错误对象 / 响应体 / 任意失败值（原样进 console）
 * @param {string|{key?:string, label?:string}} [context] i18n key，或 { key, label }
 */
export function reportError (error, context) {
  const { key, label } = normalizeContext(context)
  // console 里打印 key/label 作为检索锚点；错误对象自带堆栈，不重复打 stack
  console.error(label, error)
  const reason = (error && (error.message || error.detail)) || ''
  message.error(reason ? `${$t(key)}: ${reason}` : $t(key))
}

export default reportError;
