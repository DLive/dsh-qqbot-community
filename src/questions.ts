/**
 * QQ-side user-questions bridge: when a QQ agent calls the model-facing
 * `ask_user_question` tool, the question would otherwise land on the host's
 * single UI provider (the web question composer) and the QQ chat would stall
 * with no way to answer. This bridge intercepts the tool dispatch through the
 * scope-filtered `tools/execute` waterfall, renders the questions on QQ
 * (inline-keyboard buttons for simple single-choice, numbered text for
 * everything else), and settles the call from button callbacks
 * (INTERACTION_CREATE) or from a plain text reply consumed out of the inbound
 * pipeline.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config, ReplyTarget } from './types.js'
import type { LogSink, QQApi } from './qqapi.js'
import type { RouteStore } from './store.js'
import { targetOfSession } from './inbound.js'

/** Max buttons rendered in the single keyboard row (QQ inline-keyboard cap). */
const MAX_BUTTONS = 5

/** One normalized question as handed over from the tool arguments. */
export interface NormalizedQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect: boolean
}

/** One answered question in the tool-result vocabulary. */
export interface QuestionAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

interface PendingAsk {
  readonly token: string
  readonly sessionId: string
  readonly questions: readonly NormalizedQuestion[]
  resolve: (answers: readonly QuestionAnswer[]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

/** Validate the raw `ask_user_question` arguments into normalized questions. */
export function normalizeQuestions(raw: unknown): readonly NormalizedQuestion[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const questions: NormalizedQuestion[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return undefined
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) return undefined
    if (typeof record.question !== 'string' || record.question.length === 0) return undefined
    const options: { label: string; description?: string }[] = []
    if (record.options !== undefined) {
      if (!Array.isArray(record.options)) return undefined
      for (const option of record.options) {
        if (option === null || typeof option !== 'object') return undefined
        const optionRecord = option as Record<string, unknown>
        if (typeof optionRecord.label !== 'string' || optionRecord.label.length === 0) return undefined
        options.push({
          label: optionRecord.label,
          ...(typeof optionRecord.description === 'string' && optionRecord.description.length > 0
            ? { description: optionRecord.description }
            : {}),
        })
      }
    }
    questions.push({
      id: record.id,
      question: record.question,
      ...(typeof record.header === 'string' && record.header.length > 0 ? { header: record.header } : {}),
      options,
      multiSelect: record.multi_select === true,
    })
  }
  return questions
}

/** Render the question block shown on QQ. */
export function renderQuestionText(questions: readonly NormalizedQuestion[], buttons: boolean): string {
  const lines: string[] = ['❓ 需要你的回答：', '']
  questions.forEach((question, index) => {
    if (questions.length > 1) lines.push(`【${index + 1}】${question.header !== undefined ? `${question.header}：` : ''}${question.question}`)
    else if (question.header !== undefined) lines.push(`${question.header}：${question.question}`)
    else lines.push(question.question)
    question.options.forEach((option, optionIndex) => {
      lines.push(`  ${optionIndex + 1}. ${option.label}`)
      if (option.description !== undefined) lines.push(`     — ${option.description}`)
    })
  })
  lines.push('')
  if (buttons && questions.length === 1 && questions[0].options.length > 0) {
    lines.push('👉 点击下方按钮选择，或直接回复文字。')
  } else if (questions.length === 1 && questions[0].multiSelect) {
    lines.push('👉 多选题：回复编号（如 "1,3"），或直接回复文字。')
  } else if (questions.length === 1 && questions[0].options.length > 0) {
    lines.push('👉 回复编号或选项文字；回复其它文字视为自定义答案。')
  } else {
    lines.push(`👉 请${questions.length > 1 ? `分 ${questions.length} 行` : ''}直接回复你的答案。`)
  }
  return lines.join('\n')
}

/**
 * Parse one free-text answer against a question's options.
 * @returns the answer, or an error string explaining why the text is unusable.
 */
export function parseOneAnswer(
  question: NormalizedQuestion,
  text: string,
): QuestionAnswer | { error: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { error: '回答为空' }
  if (question.options.length === 0) return { id: question.id, selected: [], custom: trimmed }

  // Number list ("1", "1,3", "1 3") → labels.
  const tokens = trimmed.split(/[,，、;；\s]+/).filter((token) => token.length > 0)
  const allNumbers = tokens.length > 0 && tokens.every((token) => /^\d+$/.test(token))
  if (allNumbers) {
    const indexes = tokens.map((token) => Number.parseInt(token, 10))
    if (indexes.every((value) => value >= 1 && value <= question.options.length)) {
      const selected = [...new Set(indexes.map((value) => question.options[value - 1].label))]
      if (!question.multiSelect && selected.length > 1) {
        return { error: `「${question.question}」只能选择一项，请只回复一个编号` }
      }
      return { id: question.id, selected }
    }
    // Numbers out of range fall through to an error (not custom text — the
    // user clearly tried to select by number).
    return { error: `编号超出范围（1-${question.options.length}）` }
  }

  // Label list → labels (each token must name an option).
  const labels = new Set(question.options.map((option) => option.label))
  if (tokens.length > 0 && tokens.every((token) => labels.has(token))) {
    const selected = [...new Set(tokens)]
    if (!question.multiSelect && selected.length > 1) {
      return { error: `「${question.question}」只能选择一项，请只回复一个选项` }
    }
    return { id: question.id, selected }
  }

  // Exact single-label match with surrounding punctuation/space tolerance.
  const stripped = trimmed.replace(/^[«"“‘\s]+|[»"”’\s]+$/g, '')
  if (labels.has(stripped)) return { id: question.id, selected: [stripped] }

  // Short-prefix match: "A" / "A." / "a" selects the option labelled
  // "A. …" (labels of the form "<token>. rest" or "<token> rest").
  if (tokens.length === 1) {
    const token = tokens[0].replace(/[.。:：]\s*$/, '')
    const lower = token.toLowerCase()
    if (token.length > 0) {
      const matches = question.options.filter((option) => {
        const label = option.label.trim()
        const labelLower = label.toLowerCase()
        return labelLower === lower
          || labelLower.startsWith(`${lower}.`)
          || labelLower.startsWith(`${lower}。`)
          || labelLower.startsWith(`${lower} `)
      })
      if (matches.length === 1) return { id: question.id, selected: [matches[0].label] }
    }
  }

  // Anything else is a custom free-text answer.
  return { id: question.id, selected: [], custom: trimmed }
}

/** Parse a full QQ text reply against every pending question. */
export function parseAnswerText(
  questions: readonly NormalizedQuestion[],
  text: string,
): readonly QuestionAnswer[] | { error: string } {
  if (questions.length === 1) {
    const parsed = parseOneAnswer(questions[0], text)
    return 'error' in parsed ? { error: parsed.error } : [parsed]
  }
  const lines = text.trim().split(/\r?\n+/)
  if (lines.length !== questions.length) {
    return { error: `共 ${questions.length} 个问题，请按顺序分 ${questions.length} 行回复（每行一个答案）` }
  }
  const answers: QuestionAnswer[] = []
  for (let index = 0; index < questions.length; index += 1) {
    const parsed = parseOneAnswer(questions[index], lines[index])
    if ('error' in parsed) return { error: `第 ${index + 1} 个问题回答无效：${parsed.error}` }
    answers.push(parsed)
  }
  return answers
}

export interface QuestionBridgeDeps {
  readonly config: Config
  readonly api: QQApi
  readonly log: LogSink
  readonly routes: RouteStore
  /**
   * Called immediately before a question is presented on QQ, so buffered
   * assistant text (the model's preamble) can be delivered first and the
   * conversation order stays natural (preamble, then question).
   */
  readonly onPresent?: (sessionId: string) => Promise<void> | void
}

/** Holds per-session pending asks and settles them from QQ traffic. */
export class QuestionBridge {
  /** Pending asks per session, FIFO (parallel tool calls queue up). */
  private readonly queue = new Map<string, PendingAsk[]>()
  /** Token → pending ask for button callbacks. */
  private readonly byToken = new Map<string, PendingAsk>()

