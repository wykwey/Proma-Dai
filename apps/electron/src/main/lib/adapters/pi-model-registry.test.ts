import { describe, expect, test } from 'bun:test'

import * as sdk from '@earendil-works/pi-coding-agent'
import { getModels } from '@earendil-works/pi-ai/compat'

import { buildModel, shouldInheritCatalogCompat, usesUserSuppliedEndpoint } from './pi-model-registry'

type CatalogEntry = { api?: string; baseUrl?: string }

/**
 * catalog compat 继承门控。
 *
 * 规则：catalog 的 compat 只对它自己声明的 transport 与端点成立，
 * 所以要求渠道的 api 与端点都跟 catalog 条目一致。
 *
 * 背景：Proma 通用 buildModel 会按模型 ID 去 Pi catalog 兜底找条目，
 * 中转/自定义渠道因此可能匹配到第一方条目。实测 geek2api：
 * 继承 `supportsMidConvoEffort` 后 pi-ai 会把 role:"system" 插进 messages[] 中间，
 * 中转站直接 400（消息角色无效: messages[1].role=system）；不继承则 200 正常。
 */
describe('shouldInheritCatalogCompat', () => {
  const anthropicEntry: CatalogEntry = {
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
  }

  test('Given 端点与 transport 都跟 catalog 一致 When 判定继承 Then 允许', () => {
    expect(shouldInheritCatalogCompat('anthropic', anthropicEntry, 'https://api.anthropic.com')).toBe(true)
    // 端点比较只看 host，忽略路径差异
    expect(shouldInheritCatalogCompat('anthropic', anthropicEntry, 'https://api.anthropic.com/v1/messages')).toBe(true)
    expect(shouldInheritCatalogCompat('minimax', {
      api: 'anthropic-messages', baseUrl: 'https://api.minimaxi.com/anthropic',
    }, 'https://api.minimaxi.com/anthropic')).toBe(true)
    expect(shouldInheritCatalogCompat('google', {
      api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com',
    }, 'https://generativelanguage.googleapis.com')).toBe(true)
    expect(shouldInheritCatalogCompat('openai-responses', {
      api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
    }, 'https://api.openai.com/v1')).toBe(true)
    expect(shouldInheritCatalogCompat('kimi-coding', {
      api: 'anthropic-messages', baseUrl: 'https://api.kimi.com/coding/v1',
    }, 'https://api.kimi.com/coding/v1')).toBe(true)
  })

  test('Given 渠道指向中转站 When 端点与 catalog 不同 Then 拒绝继承', () => {
    // 实测 geek2api：继承后会 400，不继承才正常
    expect(shouldInheritCatalogCompat('anthropic', anthropicEntry, 'https://www.geek2api.com')).toBe(false)
    expect(shouldInheritCatalogCompat('anthropic', anthropicEntry, 'https://relay.example.com')).toBe(false)
    expect(shouldInheritCatalogCompat('custom', anthropicEntry, 'https://relay.example.com')).toBe(false)
    expect(shouldInheritCatalogCompat('anthropic-compatible', anthropicEntry, 'https://relay.example.com')).toBe(false)
    // 子域不同也算不同端点
    expect(shouldInheritCatalogCompat('anthropic', anthropicEntry, 'https://api.anthropic.com.evil.test')).toBe(false)
  })

  test('Given 端点相同但 transport 不同 When 判定继承 Then 拒绝', () => {
    // anthropic 协议但别的家族的网关：家族不同 → 端点也不同
    expect(shouldInheritCatalogCompat('deepseek', anthropicEntry, 'https://api.deepseek.com/anthropic')).toBe(false)
    expect(shouldInheritCatalogCompat('kimi-api', anthropicEntry, 'https://api.moonshot.cn/anthropic')).toBe(false)
    expect(shouldInheritCatalogCompat('zhipu-coding', anthropicEntry, 'https://open.bigmodel.cn/api/anthropic')).toBe(false)
    expect(shouldInheritCatalogCompat('qwen-anthropic', anthropicEntry, 'https://dashscope.aliyuncs.com/apps/anthropic')).toBe(false)
    // 同 host 但 catalog 是 openai-completions，渠道是 anthropic-messages
    expect(shouldInheritCatalogCompat('kimi-api', {
      api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1',
    }, 'https://api.moonshot.cn/anthropic')).toBe(false)
    // openai 渠道走 openai-completions，而 openai 目录是 openai-responses
    expect(shouldInheritCatalogCompat('openai', {
      api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
    }, 'https://api.openai.com/v1')).toBe(false)
  })

  test('Given 未命中任何 catalog 条目或有字段缺失 When 判定继承 Then 拒绝', () => {
    expect(shouldInheritCatalogCompat('anthropic', undefined, 'https://api.anthropic.com')).toBe(false)
    expect(shouldInheritCatalogCompat('custom', undefined, undefined)).toBe(false)
    expect(shouldInheritCatalogCompat('anthropic', { api: 'anthropic-messages' }, 'https://api.anthropic.com')).toBe(false)
    expect(shouldInheritCatalogCompat('anthropic', { baseUrl: 'https://api.anthropic.com' }, undefined)).toBe(false)
  })
})

