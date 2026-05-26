import { randomUUID } from 'crypto';
import type { ToolUseContext } from '../../Tool.js';
import { getSessionId } from '../../utils/ids.js';
import {
  addSessionHook,
  removeSessionHook,
  getSessionHooks,
} from '../../utils/hooks/sessionHooks.js';
import { checkHasTrustDialogAccepted } from '../../utils/config.js';
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from '../../utils/hooks/hooksConfigSnapshot.js';
import {
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../../cost-tracker.js';


const CLEAR_COMMANDS = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
]);

export const OT_LIMIT = 4000;

const TRUST_GATE_MSG =
  '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.';
const HOOKS_GATE_MSG =
  "/goal can't run while hooks are disabled (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).";

export function isClear(condition: string): boolean {
  return CLEAR_COMMANDS.has(condition.toLowerCase());
}

export function getGoalPrompt(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`;
}

export function createGoalAttachment(met: boolean, condition: string) {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    attachment: { type: 'goal_status', met, sentinel: true, condition },
  };
}

function checkGates(): string | null {
  if (
    shouldDisableAllHooksIncludingManaged() ||
    shouldAllowManagedHooksOnly()
  ) {
    return HOOKS_GATE_MSG;
  }
  if (!checkHasTrustDialogAccepted()) {
    return TRUST_GATE_MSG;
  }
  return null;
}

export async function setGoal(
  condition: string,
  context: ToolUseContext,
): Promise<string | null> {
  const gateError = checkGates();
  if (gateError) return gateError;

  const sessionId = getSessionId();
  const setAppState = context.setAppStateForTasks ?? context.setAppState;

  // Remove existing goal hooks
  const existingHooks = getSessionHooks(
    context.getAppState(),
    sessionId,
    'Stop',
  ).get('Stop');
  if (existingHooks) {
    for (const matcher of existingHooks) {
      if (matcher.matcher === '') {
        for (const hook of matcher.hooks) {
          if (hook.type === 'prompt') {
            removeSessionHook(setAppState, sessionId, 'Stop', '', hook);
          }
        }
      }
    }
  }

  // Add new goal hook
  const hook = { type: 'prompt' as const, prompt: condition };
  addSessionHook(setAppState, sessionId, 'Stop', '', hook);

  const currentTokens = getTotalInputTokens() + getTotalOutputTokens();

  const goalState = {
    condition,
    iterations: 0,
    setAt: Date.now(),
    tokensAtStart: currentTokens,
  };

  setAppState(prev => ({
    ...prev,
    // We add it dynamically to the state. TypeScript might complain in some contexts
    // but the runtime will work. In openclaude, we'd ideally update the AppState type.
    activeGoal: goalState,
  } as any));

  if (context.appendSystemMessage) {
    context.appendSystemMessage({
        type: 'attachment',
        // @ts-ignore
        attachment: createGoalAttachment(false, condition).attachment
    });
  }

  return null;
}

export function clearGoal(context: ToolUseContext): string | null {
  const sessionId = getSessionId();
  const setAppState = context.setAppStateForTasks ?? context.setAppState;

  const existingHooks = getSessionHooks(
    context.getAppState(),
    sessionId,
    'Stop',
  ).get('Stop');
  let clearedCondition: string | null = null;

  if (existingHooks) {
    for (const matcher of existingHooks) {
      if (matcher.matcher === '') {
        for (const hook of matcher.hooks) {
          if (hook.type === 'prompt') {
            clearedCondition = hook.prompt;
            removeSessionHook(setAppState, sessionId, 'Stop', '', hook);
          }
        }
      }
    }
  }

  if (clearedCondition === null) return null;

  setAppState(prev => {
    const { activeGoal, ...rest } = prev as any;
    return rest;
  });

  if (context.appendSystemMessage) {
    context.appendSystemMessage({
        type: 'attachment',
        // @ts-ignore
        attachment: createGoalAttachment(true, clearedCondition).attachment
    });
  }

  return clearedCondition;
}
