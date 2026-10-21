const props = new Map<string, { __html: string }>()

/**
 * @@@icon-body-identity(同 packages/session-ui 的图标工厂)—— 固定标记(厂商 / 引擎 / shell 的字形)的
 * `dangerouslySetInnerHTML` 值:同一段标记每次拿到同一个对象。React 19 按引用比这个属性,每次渲染给一个新对象
 * 它就把 innerHTML 重写一遍,里面的 svg 整个换新 —— 通讯录每一行 agent 的引擎角标都这样,一次重渲染就是几百次重建。
 * 只给有限的那几套字形用(键是标记本身);❌ 用来塞消息正文、mermaid 图这类每次都不一样的内容。
 */
export function htmlProp(markup: string): { __html: string } {
  let prop = props.get(markup)
  if (!prop) {
    prop = { __html: markup }
    props.set(markup, prop)
  }
  return prop
}