  constructor(private readonly deps: QuestionBridgeDeps) {}

  /** Attach the pre-present hook after construction (outbound exists then). */
  attachHooks(hooks: { onPresent?: QuestionBridgeDeps['onPresent'] }): void {
    if (hooks.onPresent !== undefined) {
      ;(this.deps as { onPresent?: QuestionBridgeDeps['onPresent'] }).onPresent = hooks.onPresent
    }
  }

  private targetOf(sessionId: string): ReplyTarget {
    return this.deps.routes.get(sessionId)?.target ?? targetOfSession(sessionId)
  }

  /** Whether the front pending ask for this session qualifies for buttons. */
  private buttonsFor(pending: PendingAsk): { id: string; label: string; visitedLabel: string; style: 0 | 1; data: string }[] {
    if (this.deps.config.questionButtons !== true) return []
    if (pending.questions.length !== 1) return []
    const question = pending.questions[0]
    if (question.multiSelect || question.options.length < 1 || question.options.length > MAX_BUTTONS) return []
    return question.options.map((option, index) => ({
      id: `q${index}`,
      label: option.label.length > 20 ? `${option.label.slice(0, 19)}…` : option.label,
      visitedLabel: '已选择',
      style: 1,
      data: `dshqa:${pending.token}:0:${index}`,
    }))
  }

