import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { NodeContract } from '../schemas/node-contract.js';
import type { Commitment } from '../schemas/commitment.js';
import type { Decision } from '../schemas/decision.js';

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  goal: text('goal').notNull(),
  contract: text('contract', { mode: 'json' }).$type<NodeContract>().notNull(),
  state: text('state').notNull(),
  repoPath: text('repo_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('node_id').notNull(),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const commitments = sqliteTable('commitments', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  data: text('data', { mode: 'json' }).$type<Commitment>().notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  data: text('data', { mode: 'json' }).$type<Decision>().notNull(),
  createdAt: text('created_at').notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});
