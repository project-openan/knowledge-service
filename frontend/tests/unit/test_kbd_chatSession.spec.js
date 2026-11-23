// @vitest-environment jsdom
// useChatSession（消息状态 + 多段会话历史）的残余分支：
// 恢复（有历史/无历史/active 缺失回落最近）、切换工作流（旧键落盘/新键读取/空 id 复位）、
// 节流落盘（500ms trailing + flush 立即兜底 + 空 workflowId 不写）、
// 会话操作（新建/切换/删除当前与非当前/重命名/置顶/清空/导出/消息读取）的边界。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, ref } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { useChatSession, SESSION_SAVE_THROTTLE_MS } from '@/features/chat/composables/useChatSession'
import { sessionsKey, SESSIONS_VERSION } from '@/features/chat/lib/session-storage'

function makeMessage (role = 'user', text = '你好') {
  return {
    role, text, thinking: '', html: `<p>${text}</p>`,
    pending: false, stopped: false, error: false
  }
}

/**
 * 把会话状态挂进探针组件（watch/onBeforeUnmount 都要在实例里才生效）。
 * ⚠️ ChatPage 的真实姿势：先以空 id 挂载，再选出工作流（watch 无 immediate），
 * 首次加载历史靠「从空 id 切到目标 id」触发 —— 这里保持同一时序。
 */
async function setupSession (initialWorkflowId = '') {
  const selectedWorkflowId = ref(initialWorkflowId)
  const apiRef = {}
  const wrapper = await mountWithPlugins({
    name: 'SessionProbe',
    setup () {
      Object.assign(apiRef, useChatSession(selectedWorkflowId))
      return () => h('div')
    }
  }, { router: null })
  await flush()
  return { wrapper, selectedWorkflowId, api: apiRef }
}

function storedOf (workflowId) {
  const raw = window.localStorage.getItem(sessionsKey(workflowId))
  return raw ? JSON.parse(raw) : null
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('恢复：load 与切换工作流', () => {
  it('没有历史：全新会话 id、空消息、sessionRestored=false', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-empty'
    await flush()
    await nextTick()
    expect(api.sessionRestored.value).toBe(false)
    expect(api.messages.value).toEqual([])
    expect(api.conversationId.value).toMatch(/./)
    expect(api.sessions.value).toEqual([])
  })

  it('有历史：恢复 active 会话；active id 不在列表时回落到最近一段', async () => {
    const entry = {
      conversationId: 'conv-1',
      savedAt: 1000,
      title: '第一段',
      messages: [{ role: 'user', text: '问题一', thinking: '', error: false }]
    }
    const stale = {
      conversationId: 'conv-other',
      savedAt: 500,
      messages: [{ role: 'user', text: '丢了', thinking: '', error: false }]
    }
    window.localStorage.setItem(sessionsKey('wf-a'), JSON.stringify({
      version: SESSIONS_VERSION,
      activeConversationId: 'conv-gone', // 不在 sessions 里（stale 是另一个 id）
      sessions: [entry, stale]
    }))

    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    await nextTick()
    expect(api.sessionRestored.value).toBe(true)
    expect(api.conversationId.value).toBe('conv-1') // 回落到最近一段
    expect(api.messages.value[0].text).toBe('问题一')
    expect(api.sessions.value[0].title).toBe('第一段')
  })

  it('切工作流：先把当前会话落到旧 id 的键，再读新键', async () => {
    const { wrapper, selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', 'A 的问题')]
    await nextTick()
    const oldConversationId = api.conversationId.value

    selectedWorkflowId.value = 'wf-b'
    await flush()
    await nextTick()

    // 旧键里有 A 的会话（active 还是旧 id）
    const old = storedOf('wf-a')
    expect(old.activeConversationId).toBe(oldConversationId)
    expect(old.sessions[0].messages[0].text).toBe('A 的问题')
    // 新键没有历史 → 新会话
    expect(storedOf('wf-b')).toBeNull()
    expect(api.messages.value).toEqual([])
    expect(api.sessionRestored.value).toBe(false)

    wrapper.unmount()
  })

  it('切成空 id：清空内存且不落盘', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '内容')]
    await nextTick()

    selectedWorkflowId.value = ''
    await flush()
    await nextTick()

    expect(api.messages.value).toEqual([])
    expect(api.sessions.value).toEqual([])
    // 空 workflowId 不写盘：旧键在切换前已 flush 过（含内容）
    expect(storedOf('wf-a')).not.toBeNull()
    expect(storedOf('wf-a').sessions).toHaveLength(1)
  })
})

