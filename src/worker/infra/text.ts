// 文本的量词与长度上限（§G.2 的 100 词、§I.3「100 词上限在发送前强制」）。
//
// 计数规则与上游 `infra/text.ts` 相同：中英混排一律按 `Intl.Segmenter('zh', 'word')` 的
// 词段计数（`isWordLike`，标点不算），英文退化为按空白分词。这条规则只有一份：`reply` /
// `ack` / `ticket note` 的命令面与 Feishu Channel 的发送前校验都读它，因此「CLI 收下了、
// 发送时却被拒」不会发生。
//
// 依赖纪律（§C.2）：infra 只依赖平台能力，不 import 其他源码目录（错误码的翻译留给调用方：
// 命令面抛 `too_long`，Channel 让它冒泡成一次可重试的失败）。

/** 一条对外的即时消息（ack / reply / attention / 结果）的词数上限（§G.2）。 */
export const IM_WORDS = 100

/** 一条路由说明（routing note）的词数上限（§G.2）。 */
export const NOTE_WORDS = 30

/** 词段切分器：`zh` 的词典同时切中文词与英文单词（上游同一构造）。 */
const segments = new Intl.Segmenter('zh', { granularity: 'word' })

/**
 * 数一条文本的词数：中文按词、英文按空白分隔的单词，标点不计入。
 * Markdown 链接的文字与目标都算（它们都是会被人读到的词）。
 */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of segments.segment(text)) if (segment.isWordLike) count += 1
  return count
}

/**
 * 一条即时消息的发送前校验：超过 `IM_WORDS` 就抛错，调用方决定这是拒绝（CLI 的 `too_long`）
 * 还是一次可重试的失败（Channel）。消息本身不回显——错误里只有词数与上限。
 */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) {
    throw new Error(
      `IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`
    )
  }
  return text
}
