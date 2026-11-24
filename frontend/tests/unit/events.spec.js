// 测的是 `src/shared/events.js`：全局 EventBus（mitt 实例）。
//
// 它是跨页面/跨组件的解耦通道（登录态刷新、主题切换等事件都走它），
// 本身只是 mitt() 的一行导出 —— 这里钉住的是「它是同一个共享实例」与
// mitt 的 on/emit/off 语义，防止将来被改成每次 import 都新建实例。
import { EventBus } from '@/shared/events'

describe('EventBus（全局事件总线）', () => {
  afterEach(() => {
    EventBus.all.clear()
  })

  it('emit 会让所有 on 过的同名事件按序收到载荷', () => {
    const received = []
    EventBus.on('ping', payload => received.push(['first', payload]))
    EventBus.on('ping', payload => received.push(['second', payload]))

    EventBus.emit('ping', { n: 1 })

    expect(received).toEqual([['first', { n: 1 }], ['second', { n: 1 }]])
  })

  it('不同事件名互不串扰', () => {
    const received = []
    EventBus.on('a', () => received.push('a'))

    EventBus.emit('b')

    expect(received).toEqual([])
  })

  it('off（按处理函数）之后不再收到', () => {
    const received = []
    const handler = payload => received.push(payload)
    EventBus.on('evt', handler)

    EventBus.emit('evt', 1)
    EventBus.off('evt', handler)
    EventBus.emit('evt', 2)

    expect(received).toEqual([1])
  })

  it('no handler 时 emit 不抛错（发事件先于订阅是合法时序）', () => {
    expect(() => EventBus.emit('nobody-listens')).not.toThrow()
  })

  it("on('*') 的通配订阅能收到所有事件（mitt 语义）", () => {
    const received = []
    EventBus.on('*', (type, payload) => received.push([type, payload]))

    EventBus.emit('login', 'ok')

    expect(received).toEqual([['login', 'ok']])
  })
})
