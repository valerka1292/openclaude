import { getIsNonInteractiveSession } from '../../bootstrap/state.js';
import type { Command } from '../../commands.js';
import { checkHasTrustDialogAccepted } from '../../utils/config.js';

export const goal: Command = {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set a goal — keep working until the condition is met',
  argumentHint: '[<condition> | clear]',
  immediate: true,
  isEnabled: () => !getIsNonInteractiveSession() && checkHasTrustDialogAccepted(),
  load: () => import('./goal.js'),
};

export const goalNonInteractive: Command = {
  type: 'local',
  name: 'goal',
  supportsNonInteractive: true,
  thinClientDispatch: 'post-text',
  description: 'Set a goal — keep working until the condition is met',
  argumentHint: '[<condition> | clear]',
  get isHidden() {
    return !getIsNonInteractiveSession();
  },
  isEnabled() {
    return getIsNonInteractiveSession() && checkHasTrustDialogAccepted();
  },
  load: () => import('./goal-noninteractive.js'),
};

export default goal;
