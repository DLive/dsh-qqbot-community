/**
 * Plugin configuration schema. Kept apart from `index.ts` so the composition
 * root reads as wiring, not declarations.
 */
import Schema from '@deepseek-ai/schemastery'
import { type Config as ConfigType } from './types.js'

/** Default QQ gateway intents: public channel messages + group/C2C + interactions + DMs. */
export const DEFAULT_INTENTS = (1 << 30) + (1 << 25) + (1 << 26) + (1 << 12)

export interface Config extends ConfigType {}

export const Config = Schema.object({
  id: Schema.string().required().description('QQ 机器人 AppID'),
  secret: Schema.string().required().description('QQ 机器人 AppSecret'),
  sandbox: Schema.boolean().default(true).description('是否使用 QQ 沙箱环境'),
  endpoint: Schema.string().default('https://api.sgroup.qq.com').description('QQ OpenAPI 接入点'),
  intents: Schema.number().default(DEFAULT_INTENTS).description('网关事件订阅掩码'),
  provider: Schema.string().default('DeepSeek').description('新建 QQ 会话默认 AI 提供方'),
  model: Schema.string().default('DeepSeek-V4-Flash').description('新建 QQ 会话默认模型'),
  cwd: Schema.string().description('新建 QQ 会话的绝对工作目录'),
  debug: Schema.boolean().default(false).description('调试日志'),
  allowFrom: Schema.array(Schema.string()).default(['*']).description("C2C 发送者 openid 白名单（'*' 通配，留空放行）"),
  groupAllowFrom: Schema.array(Schema.string()).default(['*']).description('群 openid 白名单'),
  markdown: Schema.boolean().default(false).description('以 markdown (msg_type 2) 发送回复，需开通权限'),
  textChunkLimit: Schema.number().default(4000).description('单条静态回复的最大字符数'),
  typing: Schema.boolean().default(true).description('C2C 输入中指示（60s 窗口自动续发）'),
  streaming: Schema.boolean().default(true).description('C2C 流式回复（stream_messages 替换模式）'),
  streamThrottleMs: Schema.number().default(1200).description('流式帧最小间隔（毫秒）'),
  deliverWindowMs: Schema.number().default(900).description('同一轮内多条文本回复的合并窗口（毫秒）'),
  deliverMaxWaitMs: Schema.number().default(6000).description('合并回复的最大等待（毫秒）'),
  replyPassiveLimit: Schema.number().default(4).description('每条入站消息允许的被动回复次数'),
  mediaDownload: Schema.boolean().default(true).description('下载非图片入站附件到 <cwd>/.qq-media/'),
  stt: Schema.object({
    baseUrl: Schema.string().default('https://api.openai.com/v1').description('OpenAI 兼容 STT base URL'),
    apiKey: Schema.string().description('STT API key（缺失时该配置整体视为未启用）'),
    model: Schema.string().default('whisper-1').description('STT 模型'),
  }).description('语音转文字配置（未配置时使用 QQ 自带 ASR 或占位文本）'),
  approval: Schema.boolean().default(true).description('为 QQ 会话注册内联键盘审批 answerer'),
  approvalTimeoutMs: Schema.number().default(300000).description('审批按钮等待超时（毫秒）'),
  slashCommands: Schema.boolean().default(true).description('启用 /help /ping /me /approve /always 命令'),
})