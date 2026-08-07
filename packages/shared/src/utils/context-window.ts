import type { ProviderType } from '../types/channel'

/**
 * 模型上下文窗口推断 — 单一 source of truth。
 *
 * 1M 上下文已随各家模型转正为默认能力；前端推断、后端用量统计和 provider
 * 选择共用同一份判定，避免出现“UI 显示 1M 但实际只 200K”的不一致。
 */

/** 默认上下文窗口（无法识别模型时使用） */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** 1M 上下文窗口 */
export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000

/** ChatGPT Codex 已验证的 GPT-5.x 上下文窗口；第三方同名模型沿用此展示基线。 */
export const CODEX_GPT_54_55_CONTEXT_WINDOW = 272_000
export const CODEX_GPT_54_MINI_CONTEXT_WINDOW = 400_000
export const CODEX_GPT_56_CONTEXT_WINDOW = 372_000

/**
 * 为与 ChatGPT Codex 同名的 GPT-5.x 模型返回统一上下文窗口。
 *
 * 仅覆盖 Codex 已明确标记的模型；Pro/Nano 等未出现在 Codex 目录的变体继续交由
 * provider catalog 决定，避免把不同 SKU 误写成同一窗口。
 */
export function inferCodexAlignedGPT5ContextWindow(modelId: string | undefined): number | undefined {
  const model = modelId?.toLowerCase().replace(/\[1m\]$/i, '')
  switch (model) {
    case 'gpt-5.4-mini': return CODEX_GPT_54_MINI_CONTEXT_WINDOW
    case 'gpt-5.4':
    case 'gpt-5.5': return CODEX_GPT_54_55_CONTEXT_WINDOW
    case 'gpt-5.6':
    case 'gpt-5.6-sol':
    case 'gpt-5.6-terra':
    case 'gpt-5.6-luna': return CODEX_GPT_56_CONTEXT_WINDOW
    default: return undefined
  }
}

const CONTEXT_WINDOW_MODEL_RULES = [
  'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-6',
  'claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5', 'deepseek-v4',
  'glm-5.2', 'mimo-v2.5', 'minimax-m3', 'k3', 'qwen3.8', 'qwen3.7',
  'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3.5-flash',
  'qwen3-coder-plus',
] as const

const EXACT_CONTEXT_RULES = new Set(['k3', 'kimi-k3'])

function matchesContextRule(model: string, pattern: string): boolean {
  if (EXACT_CONTEXT_RULES.has(pattern)) {
    return model === pattern || model.startsWith(`${pattern}[`)
  }
  return model.includes(pattern)
}

/**
 * 上下文窗口配置表。仅影响显示推断的模型加在 rules；模型窗口已确认的模型加在 rules。
 *
 * 匹配规则：modelId.toLowerCase() 包含 pattern 即命中（substring match）。
 * exclude 列表优先级最高：命中 exclude 的模型始终返回 DEFAULT_CONTEXT_WINDOW。
 *
 * 参考：https://docs.anthropic.com/en/docs/build-with-claude/context-windows
 */
const CONTEXT_WINDOW_CONFIG = {
  /** 始终使用默认窗口的模型特征（优先级高于 rules） */
  exclude: ['haiku'],

  /** 1M 上下文模型匹配规则 */
  rules: [
    ...CONTEXT_WINDOW_MODEL_RULES,
    // OpenAI 协议渠道（如 OpenCode Go）使用该真实模型 ID，使用该真实模型 ID。
    'kimi-k3',
    // 已废弃的 MiMo V2 Pro 仅保留历史显示推断，不主动启用 SDK 1M 变体
    'mimo-v2-pro',
  ] as const,
} as const

/**
 * 判断模型是否支持 1M context window（现为各模型默认能力，无需 beta header）。
 */
export function supports1MContext(modelId: string): boolean {
  if (!modelId) return false
  const m = modelId.toLowerCase()
  if (CONTEXT_WINDOW_CONFIG.exclude.some((p) => m.includes(p))) return false
  return CONTEXT_WINDOW_CONFIG.rules.some((p) => matchesContextRule(m, p))
}

/**
 * 按模型名推断 contextWindow（token 数）。
 *
 * SDK 流式过程中不返回此字段，只有 result 消息的 modelUsage 才带（且部分渠道不返回）。
 * 本函数提供一个按模型家族的 fallback，保证进度环永远有分母可用。
 */
export function inferContextWindow(model?: string): number | undefined {
  if (!model) return undefined
  const codexAlignedWindow = inferCodexAlignedGPT5ContextWindow(model)
  if (codexAlignedWindow !== undefined) return codexAlignedWindow
  if (supports1MContext(model)) return ONE_MILLION_CONTEXT_WINDOW
  return DEFAULT_CONTEXT_WINDOW
}

/** 按 provider/model 推断实际上下文窗口；不生成或改写模型 ID。 */
export function inferProviderContextWindow(modelId: string | undefined, _provider: ProviderType): number | undefined {
  return inferContextWindow(modelId)
}
