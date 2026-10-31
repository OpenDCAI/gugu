import { z } from 'zod';

// ---------------------------------------------------------------------------
// Serializability primitives
// ---------------------------------------------------------------------------

/** A value guaranteed to survive structuredClone / JSON across the IPC boundary. */
export type Serializable =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: Serializable }
  | readonly Serializable[];

/** The serializable shadow of a thrown JS Error, captured at a catch boundary. */
export type SerializedError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /**
   * 协议错误把**能用的那句话**放在这里,而不是 `message` 里。
   *
   * ⚠️ 这一格是 2026-09-07 用一整天换来的:claude 的侧边聊天失败,产品面从头到尾
   * 只看到一句 `Internal error` —— 那就是 JSON-RPC 的 `message` 字面量。
   * 而**同一条响应**的 `data` 里写着
   * `{"details":"Session <id> not found in project directory for <cwd>"}`。
   * owner 报了、两条车道各查一轮,都因为这半被**在 catch 边界丢掉**而无处可查。
   *
   * ⇒ `message` 恰好是最容易接、也最没信息量的那个字段 ——
   * 所以"把错误序列化"这件事天然会停在它那儿,而且停下来时看起来是做完了。
   */
  readonly data?: Serializable;
  /**
   * 协议自己的那个码(JSON-RPC 的 `code`、HTTP 风格的状态码),原样带着。
   *
   * ⚠️ 它此前被 `toSerializedError` 丢在门外:序列化只收 name/message/stack/data,
   * 于是「上游到底回了什么码」在 catch 边界之后就再也问不到了。而用户手上**唯一**
   * 能拿去对账的东西往往正是它 —— ❌ 不许再丢。
   */
  readonly code?: number | string;
};

/**
 * 只收**明显可克隆**的 `data`:字符串,或一层内全是原始值的普通对象/数组。
 *
 * ❌ 不做深拷贝、不递归:这一格在 catch 边界上,任何在这里抛的东西都会把
 * 「一次可以解释的失败」变成「一次没有任何信息的失败」。
 * ⚠️ 也刻意**不搬整个 error 对象** —— 那会顺手把上游塞进去的任何东西带进日志。
 */
const serializableData = (value: unknown): Serializable | undefined => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, Serializable> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = item;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/** `data` 里那句人话:协议错误把它放在 `data.details`,或者 `data` 本身就是一句话。 */
const dataSentence = (data: unknown): string | undefined => {
  if (typeof data === 'string') return data.trim() || undefined;
  if (data && typeof data === 'object') {
    const details = (data as { details?: unknown }).details;
    if (typeof details === 'string') return details.trim() || undefined;
  }
  return undefined;
};

/**
 * 一条错误**能说的全部** —— 一句人话 + 它自己带着的结构化负载,逐字,不挑不减。
 *
 * ⚠️ **只许有这一份。** 消费者有两个:运行时把它写进失败回合的 `outcome.detail`,
 * 渲染层把它记进「没做成」那条弹窗的日志(弹窗本身按原因表说,#7103)。两边各抄一份精度顺序的话,
 * 同一次失败在界面上与日志里会是两句不同的话 —— 对账时会以为那是两件事。
 *
 * # 为什么不是「只取 `data` 里那句话」(2026-09-20 改宽,#5858)
 *
 * 旧版只回 `data`(或 `data.details`)里的字符串,调用方再 `|| message` 回落。真机读数把这个
 * 形状的代价量出来了:codex 在 prompt 边界拒收一条超长指令,`cause` 是
 * `message="Input exceeds the maximum length of 1048576 characters."` +
 * `data={"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1400034}`。
 * `data` 是**对象、且没有 `details`** ⇒ 旧版返回 undefined ⇒ 那三个字段**一个字都没到用户手上**,
 * 连 tooltip 都没有。它们活着穿过了序列化边界,是在这里被丢掉的。
 *
 * ⇒ 现在的合同:**句子在前,负载在后,两者都不丢**。
 *   第一行 = `data.details` / `data`(字符串)/ `message`,按这个精度顺序取**一句**;
 *   第二行 = `code` 与 `data` 一层内的每一对 `键=值`,原样列出。
 * ❌ 不按「已经在句子里」去重(`max_chars` 与 `actual_chars` 都是数字,谁"已经在句子里"不可靠)——
 *   只跳过**一字不差就是那句话**的字段:codex 桥把 `turn.error` 整个塞进 `data`,它的 `message` 与第一行
 *   逐字相同,列出来就是「回合失败」点开同一句说两遍(#7103);
 * ❌ 不在这里截断(超长由界面折叠,见 turn-outcome 那一行)。
 */
