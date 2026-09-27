import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertNode } from '../../db/queries/nodes.js';

const TEST_DB = './test-desktop-foundation-router.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

async function getTrpc(app: ReturnType<typeof buildServer>, path: string, input: unknown) {
  const response = await app.inject({
    method: 'GET',
    url: '/trpc/' + path + '?input=' + encodeURIComponent(JSON.stringify(input)),
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body).result.data;
}

async function postTrpc(app: ReturnType<typeof buildServer>, path: string, input: unknown) {
  const response = await app.inject({
    method: 'POST',
    url: '/trpc/' + path,
    payload: input as Record<string, unknown>,
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body).result.data;
}

describe('Desktop 2.0 foundation routers', () => {
  it('creates and lists a workspace', async () => {
    const app = buildServer(TEST_DB, () => {});
    const created = await postTrpc(app, 'workspace.create', {
      name: 'Engineering', description: 'Engineering', settings: {},
    });
    expect(created.name).toBe('Engineering');
    expect((await postTrpc(app, 'workspace.list', {}))[0].name).toBe('Engineering');
  });

  it('scopes project creation to an existing workspace', async () => {
    const app = buildServer(TEST_DB, () => {});
    const workspace = await getTrpc(app, 'workspace.create', { name: 'Engineering', description: '', settings: {} });
    const project = await postTrpc(app, 'project.create', {
      workspaceId: workspace.id, name: 'CherryOnTop', description: '', settings: {},
    });
    expect(project.workspaceId).toBe(workspace.id);
    expect((await postTrpc(app, 'project.list', { workspaceId: workspace.id }))[0].id).toBe(project.id);
  });

  it('creates conversations and lists them by project', async () => {
    const app = buildServer(TEST_DB, () => {});
    const workspace = await getTrpc(app, 'workspace.create', { name: 'Engineering', description: '', settings: {} });
    const project = await postTrpc(app, 'project.create', { workspaceId: workspace.id, name: 'CherryOnTop', description: '', settings: {} });
    const chat = await postTrpc(app, 'conversation.create', {
      workspaceId: workspace.id, projectId: project.id, title: 'Investigate regression',
    });
    expect((await postTrpc(app, 'conversation.list', { projectId: project.id }))[0].id).toBe(chat.id);
  });

  it('links a product run to an existing root case/node', async () => {
    const app = buildServer(TEST_DB, () => {});
    const workspace = await getTrpc(app, 'workspace.create', { name: 'Engineering', description: '', settings: {} });
    const project = await postTrpc(app, 'project.create', { workspaceId: workspace.id, name: 'CherryOnTop', description: '', settings: {} });
    const chat = await postTrpc(app, 'conversation.create', { workspaceId: workspace.id, projectId: project.id, title: 'Investigate regression' });
    const db = createDb(TEST_DB);
    insertNode(db, {
      id: 'root-node-1', parentId: null, goal: 'Investigate benchmark regression', state: 'CREATED',
      contract: { goal: 'Investigate benchmark regression', definition_of_done: ['done'],
        authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] },
      repoPath: null, runtime: null, mandateId: null, replayOf: null, snapshot: null,
      createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
    });
    const run = await postTrpc(app, 'run.create', {
      conversationId: chat.id, caseId: 'root-node-1', goal: 'Investigate benchmark regression', mandateSnapshot: {},
    });
    expect(run.conversationId).toBe(chat.id);
    expect(run.caseId).toBe('root-node-1');
    expect((await getTrpc(app, 'run.list', { conversationId: chat.id }))[0].id).toBe(run.id);
  });
});