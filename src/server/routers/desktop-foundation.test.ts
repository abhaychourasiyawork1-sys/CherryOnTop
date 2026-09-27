import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';

const TEST_DB = './test-desktop-foundation-router.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

async function trpc(app: ReturnType<typeof buildServer>, path: string, input: unknown, method: 'GET' | 'POST' = 'GET') {
  const encoded = encodeURIComponent(JSON.stringify(input));
  const response = await app.inject({
    method,
    url: '/trpc/' + path + '?input=' + encoded,
    payload: method === 'POST' ? input : undefined,
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body).result.data;
}

describe('Desktop 2.0 foundation routers', () => {
  it('creates and lists a workspace', async () => {
    const app = buildServer(TEST_DB, () => {});
    const created = await trpc(app, 'workspace.create', {
      name: 'Engineering', description: 'Engineering', settings: {},
    }, 'POST');
    expect(created.name).toBe('Engineering');
    expect((await trpc(app, 'workspace.list', {}))[0].name).toBe('Engineering');
  });

  it('scopes project creation to an existing workspace', async () => {
    const app = buildServer(TEST_DB, () => {});
    const workspace = await trpc(app, 'workspace.create', { name: 'Engineering', description: '', settings: {} }, 'POST');
    const project = await trpc(app, 'project.create', {
      workspaceId: workspace.id, name: 'CherryOnTop', description: '', settings: {},
    }, 'POST');
    expect(project.workspaceId).toBe(workspace.id);
    expect((await trpc(app, 'project.list', { workspaceId: workspace.id }))[0].id).toBe(project.id);
  });

  it('creates conversations and lists them by project', async () => {
    const app = buildServer(TEST_DB, () => {});
    const workspace = await trpc(app, 'workspace.create', { name: 'Engineering', description: '', settings: {} }, 'POST');
    const project = await trpc(app, 'project.create', { workspaceId: workspace.id, name: 'CherryOnTop', description: '', settings: {} }, 'POST');
    const chat = await trpc(app, 'conversation.create', {
      workspaceId: workspace.id, projectId: project.id, title: 'Investigate regression',
    }, 'POST');
    expect((await trpc(app, 'conversation.list', { projectId: project.id }))[0].id).toBe(chat.id);
  });

  it('links a product run to an existing root case/node', async () => {
    const app = buildServer(TEST_DB, () => {});
    const workspace = await trpc(app, 'workspace.create', { name: 'Engineering', description: '', settings: {} }, 'POST');
    const project = await trpc(app, 'project.create', { workspaceId: workspace.id, name: 'CherryOnTop', description: '', settings: {} }, 'POST');
    const chat = await trpc(app, 'conversation.create', { workspaceId: workspace.id, projectId: project.id, title: 'Investigate regression' }, 'POST');
    const run = await trpc(app, 'run.create', {
      conversationId: chat.id, caseId: 'root-node-1', goal: 'Investigate benchmark regression', mandateSnapshot: {},
    }, 'POST');
    expect(run.conversationId).toBe(chat.id);
    expect(run.caseId).toBe('root-node-1');
    expect((await trpc(app, 'run.list', { conversationId: chat.id }))[0].id).toBe(run.id);
  });
});