export const errorDetail = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { message?: unknown; data?: unknown; code?: unknown };
  const sentence =
    dataSentence(record.data)
    ?? (typeof record.message === 'string' ? record.message.trim() || undefined : undefined);

  const fields: string[] = [];
  if (typeof record.code === 'number' || typeof record.code === 'string') {
    fields.push(`code=${record.code}`);
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      // 已经当句子用掉的那一句(`details`,或与 `message` 一字不差的那一格),再列一遍就是同一句话说两遍。
      if (typeof value === 'string' && (key === 'details' || value.trim() === sentence)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        fields.push(`${key}=${value}`);
      }
    }
  }

  const payload = fields.length > 0 ? fields.join(', ') : undefined;
  if (sentence && payload) return `${sentence}\n${payload}`;
  return sentence ?? payload;
};

/**
 * A rejection that is a plain object, not an Error: a JSON-RPC error as an ACP agent sends it (`{ code, message, data }`).
 * `String(e)` turned it into "[object Object]", so the turn failure reached the chat as a bare generic notice and the log
 * kept nothing to explain it. Its own fields are kept the way an Error's are; an object without a message is described
 * by its top-level primitive fields only, never the whole object.
 */
const plainObjectError = (e: object): SerializedError => {
  const record = e as { name?: unknown; message?: unknown; data?: unknown; code?: unknown };
  const data = serializableData(record.data);
  const code = record.code;
  const fields = serializableData(e);
  // Same order as the description above: the protocol's `data.details` is the sentence, `message` is often just "Internal error".
  const message = dataSentence(record.data)
    ?? (typeof record.message === 'string' && record.message.trim() ? record.message : undefined)
    ?? JSON.stringify(fields ?? {});
  return {
    name: typeof record.name === 'string' && record.name ? record.name : 'Unknown',
    message,
    ...(data !== undefined ? { data } : {}),
    ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
  };
};

/** Normalizes any thrown value into a cloneable SerializedError. */
export const toSerializedError = (e: unknown): SerializedError => {
  if (!(e instanceof Error)) return e && typeof e === 'object' ? plainObjectError(e) : { name: 'Unknown', message: String(e) };
  // JSON-RPC 的 RequestError 把细节挂在 `data` 上 —— 见 `SerializedError.data` 那段。
  const data = serializableData((e as { data?: unknown }).data);
  const code = (e as { code?: unknown }).code;
  return {
    name: e.name,
    message: e.message,
    stack: e.stack,
    ...(data !== undefined ? { data } : {}),
    ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
  };
};

// ---------------------------------------------------------------------------
// Core Result shape — plain objects, never class instances, safe on the wire
// ---------------------------------------------------------------------------

