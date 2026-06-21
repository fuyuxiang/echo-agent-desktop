import mitt from 'mitt'

/**
 * 全局事件总线(mitt)
 *
 * 适用场景: 跨页面/跨组件的轻量通知(非状态数据,状态请用 zustand)
 * 新事件先在 BusEvents 中声明类型,获得完整类型提示
 *
 * 用法:
 *   eventBus.on('example:refresh', handler)
 *   eventBus.emit('example:refresh')
 *   eventBus.off('example:refresh', handler)
 */
export interface BusEvents {
  /** 示例事件:通知 Example 页刷新列表 */
  'example:refresh': void

  // 新事件依葫芦画瓢:
  // 'chat:scroll-to-bottom': { smooth: boolean }
  [key: string]: unknown
  [key: symbol]: unknown
}

export const eventBus = mitt<BusEvents>()