  /** Present one pending ask on QQ (keyboard when possible, text otherwise). */
  private async present(pending: PendingAsk): Promise<void> {
    // Deliver any debounce-buffered assistant preamble first so it precedes
    // the question in the chat instead of arriving after it.
    try {
      await this.deps.onPresent?.(pending.sessionId)
    } catch {
      // Preamble flush is cosmetic; the question must go out regardless.
    }
    const target = this.targetOf(pending.sessionId)
    const anchor = this.deps.routes.get(pending.sessionId)
    const passive = anchor !== undefined
      ? this.deps.routes.consumePassive(pending.sessionId, 30 * 60 * 1000, 8)
      : undefined
    const buttons = this.buttonsFor(pending)
    const text = renderQuestionText(pending.questions, buttons.length > 0)
    if (buttons.length > 0) {
      try {
        await this.deps.api.sendKeyboard(target, text, buttons, passive)
        return
      } catch (error) {
        // Keyboard delivery failed (permissions, sandbox): fall back to the
        // always-visible plain text so the question still reaches the user.
        this.deps.log.warn('QQ questions: keyboard send failed, falling back to text: %o', error)
      }
    }
    try {
      await this.deps.api.sendText(target, text, passive)
    } catch (error) {
      this.deps.log.warn('QQ question send failed: %o', error)
      this.settle(pending, { kind: 'rejected', error: new Error('问题发送到 QQ 失败') })
    }
  }

  /** Start a pending ask: present it and arm timeout + abort handling. */
  private activate(pending: PendingAsk): void {
    const timeoutMs = this.deps.config.questionTimeoutMs ?? this.deps.config.approvalTimeoutMs ?? 300_000
    pending.timer = setTimeout(() => {
      this.settle(pending, { kind: 'rejected', error: new Error(`等待 QQ 回答超时（${Math.round(timeoutMs / 1000)}s）`) })
    }, timeoutMs)
    if (pending.signal !== undefined) {
      pending.onAbort = () => {
        this.settle(pending, { kind: 'rejected', error: new Error('ask_user_question was aborted before the user answered') })
      }
      pending.signal.addEventListener('abort', pending.onAbort, { once: true })
    }
    void this.present(pending)
  }

