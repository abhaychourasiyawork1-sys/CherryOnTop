import { describe, expect, it } from 'vitest';
import { createDb } from './db/client.js';
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  archiveWorkspace,
} from './repository.js';
import {
  createProject,
  getProject,
  listProjects,
} from '../projects/repository.js';
import {
  createConversation,
  getConversation,
  listConversations,
} from '../conversations/repository.js';
import {
  createRun,
  getRun,
  listRuns,
} from '../runs/repository.js';

describe('Desktop 2.0 domain foundation', () => {
  it('persists and lists workspaces while preserving archive state', () => {
    const db = createDb(':memory:');
    const created = createWorkspace(db, {
      id: 'ws-1',
      name: 'Engineering',
      description: 'Engineering workspace',
      settings: {},
      now: '2026-09-27T00:00:00.000Z',
    });

    expect(created.name).toBe('Engineering');
    expect(getWorkspace(db, 'ws-1')?.status).toBe('ACTIVE');
    expect(listWorkspaces(db)).toHaveLength(1);

    archiveWorkspace(db, 'ws-1', '2026-09-27T01:00:00.000Z');
    expect(getWorkspace(db, 'ws-1')?.status).toBe('ARCHIVED');
  });

  it('scopes projects to a workspace and preserves stable identifiers', () => {
    const db = createDb(':memory:');
    createWorkspace(db, {
      id: 'ws-1',
      name: 'Engineering',
      description: '',
      settings: {},
      now: '2026-09-27T00:00:00.000Z',
    });

    const project = createProject(db, {
      id: 'project-1',
      workspaceId: 'ws-1',
      name: 'CherryOnTop',
      description: 'Runtime',
      settings: {},
      now: '2026-09-27T00:00:00.000Z',
    });

    expect(project.workspaceId).toBe('ws-1');
    expect(getProject(db, 'project-1')?.id).toBe('project-1');
    expect(listProjects(db, 'ws-1')).toHaveLength(1);
  });

  it('keeps conversations ordered by updated time within a project', () => {
    const db = createDb(':memory:');
    createWorkspace(db, {
      id: 'ws-1',
      name: 'Engineering',
      description: '',
      settings: {},
      now: '2026-09-27T00:00:00.000Z',
    });
    createProject(db, {
      id: 'project-1',
      workspaceId: 'ws-1',
      name: 'CherryOnTop',
      description: '',
      settings: {},
      now: '2026-09-27T00:00:00.000Z',
    });

    createConversation(db, {
      id: 'chat-old',
      workspaceId: 'ws-1',
      projectId: 'project-1',
      title: 'Older',
      now: '2026-09-27T01:00:00.000Z',
    });
    createConversation(db, {
      id: 'chat-new',
      workspaceId: 'ws-1',
      projectId: 'project-1',
      title: 'Newer',
      now: '2026-09-27T02:00:00.000Z',
    });

    expect(listConversations(db, 'project-1').map((chat) => chat.id))
      .toEqual(['chat-new', 'chat-old']);
    expect(getConversation(db, 'chat-new')?.title).toBe('Newer');
  });

  it('links each run to its conversation and existing root case/node', () => {
    const db = createDb(':memory:');
    createWorkspace(db, {
      id: 'ws-1',
      name: 'Engineering',
      description: '',
      settings: {},
      now: '2026-09-27T00:00:00.000Z',
    });
    createProject(db, {
      id: 'project-1',
      workspaceId: 'ws-1',
      name: 'CherryOnTop',
      description: '',
      settings: {},
      now: '2026-09-27T00:00:00.000Z',
    });
    createConversation(db, {
      id: 'chat-1',
      workspaceId: 'ws-1',
      projectId: 'project-1',
      title: 'Investigate',
      now: '2026-09-27T00:00:00.000Z',
    });

    const run = createRun(db, {
      id: 'run-1',
      conversationId: 'chat-1',
      caseId: 'node-root-1',
      goal: 'Investigate benchmark regression',
      mandateSnapshot: { authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 } },
      now: '2026-09-27T00:00:00.000Z',
    });

    expect(run.status).toBe('RUNNING');
    expect(getRun(db, 'run-1')?.caseId).toBe('node-root-1');
    expect(listRuns(db, 'chat-1')).toHaveLength(1);
  });
});
