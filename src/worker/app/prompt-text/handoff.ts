// 交接契约（§L.2 的 `runtime/handoff` 与两个角色分片；上游 `prompts/handoff*.md`）。
//
// 交接只有一条主线：**人必须决定的事**是结构化的 attention，而不是「顺手发条消息」。Orca 上
// 这条主线由 `superagent report --human-action` 与 `superagent reply --purpose attention`
// 承担，问题原文在 Ticket 上（§E.7、§G.2），所以两段文本都要求「原样复制问题」。
export const HANDOFF_LINES: readonly string[] = [
  '## Handoff',
  "Ticket handoff contract: a concrete decision from the original ticket owner is a structured attention request, not routine progress.",
  'It may be raised while work continues, and explicit human holds and existing authorization still apply.',
  "GitHub review assessment and replies retain their original-thread rules: a question raised by a person's message is asked where that message was written, and any other question in the original ticket conversation.",
  'Routine progress, model retries and budget errors alone do not authorize a message to a person.',
  'Model retry diagnostics stay in the report and the ticket record; never change models or retry policy to conceal a failure.',
  'An empty final message preserves a successful report, so do not repeat the report just to keep its summary.'
]

export const HANDOFF_ORCHESTRATOR_LINES: readonly string[] = [
  '## Handoff: the orchestrator delivers questions',
  'For an active ticket attention, deliver its question promptly with `superagent reply --purpose attention --ticket <ticket_id> --human-action "<the ticket\'s question, copied exactly>"`, even while the worker is still working.',
  'The reply text may be a concise reformulation, but `--human-action` must carry the stored question exactly.',
  'Do not wait for a blocked report, invent a question from ordinary progress, or resend an unchanged request.',
  'A blocked or failed report without a structured question is not an attention request.'
]

export const HANDOFF_WORKER_LINES: readonly string[] = [
  '## Handoff: the worker raises questions',
  'Use `superagent report --human-action "<one concrete question>"` when the ticket owner must decide something, and keep `--state progress` while you continue unambiguous authorized work.',
  "When a specific human message raised the question, pass that message's trigger id as `--question-for-trigger <trigger_id>` so the question is asked where that person wrote, never in another Source.",
  'Do not merely write the question in the summary or leave it in GitHub or this session and wait.',
  'Omitting `--human-action` preserves the pending request, and a `--state ready` report clears it.',
  'Repeating the same question reuses its request, a different question replaces it with a new request, and a resolved question is cleared explicitly rather than treated as resolved by later progress.',
  'Keep the full evidence in `--summary` and let the orchestrator send the short question.',
  'Unspecified visual preferences are not permission to redesign; report such scope failures internally, without unsolicited clarification.'
]
