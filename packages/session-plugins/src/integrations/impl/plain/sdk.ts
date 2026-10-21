/**
 * `@team-plain/graphql` 只经这里按需加载。
 *
 * 这个包是生成出来的整套 GraphQL 文档(构建后约 8 MB,全是模块顶层的对象字面量)。静态 import 时
 * 它被打进主进程启动就加载的共享 chunk:没连 Plain 的人也要在主进程里留一份源码串(含中文的 chunk
 * 按双字节存,约 16 MB)外加求值出来的整棵文档对象图。只有真去连 Plain 时才需要它 ⇒ 动态 import,
 * 构建会把它切成单独的 chunk。
 *
 * 类型照常 `import type`(编译期擦除,不产生运行时依赖);❌ 在别处写值 import,那会把它拉回启动路径。
 */
export type PlainSdk = typeof import('@team-plain/graphql');

let sdk: Promise<PlainSdk> | null = null;

export function loadPlainSdk(): Promise<PlainSdk> {
  sdk ??= import('@team-plain/graphql');
  return sdk;
}
