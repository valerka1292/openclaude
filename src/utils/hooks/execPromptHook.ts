import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { safeParseJSON } from '../json.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import type { PromptHook } from '../settings/types.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { addArgumentsToPrompt, hookResponseSchema } from './hookHelpers.js'

/**
 * Execute a prompt-based hook using an LLM
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // Use provided toolUseID or generate a new one
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  try {
    // Replace $ARGUMENTS with the JSON input
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(
      `Hooks: Processing prompt hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })

    // Prepend conversation history if provided
    let messagesToQuery =
      messages && messages.length > 0
        ? [...messages, userMessage]
        : [userMessage]

    // Smart truncation logic using Recursive Dependency Sweep (RDS) / original jAA logic
    const model = hook.model ?? getSmallFastModel()
    const isSonnet = model.includes('sonnet') || model.includes('opus')
    const maxTokensLimit = isSonnet ? 1000000 : 50000 // n56 / 50k tokens for other models (like haiku)
    const fAA = 0.7 // 70% budget
    const targetTokenBudget = Math.floor(maxTokensLimit * fAA)

    function getUsageTokens(msgs: Message[]): number {
      let total = 0
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.type === 'assistant' && msg.message && 'usage' in msg.message) {
          const usage = (msg.message as any).usage
          if (usage && msg.message.model !== 'opus') {
            return (usage.input_tokens || 0) +
                   (usage.cache_creation_input_tokens || 0) +
                   (usage.cache_read_input_tokens || 0) +
                   (usage.output_tokens || 0)
          }
        }
      }
      return 0
    }

    function estimateTokens(msgs: Message[]): number {
      let sum = 0
      for (const msg of msgs) {
        if (msg.type === 'assistant' || msg.type === 'user') {
          const content = msg.message?.content
          if (typeof content === 'string') {
            sum += Math.ceil(content.length / 4)
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
                sum += Math.ceil(block.text.length / 4)
              } else {
                sum += Math.ceil(JSON.stringify(block).length / 4)
              }
            }
          }
        }
      }
      return sum
    }

    function groupMessagesByAssistantId(msgs: Message[]): Message[][] {
      const groups: Message[][] = []
      let currentGroup: Message[] = []
      let lastAssistantId: string | undefined

      for (const msg of msgs) {
        if (msg.type === 'assistant' && msg.message && msg.message.id !== lastAssistantId && currentGroup.length > 0) {
          groups.push(currentGroup)
          currentGroup = [msg]
        } else {
          currentGroup.push(msg)
        }
        if (msg.type === 'assistant' && msg.message) {
          lastAssistantId = msg.message.id
        }
      }
      if (currentGroup.length > 0) {
        groups.push(currentGroup)
      }
      return groups
    }

    if (getUsageTokens(messagesToQuery) > targetTokenBudget) {
      const groups = groupMessagesByAssistantId(messagesToQuery)
      let currentGroupTokens = 0
      let sliceStart = groups.length

      for (let i = groups.length - 1; i >= 0; i--) {
        const groupTokens = estimateTokens(groups[i])
        if (sliceStart < groups.length && currentGroupTokens + groupTokens > targetTokenBudget) {
          break
        }
        currentGroupTokens += groupTokens
        sliceStart = i
      }

      const keptMessages = groups.slice(sliceStart).flat()
      const droppedCount = messagesToQuery.length - keptMessages.length
      if (droppedCount > 0) {
        logForDebugging(
          `Hooks: truncated Stop transcript ${messagesToQuery.length}→${keptMessages.length} msgs (budget ${targetTokenBudget}, model ${model})`
        )
        const truncationWarningMsg = createUserMessage({
          content: `[Earlier conversation truncated to fit the hook evaluator's context window — ${droppedCount} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`
        })
        messagesToQuery = [truncationWarningMsg, ...keptMessages]
      }
    }

    logForDebugging(
      `Hooks: Querying model with ${messagesToQuery.length} messages`,
    )

    // Query the model with Haiku
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000

    // Combined signal: aborts if either the hook signal or timeout triggers
    const { signal: combinedSignal, cleanup: cleanupSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })

    try {
      const isStopHook = hookEvent === 'Stop' || hookEvent === 'SubagentStop'
      const stopHookSystemPrompt = `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

You are co-authoring this with the assistant — collaborative and helpful, like a teammate who's done this before and is happy to share.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<reason the condition is met>"}
- {"ok": false, "reason": "<reason the condition is not met>"}

Always include a "reason" field.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

      const defaultSystemPrompt = `You are evaluating a hook in Claude Code.

Your response must be a JSON object matching one of the following schemas:
1. If the condition is met, return: {"ok": true, "reason": "..."}
2. If the condition is not met, return: {"ok": false, "reason": "...", "impossible": boolean}`

      const response = await queryModelWithoutStreaming({
        messages: messagesToQuery,
        systemPrompt: asSystemPrompt([
          isStopHook ? stopHookSystemPrompt : defaultSystemPrompt,
        ]),
        thinkingConfig: { type: 'disabled' as const },
        tools: toolUseContext.options.tools,
        signal: combinedSignal,
        options: {
          async getToolPermissionContext() {
            const appState = toolUseContext.getAppState()
            return appState.toolPermissionContext
          },
          model: hook.model ?? getSmallFastModel(),
          toolChoice: undefined,
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          agents: [],
          querySource: 'hook_prompt',
          mcpTools: [],
          agentId: toolUseContext.agentId,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
                impossible: { type: 'boolean' },
              },
              required: ['ok', 'reason'],
              additionalProperties: false,
            },
          },
        },
      })

      cleanupSignal()

      // Extract text content from response
      const content = extractTextContent(response.message.content)

      // Update response length for spinner display
      toolUseContext.setResponseLength(length => length + content.length)

      const fullResponse = content.trim()
      logForDebugging(`Hooks: Model response: ${fullResponse}`)

      const json = safeParseJSON(fullResponse)
      if (!json) {
        logForDebugging(
          `Hooks: error parsing response as JSON: ${fullResponse}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      // Failed to meet condition
      if (!parsed.data.ok) {
        if (parsed.data.impossible === true && isStopHook) {
          logForDebugging(
            `Hooks: Prompt hook condition judged impossible: ${parsed.data.reason}`,
          )
          return {
            hook,
            outcome: 'success',
            impossible: true,
            stopReason: parsed.data.reason,
            message: createAttachmentMessage({
              type: 'hook_success',
              hookName,
              toolUseID: effectiveToolUseID,
              hookEvent,
              content: '',
            }),
          }
        }

        logForDebugging(
          `Hooks: Prompt hook condition was not met: ${parsed.data.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Prompt hook condition was not met: ${parsed.data.reason}`,
            command: hook.prompt,
          },
          preventContinuation: true,
          stopReason: parsed.data.reason,
        }
      }

      // Condition was met
      logForDebugging(`Hooks: Prompt hook condition was met`)
      return {
        hook,
        outcome: 'success',
        stopReason: parsed.data.reason,
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}
