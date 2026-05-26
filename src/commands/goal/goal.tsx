import * as React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { isClear, clearGoal, setGoal, getGoalPrompt, OT_LIMIT } from './utils.js';
import { GoalComponent } from './GoalComponent.js';

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const condition = args.trim();

  if (condition === '') {
    return (
      <GoalComponent
        messages={context.messages}
        onDone={() => onDone(undefined, { display: 'skip' })}
      />
    );
  }

  if (isClear(condition)) {
    const cleared = clearGoal(context);
    onDone(cleared === null ? 'No goal set' : `Goal cleared: ${cleared}`, {
      display: 'system',
    });
    return null;
  }

  if (condition.length > OT_LIMIT) {
    // $8("goal_set","too_long")
    onDone(
      `Goal condition is limited to ${OT_LIMIT} characters (got ${condition.length})`,
      { display: 'system' },
    );
    return null;
  }

  const error = await setGoal(condition, context);
  if (error !== null) {
    onDone(error, { display: 'system' });
    return null;
  }

  onDone(`Goal set: ${condition}`, {
    shouldQuery: true,
    metaMessages: [getGoalPrompt(condition)],
  });
  return null;
};
