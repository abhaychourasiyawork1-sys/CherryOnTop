import type { NodeContract, Authority } from '../schemas/node-contract.js';
import { isRestricted, isReadOnly } from './enforce-tools.js';

export interface AuthorityEnvelope {
  /** One sentence per permission, in the order a person cares about them:
   *  how big the organization can get, how much it can spend, what it can touch. */
  permits: string[];
  /** What makes it stop and come back to you. The half nobody else shows. */
  stops: string[];
  /** Told to the agent but not enforced by the platform. Kept separate on
   *  purpose — rendering a soft instruction next to a hard boundary in the same
   *  weight is how an authority model starts overstating itself. */
  advisory: string[];
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function toolPhrase(authority: Authority): string {
  if (!isRestricted(authority)) return 'Use any tool its runtime offers (no tool restriction set)';
  const names = authority.tools.join(', ');
  return isReadOnly(authority)
    ? `Read only — ${names}. It cannot change a file or run a command`
    : `Use ${names}, and nothing else`;
}

/**
 * What a contract permits, in words, before anything runs.
 *
 * Pure by design: no model call, no database, no execution. The whole point is
 * that you can be told the blast radius for free, before you spend anything —
 * so this must never become something that costs money to ask.
 */
export function simulateAuthority(contract: Pick<NodeContract, 'authority' | 'constraints' | 'deadline'>): AuthorityEnvelope {
  const { authority } = contract;

  const permits: string[] = [];
  permits.push(
    authority.spawn_children && authority.max_child_count > 0
      ? `Build an organization of up to ${authority.max_child_count} agent${authority.max_child_count === 1 ? '' : 's'}`
      : 'Work alone — it cannot delegate to another agent',
  );
  permits.push(`Spend up to ${money(authority.budget_usd)} in total`);
  permits.push(toolPhrase(authority));
  permits.push('Reach the network only over HTTPS, and never a private or cloud-metadata address');

  const stops: string[] = [];
  stops.push(`Needing more than ${money(authority.budget_usd)}`);
  if (authority.spawn_children && authority.max_child_count > 0) {
    stops.push(`Needing an agent beyond its ${authority.max_child_count}`);
  }
  if (isRestricted(authority)) stops.push('Reaching for a tool outside its grant');
  if (contract.deadline?.hard_at) stops.push(`Still running at ${contract.deadline.hard_at.slice(0, 16).replace('T', ' ')}`);

  return {
    permits,
    stops,
    advisory: [...(contract.constraints ?? [])],
  };
}

/** The one-line version, for the composer. Long enough to be honest, short
 *  enough that someone actually reads it before pressing Start. */
export function summarizeAuthority(contract: Pick<NodeContract, 'authority' | 'constraints' | 'deadline'>): string {
  const { authority } = contract;
  const size = authority.spawn_children && authority.max_child_count > 0
    ? `up to ${authority.max_child_count + 1} agents`
    : '1 agent';
  const tools = !isRestricted(authority) ? 'any tool'
    : isReadOnly(authority) ? 'read-only tools'
    : `${authority.tools.length} tools`;
  return `${size} · ${money(authority.budget_usd)} ceiling · ${tools} · stops and asks you at the edge`;
}