  /** Await the QQ user's answer for one `ask_user_question` call. */
  async ask(
    sessionId: string,
    questions: readonly NormalizedQuestion[],
    signal?: AbortSignal,
  ): Promise<readonly QuestionAnswer[]> {
    const token = `${sessionId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const pending: PendingAsk = {
        token,
        sessionId,
        questions,
        resolve,
        reject,
        timer: undefined as unknown as NodeJS.Timeout,
        ...(signal !== undefined ? { signal } : {}),
      }
      const queue = this.queue.get(sessionId) ?? []
      this.queue.set(sessionId, queue)
      queue.push(pending)
      this.byToken.set(token, pending)
      if (queue[0] === pending) this.activate(pending)
    })
  }

  private settle(
    pending: PendingAsk,
    outcome: { kind: 'answered'; answers: readonly QuestionAnswer[] } | { kind: 'rejected'; error: Error },
  ): void {
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    const queue = this.queue.get(pending.sessionId)
    if (queue !== undefined) {
      const next = queue.filter((entry) => entry !== pending)
      if (next.length > 0) this.queue.set(pending.sessionId, next)
      else this.queue.delete(pending.sessionId)
      if (queue[0] === pending && next[0] !== undefined) this.activate(next[0])
    }
    this.byToken.delete(pending.token)
    if (outcome.kind === 'answered') pending.resolve(outcome.answers)
    else pending.reject(outcome.error)
  }

  /**
   * Try to settle the front pending ask from an inbound QQ text message.
   * @returns true when the text was consumed as an answer (or guidance was
   *   sent for an invalid attempt) and must NOT be forwarded to the agent.
   */
  async consumeTextReply(sessionId: string, text: string): Promise<boolean> {
    const pending = this.queue.get(sessionId)?.[0]
    if (pending === undefined) return false
    const parsed = parseAnswerText(pending.questions, text)
    const target = this.targetOf(sessionId)
    if ('error' in parsed) {
      await this.deps.api.sendText(target, `⚠️ 回答未被理解：${parsed.error}\n请重新回复（问题仍在等待你的答案）。`).catch(() => undefined)
      return true
    }
    const summary = parsed
      .map((answer) => `${answer.id}: ${answer.selected.length > 0 ? answer.selected.join('、') : answer.custom ?? ''}`)
      .join('；')
    this.settle(pending, { kind: 'answered', answers: parsed })
    await this.deps.api.sendText(target, `✅ 已收到回答（${summary}），继续处理…`).catch(() => undefined)
    return true
  }

  /** Resolve a pending ask from an INTERACTION_CREATE button press. */
  handleInteraction(buttonData: string): boolean {
    const match = /^dshqa:(.+):(\d+):(\d+)$/.exec(buttonData)
    if (match === null) return false
    const pending = this.byToken.get(match[1])
    if (pending === undefined) return false
    const questionIndex = Number.parseInt(match[2], 10)
    const optionIndex = Number.parseInt(match[3], 10)
    const question = pending.questions[questionIndex]
    if (question === undefined || question.options[optionIndex] === undefined) return false
    const answers = pending.questions.map((entry, index) => index === questionIndex
      ? { id: entry.id, selected: [entry.options[optionIndex].label] }
      : { id: entry.id, selected: [] as string[] })
    this.settle(pending, { kind: 'answered', answers })
    return true
  }

  /** Reject every pending ask for one session (agent disposed / teardown). */
  dispose(sessionId: string): void {
    for (const pending of [...(this.queue.get(sessionId) ?? [])]) {
      this.settle(pending, { kind: 'rejected', error: new Error('QQ 会话已结束，等待中的问题已取消') })
    }
  }

  /** Reject everything; used during plugin teardown. */
  disposeAll(): void {
    for (const sessionId of [...this.queue.keys()]) this.dispose(sessionId)
  }

  /** Log sink accessor for the interceptor-registration diagnostics. */
  get logger(): LogSink {
    return this.deps.log
  }
}

/** Minimal structural view of the `tools/execute` dispatch object we need. */
interface ToolDispatchLike {
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: { readonly id: string }
  readonly signal?: AbortSignal
}

/**
 * Register the per-agent `tools/execute` interceptor: `ask_user_question`
 * calls from this QQ agent are answered over QQ instead of the host's UI
 * provider; every other call (and other agents) flows through untouched.
 */
export function registerAskUserInterceptor(agentCtx: Context, sessionId: string, bridge: QuestionBridge): void {
  const log = bridge.logger
  const onTool = agentCtx.on as unknown as (
    name: 'tools/execute',
    listener: (exec: ToolDispatchLike, next: () => Promise<unknown>) => Promise<unknown>,
  ) => () => void
  bridge.logger.debug?.('QQ questions: interceptor registered for %s', sessionId)
  onTool('tools/execute', async (exec, next) => {
    if (exec.name !== 'ask_user_question') return next()
    if (exec.agent !== undefined && exec.agent.id !== sessionId) return next()
    const questions = normalizeQuestions((exec.arguments as { questions?: unknown } | undefined)?.questions)
    if (questions === undefined) {
      // Malformed arguments never fall through to the host UI provider: that
      // would park the question on a composer this QQ user cannot see.
      const message = 'ask_user_question arguments are invalid (need a non-empty questions array with id and question per entry)'
      log.warn('QQ questions: ask_user_question arguments failed validation for %s; returning error to the model', sessionId)
      return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
    }
    log.info('QQ questions: ask_user_question forwarded to QQ for %s (%d question(s))', sessionId, questions.length)
    try {
      const answers = await bridge.ask(sessionId, questions, exec.signal)
      const value = {
        answers: answers.map((answer) => ({
          id: answer.id,
          selected: [...answer.selected],
          ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
        })),
      }
      return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
    }
  })
}
