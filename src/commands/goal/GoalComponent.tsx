import * as React from 'react';
import { Box, Text, useInterval, useInput } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import { formatDuration, formatTokens } from '../../utils/format.js';
import { plural, firstLineOf } from '../../utils/stringUtils.js';
import {
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../../cost-tracker.js';
import { findGoalInHistory } from '../../utils/messages.js';
import type { Message } from '../../types/message.js';

type Props = {
  messages: Message[];
  onDone: () => void;
};

export function GoalComponent({ messages, onDone }: Props) {
  const activeGoal = useAppState(s => (s as any).activeGoal);
  const [, setTick] = React.useState(0);

  useInterval(() => setTick(t => t + 1), activeGoal ? 1000 : null);

  useInput((input, key) => {
    if (key.escape || key.return || input === 'q') {
      onDone();
    }
  });

  if (activeGoal) {
    const duration = Date.now() - activeGoal.setAt;
    const currentTokens = getTotalInputTokens() + getTotalOutputTokens();
    const tokens = currentTokens - (activeGoal.tokensAtStart ?? 0);
    const subtitle = [
      `running ${formatDuration(duration)}`,
      activeGoal.iterations > 0 &&
        `${activeGoal.iterations} ${plural(activeGoal.iterations, 'turn')}`,
      `${formatTokens(tokens)} tokens`,
    ]
      .filter(Boolean)
      .join(' · ');

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
        <Box flexDirection="row" gap={1}>
          <Text bold color="cyan">
            Goal active
          </Text>
          <Text dimColor>{subtitle}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row">
            <Box flexShrink={0}>
              <Text dimColor>Goal: </Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="wrap">{activeGoal.condition}</Text>
            </Box>
          </Box>
          {activeGoal.lastReason && (
            <Box flexDirection="row">
              <Box flexShrink={0}>
                <Text dimColor>Last check: </Text>
              </Box>
              <Box flexGrow={1}>
                <Text wrap="wrap">{firstLineOf(activeGoal.lastReason.trim())}</Text>
              </Box>
            </Box>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>/goal clear to stop early</Text>
        </Box>
      </Box>
    );
  }

  const metGoal = findGoalInHistory(messages);
  if (metGoal) {
    const subtitle = [
      metGoal.durationMs !== undefined && formatDuration(metGoal.durationMs),
      metGoal.iterations !== undefined &&
        `${metGoal.iterations} ${plural(metGoal.iterations, 'turn')}`,
      metGoal.tokens !== undefined && `${formatTokens(metGoal.tokens)} tokens`,
    ]
      .filter(Boolean)
      .join(' · ');

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="green"
        paddingX={1}
      >
        <Box flexDirection="row" gap={1}>
          <Text bold color="green">
            Goal achieved
          </Text>
          <Text dimColor>{subtitle}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row">
            <Box flexShrink={0}>
              <Text dimColor>Goal: </Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="wrap">{metGoal.condition}</Text>
            </Box>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>/goal {'<condition>'} to set another</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Goal</Text>
      <Text dimColor>No goal set</Text>
      <Text dimColor>Use /goal {'<condition>'} to set one</Text>
    </Box>
  );
}
