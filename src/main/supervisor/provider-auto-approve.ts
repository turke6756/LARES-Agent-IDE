import type { AgentProvider } from '../../shared/types';

/** Provider-native interactive approval bypasses. These are launch flags rather
 * than settings mutations so provider deny hooks/rules remain authoritative. */
const AUTO_APPROVE_FLAG: Partial<Record<AgentProvider, string>> = {
  grok: '--always-approve',
  agy: '--dangerously-skip-permissions',
};

export function addProviderAutoApproveFlag(provider: AgentProvider, args: string[]): string[] {
  const flag = AUTO_APPROVE_FLAG[provider];
  if (flag && !args.includes(flag)) args.push(flag);
  return args;
}
