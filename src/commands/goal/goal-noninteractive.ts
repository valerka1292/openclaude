import type { LocalCommandCall } from '../../types/command.js';
import { isClear, clearGoal, setGoal, OT_LIMIT } from './utils.js';
import { plural, firstLineOf } from '../../utils/stringUtils.js';

export const call: LocalCommandCall = async (args, context) => {
  const condition = args.trim();
  const appState = context.getAppState() as any;

  if (condition === '') {
    const activeGoal = appState.activeGoal;
    if (!activeGoal) {
      return { type: 'text', value: 'No goal set. Usage: `/goal <condition>`' };
    }
    const iterations =
      activeGoal.iterations === 0
        ? 'not yet evaluated'
        : `${activeGoal.iterations} ${plural(activeGoal.iterations, 'turn')}`;
    const lastReason = activeGoal.lastReason
      ? `\nLast check: ${firstLineOf(activeGoal.lastReason.trim())}`
      : '';
    return {
      type: 'text',
      value: `Goal active: ${activeGoal.condition} (${iterations})${lastReason}`,
    };
  }

  if (isClear(condition)) {
    const cleared = clearGoal(context);
    return {
      type: 'text',
      value: cleared === null ? 'No goal set' : `Goal cleared: ${cleared}`,
    };
  }

  if (condition.length > OT_LIMIT) {
    return {
      type: 'text',
      value: `Goal condition is limited to ${OT_LIMIT} characters (got ${condition.length})`,
    };
  }

  const error = await setGoal(condition, context);
  if (error !== null) {
    return { type: 'text', value: error };
  }

  return {
    type: 'query',
    value: `Goal set: ${condition}`,
    prompt: `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`,
  };
};
