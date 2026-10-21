// 合成夹具:每一种「类名怎么到达 <button>」的形态各一份。
// 这些形态里有四种在真实扫描中骗过了我,所以它们必须在这里被逐个点名。
import type React from 'react'
import { sharedGhost, sharedStyles } from './styles'

// 夹具要能通过 typecheck,所以这两个 Base UI 形态的宿主在本地声明。
// 它们只提供形状 —— 扫描器读的是 JSX 文本,不解析类型。
declare const Menu: { Trigger: (p: { render: React.ReactElement }) => React.ReactElement }
declare const DropdownMenu: { Trigger: (p: { className: string }) => React.ReactElement }

const constRef = 'gg-ghost grid size-7 place-items-center'
const hoverOnlyRef = 'bg-transparent hover:bg-[var(--hover)]'
const styleMap = {
  adopted: 'gg-row flex items-center',
  full: 'rounded-lg hover:bg-[var(--hover)] active:bg-[var(--press)]',
  hoverOnly: 'rounded-lg hover:bg-[var(--hover)]',
}

export function Sample() {
  return (
    <div>
      {/* 1. 字面量,已采用 token */}
      <button className="gg-ghost">a</button>
      {/* 2. 字面量,只有 hover */}
      <button className="hover:bg-[var(--hover)]">b</button>
      {/* 3. 字面量,什么反馈都没有 */}
      <button className="rounded-lg">c</button>
      {/* 4. 变量引用 —— 标签里看不到 gg-ghost 三个字 */}
      <button className={constRef}>d</button>
      {/* 5. 变量引用,只有 hover */}
      <button className={hoverOnlyRef}>e</button>
      {/* 6. 箭头函数:onClick 里的 '>' 不是开标签结束,className 在它之后 */}
      <button onClick={() => void 0} className="gg-fill">f</button>
      {/* 7. 样式表对象成员,已采用 */}
      <button className={styleMap.adopted}>g</button>
      {/* 8. 样式表对象成员,四态齐全但没用 token 类 */}
      <button className={styleMap.full}>h</button>
      {/* 9. 样式表对象成员,只有 hover */}
      <button className={styleMap.hoverOnly}>i</button>
      {/* 10. 完全没有 className:Base UI render-prop,样式由父组件给 —— 不是债务 */}
      <Menu.Trigger render={<button type="button" />} />
      {/* 11. 非 <button> 元素带 token 类:不能被算进 button 计数 */}
      <DropdownMenu.Trigger className={constRef} />
      <button className={sharedStyles.closeButton}>j</button>
      <button className={sharedGhost}>k</button>
    </div>
  )
}