export type Ok<T> = { readonly success: true; readonly data: T };
export type Err<E> = { readonly success: false; readonly error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

export const ok = <T>(data: T = undefined as T): Ok<T> => ({ success: true, data });
export const err = <E>(error: E): Err<E> => ({ success: false, error });

/**
 * Wraps a Result<T, E> on the wire as a discriminated union.
 * Domain outcomes use this helper; transport-level failures should stay in
 * the transport's error mechanism.
 */
/**
 * `resultSchema` 的返回类型必须**显式写出**,不能靠推断。
 *
 * @@@task-fusion (#2802) — 并入本体后全仓统一用 tsc(此前 task 子树走 tsgo,从未被真 tsc 检查过)。
 * 调用方 `fallible` 原本用实例化表达式 `ReturnType<typeof resultSchema<D, E>>` 取它的返回类型,
 * 这条路径叠加 zod 4 里重载极多的 `z.discriminatedUnion`,会让 tsc 在 `resolveCall` 直接崩:
 * `Debug Failure. No error for last overload signature`(TS 5.9.3 与 6.0.3 均复现)。
 * 显式标注后调用方可直接引用 `ResultSchema<D, E>`,不再需要实例化表达式,崩溃消失且类型精度不变。
 */
export type ResultSchema<D extends z.ZodTypeAny, E extends z.ZodTypeAny> = z.ZodDiscriminatedUnion<
  [
    z.ZodObject<{ success: z.ZodLiteral<true>; data: D }>,
    z.ZodObject<{ success: z.ZodLiteral<false>; error: E }>,
  ]
>;

export const resultSchema = <D extends z.ZodTypeAny, E extends z.ZodTypeAny>(
  data: D,
  error: E
): ResultSchema<D, E> =>
  z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data }),
    z.object({ success: z.literal(false), error }),
  ]);

// ---------------------------------------------------------------------------
// Tagged errors with a typed, serializable cause chain
// ---------------------------------------------------------------------------

/**
 * A discriminated error with an optional, recursively-typed cause.
 * `Cause` must be another `BaseError` or a `SerializedError` so the whole
 * chain stays structuredClone-safe across the IPC boundary.
 */
export type BaseError<
  Type extends string = string,
  Cause extends BaseError | SerializedError | undefined = undefined,
> = {
  readonly type: Type;
  readonly message?: string;
  readonly cause?: Cause;
};

/**
 * Builds a tagged `Err` with an optional typed cause in one call.
 *
 * @example
 * return fail('session_persistence_failed', {
 *   message: 'Failed to retrieve token',
 *   cause: toSerializedError(error),
 * });
 */
export const fail = <
  Type extends string,
  Cause extends BaseError | SerializedError | undefined = undefined,
>(
  type: Type,
  opts?: { message?: string; cause?: Cause }
): Err<BaseError<Type, Cause>> =>
  err({ type, message: opts?.message, cause: opts?.cause } as BaseError<Type, Cause>);

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.success;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.success;

// ---------------------------------------------------------------------------
// Inference helpers — derive the data / error type from a Result, a
// Promise<Result>, or a function returning either. Single source of truth.
// ---------------------------------------------------------------------------

export type DataOf<R> = R extends (...args: any[]) => infer Ret
  ? DataOf<Ret>
  : R extends Promise<infer V>
    ? DataOf<V>
    : R extends Ok<infer T>
      ? T
      : never;

export type ErrorOf<R> = R extends (...args: any[]) => infer Ret
  ? ErrorOf<Ret>
  : R extends Promise<infer V>
    ? ErrorOf<V>
    : R extends Err<infer E>
      ? E
      : never;

// ---------------------------------------------------------------------------
// Free-function combinators — operate on plain objects, identical before and
// after IPC, no wrapper overhead.
// ---------------------------------------------------------------------------

/** Transform the success value; errors pass through unchanged. */
export const map = <T, U, E>(r: Result<T, E>, f: (v: T) => U): Result<U, E> =>
  r.success ? ok(f(r.data)) : r;

/** Transform the error value; success passes through unchanged. */
export const mapErr = <T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> =>
  r.success ? r : err(f(r.error));

/** Chain a fallible sync operation. Short-circuits on the first Err. */
export const andThen = <T, U, E, F>(r: Result<T, E>, f: (v: T) => Result<U, F>): Result<U, E | F> =>
  r.success ? f(r.data) : r;

/** Chain a fallible async operation. Short-circuits on the first Err. */
export const andThenAsync = async <T, U, E, F>(
  r: Result<T, E>,
  f: (v: T) => Promise<Result<U, F>>
): Promise<Result<U, E | F>> => (r.success ? f(r.data) : r);

