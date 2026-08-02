import { beforeAll, describe, expect, mock, test } from 'bun:test'

// 注意：mock.module 是进程级全局替换，且不会随本文件结束自动还原。
// 全量 bun test 跑在同一进程内，若这里只导出测试用到的少数函数，
// 会让其它测试文件 import 真实模块时也拿到这个残缺的假模块，
// 报出 "Export named 'xxx' not found" 或 "xxx is not a function"。
// 因此必须 spread 真实模块的全部导出，只覆盖需要 stub 的函数。
const actualUserProfileService = await import('./user-profile-service')
const actualAgentWorkspaceManager = await import('./agent-workspace-manager')
const actualConfigPaths = await import('./config-paths')
const actualSettingsService = await import('./settings-service')

mock.module('./user-profile-service', () => ({
  ...actualUserProfileService,
  getUserProfile: () => ({ userName: '测试用户' }),
}))

mock.module('./agent-workspace-manager', () => ({
  ...actualAgentWorkspaceManager,
  getAgentWorkspaceBySlug: () => undefined,
  getProjectFilesPath: () => '/tmp/sample-project',
  getWorkspaceMcpConfig: () => ({ servers: {} }),
}))

mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getConfigDirName: () => '.proma',
}))

mock.module('./settings-service', () => ({
  ...actualSettingsService,
  getSettings: () => ({}),
}))

let buildSystemPrompt: typeof import('./agent-prompt-builder').buildSystemPrompt
let buildDynamicContext: typeof import('./agent-prompt-builder').buildDynamicContext

beforeAll(async () => {
  ({ buildSystemPrompt, buildDynamicContext } = await import('./agent-prompt-builder'))
})

function buildPrompt(agentCwd: string): string {
  return buildSystemPrompt({
    agentRuntime: 'pi',
    workspaceName: '示例项目',
    workspaceSlug: 'sample-project',
    sessionId: 'session-1',
    agentCwd,
    permissionMode: 'bypassPermissions',
  })
}

describe('项目与会话工作台提示词', () => {
  test('Given 项目根 cwd When 构建提示词 Then 标明会话直接在项目中工作', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('## 项目')
    expect(prompt).toContain('项目名称: 示例项目')
    expect(prompt).toContain('当前会话直接在项目根目录中工作')
    expect(prompt).not.toContain('项目根始终是 cwd')
  })

  test('Given 历史会话工作台 cwd When 构建提示词 Then 不将它误称为项目根', () => {
    const prompt = buildPrompt('/tmp/.proma/agent-workspaces/sample-project/session-1')

    expect(prompt).toContain('当前会话仍使用私有会话工作台，不等同于项目根目录')
    expect(prompt).toContain('项目根与 cwd 不一定相同')
  })

  test('Given 项目动态上下文 When 构建消息前缀 Then 使用项目标签', () => {
    const context = buildDynamicContext({
      workspaceName: '示例项目',
      workspaceSlug: 'sample-project',
      agentCwd: '/tmp/sample-project',
    })

    expect(context).toContain('项目: 示例项目')
    expect(context).not.toContain('工作区: 示例项目')
  })
})