describe('落盘：节流与 flush 兜底', () => {
  it('消息变化只排一次定时器，到点写入；空 workflowId 不写', async () => {
    vi.useFakeTimers()
    try {
      const { selectedWorkflowId, api } = await setupSession('wf-throttle')
      api.messages.value = [makeMessage('user', '第一帧')]
      await nextTick()
      api.messages.value.push(makeMessage('assistant', '第一答'))
      await nextTick()
      expect(storedOf('wf-throttle')).toBeNull() // 还没到节流窗口

      vi.advanceTimersByTime(SESSION_SAVE_THROTTLE_MS + 10)
      const stored = storedOf('wf-throttle')
      expect(stored).not.toBeNull()
      expect(stored.sessions[0].messages).toHaveLength(2)

      // 空 workflowId：schedule 直接忽略、flush 也直接返回
      selectedWorkflowId.value = ''
      await nextTick()
      api.flush('')
      expect(storedOf('wf-throttle').sessions[0].messages).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush(指定 id)：取消挂起的定时器并立即写进指定键（切工作流写旧键的兜底）', async () => {
    vi.useFakeTimers()
    try {
      const { api } = await setupSession('wf-live')
      api.messages.value = [makeMessage('user', '要立刻落盘')]
      await nextTick()

      vi.advanceTimersByTime(100) // 节流窗口未到
      api.flush('wf-archive')
      const archived = storedOf('wf-archive')
      expect(archived).not.toBeNull()
      expect(archived.sessions[0].messages[0].text).toBe('要立刻落盘')

      // 到点后节流定时器不再重复写（已被 flush 取消，即便写了也是同样内容）
      vi.advanceTimersByTime(SESSION_SAVE_THROTTLE_MS + 10)
      expect(storedOf('wf-live')).toBeNull() // 挂起的写没有落回 wf-live
    } finally {
      vi.useRealTimers()
    }
  })

  it('空会话不入历史也不落盘（清空消息后只剩旧键内容）', async () => {
    const { api } = await setupSession('wf-x')
    api.flush('wf-x')
    expect(storedOf('wf-x')).toBeNull()
  })
})

describe('会话操作', () => {
  it('newConversation：当前会话先入历史，再换新 id；空会话只换 id', async () => {
    const { api } = await setupSession('wf-a')
    api.messages.value = [makeMessage('user', '第一段')]
    await nextTick()
    const firstId = api.conversationId.value

    api.newConversation()
    expect(api.conversationId.value).not.toBe(firstId)
    expect(api.messages.value).toEqual([])
    expect(api.sessions.value).toHaveLength(1)
    expect(api.sessions.value[0].title).toBe('第一段')

    // 空会话再点「新会话」：不产生第二条空历史
    api.newConversation()
    expect(api.sessions.value).toHaveLength(1)
  })

  it('selectConversation：同 id / 未知 id 直接返回；切走时当前会话先落盘', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '第一段')]
    await nextTick()
    const firstId = api.conversationId.value
    api.newConversation()
    const secondId = api.conversationId.value

    // 未知 id：什么都不动
    api.selectConversation('nope')
    expect(api.conversationId.value).toBe(secondId)

    // 同 id：返回
    api.selectConversation(secondId)
    expect(api.conversationId.value).toBe(secondId)

    // 切回第一段：恢复消息，sessionRestored=true；第二段是空会话，不入历史
    api.selectConversation(firstId)
    expect(api.conversationId.value).toBe(firstId)
    expect(api.messages.value[0].text).toBe('第一段')
    expect(api.sessionRestored.value).toBe(true)
    expect(api.sessions.value).toHaveLength(1)
    expect(api.sessions.value[0].title).toBe('第一段')
  })

  it('deleteConversation：删非当前段（写盘但当前不动）；删当前段切到最近一段；删到空则新建', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '甲')]
    await nextTick()
    const firstId = api.conversationId.value
    api.newConversation()
    api.messages.value = [makeMessage('user', '乙')]
    await nextTick()
    const secondId = api.conversationId.value
    api.newConversation() // 当前第三段（空）
    const thirdId = api.conversationId.value

    // 删非当前的「乙」
    api.deleteConversation(secondId)
    expect(api.conversationId.value).toBe(thirdId)
    expect(api.sessions.value.map(s => s.conversationId)).toEqual([firstId])

    // 空 targetId：忽略
    api.deleteConversation('')

    // 删当前空段「第三段」→ 切回最近的第一段
    api.deleteConversation(thirdId)
    expect(api.conversationId.value).toBe(firstId)
    expect(api.messages.value[0].text).toBe('甲')

    // 再删唯一的当前段 → 新 id、空消息
    api.deleteConversation(firstId)
    expect(api.messages.value).toEqual([])
    expect(api.conversationId.value).not.toBe(firstId)
    expect(api.sessions.value).toEqual([])
  })

  it('renameConversation：空白标题忽略；重命名当前会话补条目并落盘', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '问个问题')]
    await nextTick()
    const id = api.conversationId.value

    api.renameConversation('', 'x')
    api.renameConversation(id, '   ')
    expect(storedOf('wf-a')).toBeNull() // 两条都没落盘（空标题被忽略；但当前会话也未写）

    api.renameConversation(id, '  自定义标题  ')
    const stored = storedOf('wf-a')
    expect(stored.sessions[0].title).toBe('自定义标题')
    expect(api.sessions.value[0].title).toBe('自定义标题')
  })

  it('togglePin：置顶后 sessions 排在最前；再点取消', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '第一段')]
    await nextTick()
    const firstId = api.conversationId.value
    api.newConversation()
    api.messages.value = [makeMessage('user', '第二段')]
    await nextTick()
    const secondId = api.conversationId.value

    api.togglePin(firstId)
    // 置顶优先排最前（两段 savedAt 可能同一毫秒，稳定排序下置顶仍必须第一）
    expect(api.sessions.value[0].conversationId).toBe(firstId)
    expect(api.sessions.value[0].pinned).toBe(true)

    api.togglePin(firstId)
    expect(api.sessions.value.map(item => item.pinned).filter(Boolean)).toEqual([])
    expect(api.sessions.value.map(item => item.conversationId).sort())
      .toEqual([firstId, secondId].sort())
  })

  it('sessionMessages：当前会话取内存，历史段取条目，未知段返回 []', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '当前')]
    await nextTick()
    const currentId = api.conversationId.value
    api.newConversation()
    api.messages.value = [makeMessage('user', '新段')]
    await nextTick()
    const newId = api.conversationId.value

    expect(api.sessionMessages(newId)[0].text).toBe('新段')
    expect(api.sessionMessages(currentId)[0].text).toBe('当前')
    expect(api.sessionMessages('nope')).toEqual([])
  })

  it('exportSessions：全部会话快照，标题缺失时从消息取，置顶优先', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '较长的第一段消息内容')]
    await nextTick()
    const firstId = api.conversationId.value
    api.newConversation()
    api.messages.value = [makeMessage('user', '第二段')]
    await nextTick()
    api.togglePin(api.conversationId.value)

    const exported = api.exportSessions()
    expect(exported).toHaveLength(2)
    expect(exported[0].messages[0].text).toBe('第二段') // 置顶优先
    const first = exported.find(item => item.conversationId === firstId)
    expect(first.title).toBe('较长的第一段消息内容') // 没重命名 → 从首条用户消息取
  })

  it('clearAll：清空内存并写空集合（v2 键被清掉）', async () => {
    const { selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '内容')]
    await nextTick()
    api.flush('wf-a')
    expect(storedOf('wf-a')).not.toBeNull()

    api.clearAll()
    expect(api.messages.value).toEqual([])
    expect(api.sessions.value).toEqual([])
    expect(storedOf('wf-a')).toBeNull()
  })
})

describe('卸载兜底', () => {
  it('onBeforeUnmount：立即 flush 当前会话（不等节流定时器）', async () => {
    const { wrapper, selectedWorkflowId, api } = await setupSession('')
    selectedWorkflowId.value = 'wf-a'
    await flush()
    api.messages.value = [makeMessage('user', '路由离开前的最后一条')]
    await nextTick()
    const id = api.conversationId.value

    wrapper.unmount()
    const stored = storedOf('wf-a')
    expect(stored).not.toBeNull()
    expect(stored.activeConversationId).toBe(id)
    expect(stored.sessions[0].messages[0].text).toBe('路由离开前的最后一条')
  })
})