/** Recover from an error by providing an alternative Result. */
export const orElse = <T, E, F>(r: Result<T, E>, f: (e: E) => Result<T, F>): Result<T, F> =>
  r.success ? r : f(r.error);

/** Unwrap the success value or return a fallback. */
export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.success ? r.data : fallback);

/** Unwrap the success value or compute a fallback from the error. */
export const unwrapOrElse = <T, E>(r: Result<T, E>, f: (e: E) => T): T =>
  r.success ? r.data : f(r.error);

/** Run a side-effect on success without altering the Result. */
export const tap = <T, E>(r: Result<T, E>, f: (v: T) => void): Result<T, E> => {
  if (r.success) f(r.data);
  return r;
};

/** Run a side-effect on failure without altering the Result. */
export const tapErr = <T, E>(r: Result<T, E>, f: (e: E) => void): Result<T, E> => {
  if (!r.success) f(r.error);
  return r;
};

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Fail-fast: returns the first Err encountered, otherwise all data as an array. */
export const sequence = <T, E>(results: readonly Result<T, E>[]): Result<T[], E> => {
  const data: T[] = [];
  for (const r of results) {
    if (!r.success) return r;
    data.push(r.data);
  }
  return ok(data);
};

/** Collect-all: gathers every error instead of stopping at the first. */
export const sequenceAll = <T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> => {
  const data: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.success) data.push(r.data);
    else errors.push(r.error);
  }
  return errors.length > 0 ? err(errors) : ok(data);
};

// ---------------------------------------------------------------------------
// Wrapping throwing / promise-returning code into a Result
// ---------------------------------------------------------------------------

export const tryCatch = <T, E = SerializedError>(
  fn: () => T,
  onError: (e: unknown) => E = toSerializedError as (e: unknown) => E
): Result<T, E> => {
  try {
    return ok(fn());
  } catch (e) {
    return err(onError(e));
  }
};

export const tryCatchAsync = async <T, E = SerializedError>(
  fn: () => Promise<T>,
  onError: (e: unknown) => E = toSerializedError as (e: unknown) => E
): Promise<Result<T, E>> => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(onError(e));
  }
};

// ---------------------------------------------------------------------------
// Generator do-notation — write happy-path code that auto-short-circuits.
//
// Usage:
//   const result = gen(function* () {
//     const a = yield* unwrapGen(stepOne());
//     const b = yield* unwrapGen(stepTwo(a));
//     return { a, b };
//   });
// ---------------------------------------------------------------------------

export function* unwrapGen<T, E>(r: Result<T, E>): Generator<Err<E>, T, any> {
  if (r.success) return r.data;
  yield r;
  // Unreachable: the generator is never resumed after yielding an Err.
  throw new Error('unreachable');
}

export function gen<T, E>(body: () => Generator<Err<E>, T, any>): Result<T, E> {
  const it = body();
  const step = it.next();
  return step.done ? ok(step.value) : step.value;
}

export async function* unwrapGenAsync<T, E>(
  r: Result<T, E> | Promise<Result<T, E>>
): AsyncGenerator<Err<E>, T, any> {
  const awaited = await r;
  if (awaited.success) return awaited.data;
  yield awaited;
  throw new Error('unreachable');
}

export async function genAsync<T, E>(
  body: () => AsyncGenerator<Err<E>, T, any>
): Promise<Result<T, E>> {
  const it = body();
  const step = await it.next();
  return step.done ? ok(step.value) : step.value;
}

// ---------------------------------------------------------------------------
// Opt-in fluent wrappers — local chaining sugar; never appear in wire/return
// types. FluentResult wraps sync Results; AsyncResult wraps Promises of Results
// and is itself PromiseLike so `await` resolves to a plain Result.
// ---------------------------------------------------------------------------

class FluentResult<T, E> {
  constructor(private readonly r: Result<T, E>) {}

  map<U>(f: (v: T) => U): FluentResult<U, E> {
    return new FluentResult(map(this.r, f));
  }

  mapErr<F>(f: (e: E) => F): FluentResult<T, F> {
    return new FluentResult(mapErr(this.r, f));
  }

