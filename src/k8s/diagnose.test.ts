import { describe, it, expect } from 'vitest';
import { diagnosePod } from './client.js';
import type { V1Pod } from '@kubernetes/client-node';

const pod = (status: V1Pod['status']): V1Pod => ({ status });

describe('diagnosePod', () => {
  it('reports a missing sandbox image instead of waiting it out', () => {
    const trouble = diagnosePod(pod({
      containerStatuses: [{
        name: 'runner', image: 'cherryontop-runner:local', imageID: '',
        ready: false, restartCount: 0,
        state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image' } },
      }],
    }))!;
    expect(trouble.reason).toBe('ImagePullBackOff');
    expect(trouble.message).toContain('image is missing from the cluster');
  });

  it('reports a pod nothing can schedule, with the scheduler’s reason', () => {
    const trouble = diagnosePod(pod({
      conditions: [{
        type: 'PodScheduled', status: 'False',
        reason: 'Unschedulable', message: '0/1 nodes are available: insufficient memory',
      }],
    }))!;
    expect(trouble.reason).toBe('Unschedulable');
    expect(trouble.message).toContain('insufficient memory');
  });

  it('stays silent while a pod is legitimately still starting', () => {
    // ContainerCreating and PodInitializing are the normal path. Treating them
    // as failure would abort every healthy run in its first second.
    expect(diagnosePod(pod({
      containerStatuses: [{
        name: 'runner', image: 'x', imageID: '', ready: false, restartCount: 0,
        state: { waiting: { reason: 'ContainerCreating' } },
      }],
    }))).toBeNull();
    expect(diagnosePod(pod({ phase: 'Pending' }))).toBeNull();
  });

  it('stays silent for a running pod, and for a pod with no status yet', () => {
    expect(diagnosePod(pod({
      containerStatuses: [{
        name: 'runner', image: 'x', imageID: '', ready: true, restartCount: 0,
        state: { running: { startedAt: new Date(0) } },
      }],
    }))).toBeNull();
    expect(diagnosePod({})).toBeNull();
  });

  it('reports a scheduling problem ahead of a container one', () => {
    // An unschedulable pod has no container to diagnose; the scheduler's reason
    // is the real one.
    const trouble = diagnosePod(pod({
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'no nodes' }],
      containerStatuses: [{
        name: 'runner', image: 'x', imageID: '', ready: false, restartCount: 0,
        state: { waiting: { reason: 'ImagePullBackOff' } },
      }],
    }))!;
    expect(trouble.reason).toBe('Unschedulable');
  });
});