/**
 * 自配端点判定。
 *
 * pi 默认 `supportsFinishReason: true`，含义是“provider 必须给 finish_reason，
 * 缺失即视为流被截断并报错”。实测 geek2api 中转站的流式响应在 pi 侧拿不到
 * finish_reason（直接 curl 能看到，但 SDK 请求形态下没有），于是报
 * `Stream ended without finish_reason`；置 false 后正常。
 */
describe('usesUserSuppliedEndpoint', () => {
  test('Given 没有官方端点的渠道 When 判定 Then 视为自配', () => {
    expect(usesUserSuppliedEndpoint('custom', 'https://relay.example.com')).toBe(true)
    expect(usesUserSuppliedEndpoint('custom', undefined)).toBe(true)
    expect(usesUserSuppliedEndpoint('anthropic-compatible', 'https://relay.example.com')).toBe(true)
  })

  test('Given 官方端点 When 判定 Then 不算自配', () => {
    expect(usesUserSuppliedEndpoint('anthropic', 'https://api.anthropic.com')).toBe(false)
    expect(usesUserSuppliedEndpoint('openai', 'https://api.openai.com/v1')).toBe(false)
    expect(usesUserSuppliedEndpoint('deepseek', 'https://api.deepseek.com/anthropic')).toBe(false)
    expect(usesUserSuppliedEndpoint('kimi-api', 'https://api.moonshot.cn/anthropic')).toBe(false)
  })

  test('Given 官方渠道被指向第三方端点 When 判定 Then 视为自配', () => {
    // 实测 geek2api
    expect(usesUserSuppliedEndpoint('anthropic', 'https://www.geek2api.com')).toBe(true)
    expect(usesUserSuppliedEndpoint('openai', 'https://www.geek2api.com')).toBe(true)
    // 子域不同也算不同端点
    expect(usesUserSuppliedEndpoint('anthropic', 'https://api.anthropic.com.evil.test')).toBe(true)
  })
})

/**
 * 字段对齐护栏。
 *
 * `buildModel` 是逐字段把 catalog 条目搬进注册的模型对象的——历史上
 * `compat`（后含 `supportsMidConvoEffort`）就是在这道搬运里被漏掉的。
 * 与其“以 catalog 为底 spread”（会把 github-copilot / nvidia 条目里的
 * `headers` 也带进来），不如用这个测试卡住：**catalog 新增字段时会红**。
 */
describe('catalog 字段对齐', () => {
  // Proma 有意覆盖、允许与 catalog 不同的字段
  const ownedByProma = new Set(['id', 'name', 'api', 'baseUrl', 'provider'])
  // 运行时自行注入、不在 catalog 里的字段
  const injectedByRuntime = new Set(['headers'])

  test('Given 第一方 anthropic 渠道 When 构建模型 Then catalog 每个字段都被处理', async () => {
    const catalog = getModels('anthropic').find((m) => m.id === 'claude-opus-5')
    expect(catalog).toBeDefined()

    const built = await buildModel(sdk, {
      provider: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com', sessionId: 'parity',
      permissionMode: 'default', systemPrompt: '',
      piAgentDir: '/tmp/probe-agent', piSessionDir: '/tmp/probe-session',
    } as never)
    const model = built.model as unknown as Record<string, unknown>

    const catalogRecord = catalog as unknown as Record<string, unknown>

    for (const [key, value] of Object.entries(catalogRecord)) {
      if (ownedByProma.has(key)) continue
      // catalog 新增字段而 buildModel 没搬时，这里会红
      expect({ [key]: model[key] }).toEqual({ [key]: value })
    }

    const unexpected = Object.keys(model).filter(
      (key) => !(key in catalogRecord) && !injectedByRuntime.has(key),
    )
    expect(unexpected).toEqual([])
  })
})