  andThen<U, F>(f: (v: T) => Result<U, F>): FluentResult<U, E | F> {
    return new FluentResult(andThen(this.r, f));
  }

  orElse<F>(f: (e: E) => Result<T, F>): FluentResult<T, F> {
    return new FluentResult(orElse(this.r, f));
  }

  tap(f: (v: T) => void): FluentResult<T, E> {
    return new FluentResult(tap(this.r, f));
  }

  tapErr(f: (e: E) => void): FluentResult<T, E> {
    return new FluentResult(tapErr(this.r, f));
  }

  unwrapOr(fallback: T): T {
    return unwrapOr(this.r, fallback);
  }

  /** Exit the fluent wrapper and return the plain, serializable Result. */
  unwrap(): Result<T, E> {
    return this.r;
  }

  toJSON(): Result<T, E> {
    return this.r;
  }
}

class AsyncResult<T, E> implements PromiseLike<Result<T, E>> {
  constructor(private readonly p: Promise<Result<T, E>>) {}

  map<U>(f: (v: T) => U | Promise<U>): AsyncResult<U, E> {
    return new AsyncResult(this.p.then(async (r) => (r.success ? ok(await f(r.data)) : r)));
  }

  mapErr<F>(f: (e: E) => F): AsyncResult<T, F> {
    return new AsyncResult(this.p.then((r) => mapErr(r, f)));
  }

  andThen<U, F>(f: (v: T) => Result<U, F> | Promise<Result<U, F>>): AsyncResult<U, E | F> {
    return new AsyncResult<U, E | F>(
      this.p.then(async (r): Promise<Result<U, E | F>> => (r.success ? f(r.data) : r))
    );
  }

  orElse<F>(f: (e: E) => Result<T, F> | Promise<Result<T, F>>): AsyncResult<T, F> {
    return new AsyncResult<T, F>(
      this.p.then(async (r): Promise<Result<T, F>> => (r.success ? r : f(r.error)))
    );
  }

  tap(f: (v: T) => void): AsyncResult<T, E> {
    return new AsyncResult(this.p.then((r) => tap(r, f)));
  }

  tapErr(f: (e: E) => void): AsyncResult<T, E> {
    return new AsyncResult(this.p.then((r) => tapErr(r, f)));
  }

  unwrapOr(fallback: T): Promise<T> {
    return this.p.then((r) => unwrapOr(r, fallback));
  }

  unwrapOrElse(f: (e: E) => T | Promise<T>): Promise<T> {
    return this.p.then((r) => (r.success ? r.data : f(r.error)));
  }

  /**
   * PromiseLike implementation: `await asyncResult` resolves to a plain Result,
   * ready for use on either side of the IPC boundary.
   */
  then<R1 = Result<T, E>, R2 = never>(
    onfulfilled?: ((v: Result<T, E>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return this.p.then(onfulfilled, onrejected);
  }
}

/**
 * Entry points for the opt-in fluent API.
 *
 * @example
 * // Sync chain
 * const r = Result.from(someResult).map(transform).mapErr(retag).unwrap();
 *
 * // Async chain — awaits to a plain Result
 * const r = await Result.fromAsync(somePromise).map(transform).mapErr(retag);
 *
 * // Wrapping a throwing function
 * const r = Result.try(() => JSON.parse(input));
 * const r = await Result.tryAsync(() => fetch(url).then((res) => res.json()));
 */
export const Result = {
  from: <T, E>(r: Result<T, E>): FluentResult<T, E> => new FluentResult(r),
  fromAsync: <T, E>(p: Promise<Result<T, E>>): AsyncResult<T, E> => new AsyncResult(p),
  try: tryCatch,
  tryAsync: <T>(fn: () => Promise<T>): AsyncResult<T, SerializedError> =>
    new AsyncResult(tryCatchAsync(fn)),
};

// ---------------------------------------------------------------------------
// Async utilities (unchanged from original)
// ---------------------------------------------------------------------------

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
