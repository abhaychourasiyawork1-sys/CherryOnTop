import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { daemon } from './lib/client.js';
import { useOrg } from './lib/useOrg.js';
import { useDaemonQuery } from './lib/useDaemonQuery.js';
import { subtreeOf } from './lib/tasks.js';
import { REPO } from './lib/bridge.js';
import { toWorkspaces, workspaceKeyOf, workspaceNameOf, workspaceState, type Workspace } from './lib/workspaces.js';
import { homeModel } from './lib/home.js';
import { groupAttention, attentionCount, scopeAttention } from './lib/attention.js';
import { lastSeen, markSeen, localKey } from './lib/sync.js';
import { applyTheme } from './lib/theme.js';
import { SettingsDialog } from './navigation/SettingsDialog.js';
import { useLocalState } from './lib/useLocalState.js';
import { useLayout } from './lib/useLayout.js';
import { caseStamp } from './lib/useCase.js';
import { openSession, parentOf, SECTION_LABEL, type Section, type View } from './lib/view.js';
import { sessionsByWorkspace, sessionTitle, type Session } from './lib/sessions.js';
import { titleOf, phaseOf, isLive } from './lib/run.js';
import { missingRouters, outOfDateMessage } from './lib/compat.js';
import { goalWithContext, redirectGoal, type ContextRef } from './composer/ContextResolver.js';
import { displayPath } from './lib/artifacts.js';
import type { SearchItem } from './lib/search.js';
import type { Mandate } from './lib/mandates.js';
import { Sidebar, type WorkspaceGroup } from './navigation/Sidebar.js';
import { Home } from './navigation/Home.js';
import { WorkspacePicker } from './navigation/WorkspacePicker.js';
import { CommandPalette } from './navigation/CommandPalette.js';
import { WorkspaceHeader } from './shell/WorkspaceHeader.js';
import { SessionHeader, type SessionTool } from './shell/SessionHeader.js';
import { MandatesPage } from './panels/Mandates.js';
import { AdaptiveWorkspace } from './shell/AdaptiveWorkspace.js';
import { OrganizationView } from './shell/OrganizationView.js';
import { WorkspaceContext, type WorkspaceApi } from './shell/WorkspaceContext.js';
import { ErrorBoundary } from './shell/ErrorBoundary.js';
import { Composer, compose } from './panels/Composer.js';
import { Thread } from './surfaces/Thread.js';
import { AttentionSurface, useAttention } from './surfaces/AttentionSurface.js';
import type { AskExchange, AskResult } from './panels/Conversation.js';

const WINDOW_KEY = REPO.container ? workspaceKeyOf(REPO.container) : null;

type ResolvedRepo = { ok: true; hostPath: string; containerPath: string } | { ok: false; error: string };

/** Asks the daemon whether work can run in a Workspace or folder. A daemon
 *  from before this call existed can still vouch for the launch folder. */
async function resolveRepo(path: string): Promise<ResolvedRepo> {
  try {
    return await daemon().daemon.resolveRepo.query({ path }) as ResolvedRepo;
  } catch {
    if (REPO.container && workspaceKeyOf(path) === WINDOW_KEY) return { ok: true, hostPath: REPO.path ?? '', containerPath: REPO.container };
    return { ok: false, error: 'The daemon is older than this window and can only start work in the launch folder. Restart it with `org daemon stop` then `org daemon start`.' };
  }
}

function emptyWorkspace(key: string): Workspace {
  return { key, name: workspaceNameOf(key), cases: [], lastActivity: '', running: 0, needsYou: 0, organized: false };
}

function decodeKeys(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** The composition root: live runtime state in, Workspace projection out.
 *  Everything durable comes from the daemon through `useOrg`; everything in
 *  this component that is not from there is presentation state. */
export function App() {
  const org = useOrg();
  // Offline only once a read has actually failed; before the first answer the
  // window is syncing, not offline.
  const offline = !org.connected && org.error !== null;
  // Folders opened from the Workspace picker that have no runs yet still count
  // as Workspaces — so do the launch folder's — or they could not be chosen.
  const [recentKeys, setRecentKeys] = useLocalState<string[]>(localKey('draft', 'recent-workspaces'), decodeKeys);
  const sessions = useDaemonQuery<Session[]>(() => daemon().session.list.query() as Promise<Session[]>, [org.revision]);
  const sessionList = useMemo(() => sessions.data ?? [], [sessions.data]);
  const workspaces = useMemo(() => {
    const known = toWorkspaces(org.nodes);
    const sessionKeys = sessionList.map((s) => workspaceKeyOf(s.repoPath));
    const extra = [...new Set([...sessionKeys, WINDOW_KEY, ...recentKeys].filter((k): k is string => Boolean(k)))]
      .filter((key) => !known.some((ws) => ws.key === key))
      .map((key) => emptyWorkspace(key));
    return [...known, ...extra];
  }, [org.nodes, recentKeys, sessionList]);
  const byKey = useMemo(() => new Map(workspaces.map((ws) => [ws.key, ws])), [workspaces]);

  // Home is the entry point: it is where you see what to continue and choose
  // where new work goes. The launch folder is preselected there.
  const [view, setView] = useState<View>({ name: 'home' });
  const history = useRef<View[]>([]);
  const navigate = useCallback((next: View) => {
    setView((current) => {
      if (JSON.stringify(current) !== JSON.stringify(next)) history.current = [...history.current.slice(-20), current];
      return next;
    });
  }, []);

  const [collapsed, setCollapsed] = useLocalState<boolean>(localKey('sidebar'), (raw) => raw === 'true', String);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settings, setSettings] = useState<'settings' | 'shortcuts' | null>(null);
  const [notifyOnFinish, setNotifyOnFinish] = useLocalState<boolean>(localKey('draft', 'notify-finish'), (raw) => raw !== 'false', String);
  const [exchanges, setExchanges] = useState<AskExchange[]>([]);

  // "While you were away" is measured from when the window was last hidden.
  const [seenAt] = useState(lastSeen);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') markSeen(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('beforeunload', () => markSeen());
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);

  const mandates = useDaemonQuery<Mandate[]>(() => daemon().mandate.list.query() as Promise<Mandate[]>, [org.revision]);
  const [mandateId, setMandateId] = useLocalState<string | null>(localKey('draft', 'mandate'), (raw) => raw, (v) => v ?? '');
  useEffect(() => {
    const list = mandates.data ?? [];
    if (list.length === 0 || list.some((m) => m.id === mandateId)) return;
    setMandateId(list.find((m) => m.id === 'builtin-focused-change')?.id ?? list[0].id);
  }, [mandates.data, mandateId, setMandateId]);

  // Native notification when something starts waiting on a person.
  const notified = useRef(new Set<string>());
  useEffect(() => {
    for (const approval of org.approvals) {
      if (notified.current.has(approval.id)) continue;
      notified.current.add(approval.id);
      window.mission?.notifyApprovalPending(approval.reason);
    }
  }, [org.approvals]);

  // Like any chat app: when work finishes while you are elsewhere, say so.
  const settled = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const roots = org.nodes.filter((node) => !node.parentId);
    const previous = settled.current;
    settled.current = new Map(roots.map((root) => [root.id, root.state]));
    if (!previous || !org.authoritative || !notifyOnFinish) return;
    if (document.hasFocus() && document.visibilityState === 'visible') return;
    for (const root of roots) {
      const before = previous.get(root.id);
      if (!before || before === root.state || !['COMPLETE', 'FAILED', 'CANCELLED'].includes(root.state)) continue;
      window.mission?.notify?.(
        root.state === 'COMPLETE' ? 'Work finished' : 'Work did not finish',
        titleOf(root.goal),
      );
    }
  }, [org.nodes, org.authoritative, notifyOnFinish]);

  const attentionQuery = useAttention(org.revision);
  const allAttention = attentionQuery.data ?? [];
  const globalAttention = attentionCount(groupAttention(allAttention));

  // ---- the Workspace in view --------------------------------------------
  const wsKey = view.name === 'workspace' ? view.key : WINDOW_KEY ?? workspaces[0]?.key ?? null;
  const workspace: Workspace | null = wsKey
    ? byKey.get(wsKey) ?? emptyWorkspace(wsKey)
    : null;
  const surfaces = useLayout(workspace?.key ?? null);

  // ---- the session in view -----------------------------------------------
  const grouped = useMemo(() => sessionsByWorkspace(sessionList, org.nodes), [sessionList, org.nodes]);
  const sessionId = view.name === 'workspace' ? view.sessionId : null;
  const session = sessionId ? sessionList.find((s) => s.id === sessionId) ?? null : null;
  const sessionRow = workspace && sessionId ? grouped.get(workspace.key)?.find((r) => r.id === sessionId) ?? null : null;
  const threadCaseIds = useMemo(() => sessionRow?.runIds ?? [], [sessionRow]);
  // The session seen as a Workspace of its own: every surface that reads
  // "this Workspace's runs" then reads only this session's, by construction.
  const scoped: Workspace | null = useMemo(() => {
    if (!workspace) return null;
    const ids = new Set(threadCaseIds);
    const rootOf = new Map<string, string>();
    const byId = new Map(org.nodes.map((n) => [n.id, n]));
    const top = (id: string): string => {
      const known = rootOf.get(id);
      if (known) return known;
      const node = byId.get(id);
      const root = node?.parentId && byId.has(node.parentId) ? top(node.parentId) : id;
      rootOf.set(id, root);
      return root;
    };
    const own = org.nodes.filter((n) => ids.has(top(n.id)));
    return toWorkspaces(own).find((ws) => ws.key === workspace.key) ?? { ...emptyWorkspace(workspace.key), name: workspace.name };
  }, [workspace, threadCaseIds, org.nodes]);
  const allCaseIds = useMemo(() => scoped?.cases.map((c) => c.id) ?? [], [scoped]);

  const activeCaseId = view.name === 'workspace' && view.caseId && allCaseIds.includes(view.caseId)
    ? view.caseId
    : allCaseIds[0] ?? null;
  const activeCase = activeCaseId ? org.nodes.find((n) => n.id === activeCaseId) ?? null : null;
  const activeSubtree = useMemo(() => (activeCase ? subtreeOf(org.nodes, activeCase.id) : []), [org.nodes, activeCase]);
  const liveCase = useMemo(
    () => scoped?.cases.find((c) => isLive(phaseOf(c, subtreeOf(org.nodes, c.id)))) ?? null,
    [scoped, org.nodes],
  );

  const groups = useMemo<WorkspaceGroup[]>(() => {
    const keys = [...new Set([...grouped.keys(), ...(workspace && view.name === 'workspace' ? [workspace.key] : [])])];
    return keys
      .map((key) => ({ key, name: byKey.get(key)?.name ?? workspaceNameOf(key), sessions: grouped.get(key) ?? [] }))
      .sort((a, b) => (b.sessions[0]?.updatedAt ?? '').localeCompare(a.sessions[0]?.updatedAt ?? ''));
  }, [grouped, byKey, workspace, view.name]);

  const scopedAttention = useMemo(() => scopeAttention(allAttention, new Set(allCaseIds)), [allAttention, allCaseIds]);
  const wsAttention = attentionCount(groupAttention(scopedAttention));

  // Where new work goes: the Workspace you are in, or — on Home — the one
  // chosen in the composer. The daemon decides whether it can run there.
  const [homeKey, setHomeKey] = useLocalState<string | null>(localKey('draft', 'home-workspace'), (raw) => raw || null, (v) => v ?? '');
  // This session's pick wins; otherwise the folder `org gui` was run from;
  // otherwise the last pick (a window opened outside any repository).
  const [homeChoice, setHomeChoice] = useState<string | null>(null);
  const homeTarget = homeChoice ?? WINDOW_KEY ?? homeKey ?? workspaces[0]?.key ?? null;
  const chooseHome = (key: string) => { setHomeChoice(key); setHomeKey(key); };
  const targetKey = view.name === 'workspace' ? view.key : homeTarget;
  const target = useDaemonQuery<ResolvedRepo | null>(
    () => (targetKey ? resolveRepo(targetKey) : Promise.resolve(null)),
    [targetKey],
  );
  const blockedReason = !targetKey
    ? 'Choose a Workspace for this work.'
    : target.loading && !target.data ? 'Checking this Workspace…'
      : target.data && !target.data.ok ? target.data.error
        : null;

  const focusCase = useCallback((caseId: string) => {
    const root = org.nodes.find((n) => n.id === caseId);
    const key = workspaceKeyOf(root?.repoPath);
    setView((current) => {
      const here = current.name === 'workspace';
      const same = here && root?.sessionId === current.sessionId;
      return {
        name: 'workspace',
        key: root ? key : here ? current.key : key,
        sessionId: root ? root.sessionId ?? null : here ? current.sessionId : null,
        section: same && here ? current.section : 'chat',
        caseId,
        nodeId: null,
      };
    });
  }, [org.nodes]);

  const startWork = useCallback(async (goal: string) => {
    const resolved = target.data;
    if (!resolved || !resolved.ok) throw new Error(blockedReason ?? 'This Workspace cannot take new work.');
    const key = workspaceKeyOf(resolved.containerPath);
    // The first message of a session creates it, named after that message.
    const inSession = view.name === 'workspace' && view.key === key ? view.sessionId : null;
    const sid = inSession ?? ((await daemon().session.create.mutate({ repoPath: resolved.containerPath, title: sessionTitle(goal) })) as { id: string }).id;
    const created = await daemon().node.create.mutate({
      goal,
      definition_of_done: [goal],
      // The contract requires authority; the daemon replaces it with the
      // mandate's own, so the two can never disagree.
      authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 5 },
      constraints: [],
      mandateId,
      repoPath: resolved.containerPath,
      sessionId: sid,
    });
    const id = (created as { id: string }).id;
    org.refresh();
    sessions.reload();
    setView({ name: 'workspace', key, sessionId: sid, section: 'chat', caseId: id, nodeId: null });
    return id;
  }, [mandateId, org, sessions, target.data, blockedReason, view]);

  const renameSession = async (id: string, title: string) => {
    await daemon().session.rename.mutate({ id, title });
    sessions.reload();
  };
  const deleteSession = async (id: string) => {
    await daemon().session.delete.mutate({ id });
    sessions.reload();
    if (sessionId === id) navigate({ name: 'home' });
  };
  /** A new session: in a Workspace, an empty chat there; otherwise Home,
   *  where the Workspace is chosen as you type. */
  const newSession = (key: string | null) => {
    if (key) navigate(openSession(key, null));
    else navigate({ name: 'home' });
    setTimeout(() => compose(''), 0);
  };

  /** A folder picked on Home: the daemon checks it; if usable it becomes a
   *  Workspace (remembered even before it has runs) and the target. */
  const openFolder = async (hostPath: string): Promise<string | null> => {
    const resolved = await resolveRepo(hostPath);
    if (!resolved.ok) return resolved.error;
    const key = workspaceKeyOf(resolved.containerPath);
    setRecentKeys((keys) => [key, ...keys.filter((k) => k !== key)].slice(0, 12));
    chooseHome(key);
    return null;
  };

  const contextRefs = useMemo<ContextRef[]>(() => {
    const refs: ContextRef[] = surfaces.layout.side
      .filter((s) => s.kind === 'artifact' && s.contextId)
      .map((s) => ({ kind: 'file', id: s.contextId!, label: displayPath(s.contextId!) }));
    if (activeCase) refs.push({ kind: 'run', id: activeCase.id, label: `Run: ${titleOf(activeCase.goal)}` });
    return refs;
  }, [surfaces.layout.side, activeCase]);

  const openSection = useCallback((section: Section, nodeId: string | null = null) => {
    surfaces.closeDeepDive();
    if (!workspace) return;
    navigate({ name: 'workspace', key: workspace.key, sessionId, section, caseId: activeCase?.id ?? null, nodeId });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.key, sessionId, activeCase?.id, navigate]);

  const api: WorkspaceApi | null = workspace && scoped ? {
    org, workspace: scoped, session, activeCase, activeSubtree, activeStamp: caseStamp(activeSubtree),
    focusCase, openSection, surfaces, blockedReason,
    mandates: mandates.data ?? [], mandateId, setMandateId,
    startWork,
    resolveApproval: async (approvalId, decision) => {
      await daemon().node.resolveApproval.mutate({ approvalId, decision });
      org.refresh();
      attentionQuery.reload();
    },
    resume: async (nodeId) => {
      await daemon().node.resume.mutate({ nodeId });
      org.refresh();
    },
    detach: window.mission?.openDetached ? (target) => void window.mission!.openDetached!(target) : undefined,
    contextRefs,
    openMandates: (id = null) => navigate({ name: 'mandates', id }),
  } : null;

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((v) => !v); }
      if (mod && event.key === '\\') { event.preventDefault(); setCollapsed((v) => !v); }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); newSession(workspace && view.name === 'workspace' ? workspace.key : null); }
      if (mod && event.key === ',') { event.preventDefault(); setSettings('settings'); }
      if (mod && event.key === '/') { event.preventDefault(); setSettings('shortcuts'); }
      // Layout is UI state, so it gets ordinary undo.
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'z' && !editing) {
        if (surfaces.undo()) event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- palette ------------------------------------------------------------
  const paletteItems = useMemo<SearchItem[]>(() => {
    const items: SearchItem[] = [
      ...(workspace ? [
        { id: 'go-plan', kind: 'action' as const, title: 'Show the plan', keywords: 'plan steps' },
        { id: 'go-files', kind: 'action' as const, title: 'Show changed files', keywords: 'files changes diff' },
        { id: 'go-memory', kind: 'action' as const, title: 'Show what this session remembers', keywords: 'memory' },
        { id: 'go-activity', kind: 'action' as const, title: 'Show the history of this run', keywords: 'activity timeline story details' },
        { id: 'go-authority', kind: 'action' as const, title: 'Review Workspace authority', keywords: 'mandate permissions authority' },
        { id: 'reset-layout', kind: 'action' as const, title: 'Reset the layout', keywords: 'surfaces panels clean' },
      ] : []),
      { id: 'new-work', kind: 'action', title: 'New session', keywords: 'new chat start task work' },
      { id: 'open-mandates', kind: 'action', title: 'Mandates', keywords: 'authority permissions tools budget edit create' },
      { id: 'go-home', kind: 'action', title: 'Go Home' },
      { id: 'open-settings', kind: 'action', title: 'Settings', keywords: 'preferences appearance theme notifications' },
      { id: 'open-shortcuts', kind: 'action', title: 'Keyboard shortcuts', keywords: 'keys help' },
      { id: 'toggle-sidebar', kind: 'action', title: collapsed ? 'Expand the sidebar' : 'Collapse the sidebar' },
      { id: 'toggle-theme', kind: 'action', title: document.documentElement.dataset.theme === 'light' ? 'Use the dark theme' : 'Use the light theme', keywords: 'theme appearance' },
      ...workspaces.map((ws) => ({ id: ws.key, kind: 'workspace' as const, title: ws.name, subtitle: ws.running ? 'Working' : undefined, workspaceKey: ws.key })),
    ];
    // Sessions are what you search for; each is found by any message in it.
    const goals = new Map(org.nodes.filter((n) => !n.parentId && n.sessionId).map((n) => [n.id, n.goal]));
    for (const [key, rows] of grouped) {
      for (const row of rows) {
        items.push({
          id: row.id, kind: 'run', title: row.title, subtitle: byKey.get(key)?.name ?? workspaceNameOf(key), workspaceKey: key,
          keywords: row.runIds.map((id) => goals.get(id) ?? '').join(' ').slice(0, 600),
        });
      }
    }
    return items;
  }, [workspaces, workspace, collapsed, grouped, byKey, org.nodes]);

  const chooseFromPalette = (item: SearchItem) => {
    switch (item.kind) {
      case 'workspace': navigate(openSession(item.id, grouped.get(item.id)?.[0]?.id ?? null)); return;
      case 'run': navigate(openSession(item.workspaceKey ?? '', item.id)); return;
      default: break;
    }
    if (item.id === 'go-home') navigate({ name: 'home' });
    if (item.id === 'toggle-sidebar') setCollapsed((v) => !v);
    if (item.id === 'reset-layout') surfaces.reset();
    if (item.id === 'toggle-theme') applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    if (item.id === 'new-work') newSession(workspace && view.name === 'workspace' ? workspace.key : null);
    if (item.id === 'open-mandates') navigate({ name: 'mandates', id: null });
    if (item.id === 'open-settings') setSettings('settings');
    if (item.id === 'open-shortcuts') setSettings('shortcuts');
    if (item.id === 'go-plan') surfaces.open('plan', activeCase?.id ?? null);
    if (item.id === 'go-files') surfaces.open('files');
    if (item.id === 'go-memory') surfaces.open('memory');
    if (item.id === 'go-activity') surfaces.open('activity', activeCase?.id ?? null);
    if (item.id === 'go-authority') openSection('authority');
  };

  // ---- composer handlers ---------------------------------------------------
  const ask = async (text: string) => {
    const result = await daemon().org.ask.query({ question: text, focusedNodeId: activeCase?.id });
    setExchanges((current) => [...current, { key: `${Date.now()}-${current.length}`, question: text, result: result as AskResult, caseId: activeCase?.id ?? null, sessionId }]);
  };
  const work = async (text: string, refs: ContextRef[]) => { await startWork(goalWithContext(text, refs)); };
  const redirect = async (text: string, refs: ContextRef[]) => {
    if (!liveCase) { await work(text, refs); return; }
    await daemon().node.cancelCase.mutate({ id: liveCase.id });
    await startWork(redirectGoal(text, { id: liveCase.id, title: titleOf(liveCase.goal) }, refs));
  };

  const composer = (variant: 'hero' | 'docked') => (
    <Composer
      variant={variant}
      hasCase={variant === 'docked' && activeCase !== null}
      liveRun={variant === 'docked' && liveCase ? { id: liveCase.id, title: titleOf(liveCase.goal) } : null}
      suggestions={variant === 'docked' ? contextRefs : []}
      mandates={mandates.data ?? []}
      mandateId={mandateId}
      onSelectMandate={setMandateId}
      onAuthority={() => navigate({ name: 'mandates', id: mandateId })}
      onStop={variant === 'docked' && liveCase ? async () => {
        await daemon().node.cancelCase.mutate({ id: liveCase.id });
        org.refresh();
      } : undefined}
      blockedReason={blockedReason}
      leading={variant === 'hero' ? (
        <WorkspacePicker
          workspaces={workspaces}
          selected={homeTarget ? byKey.get(homeTarget) ?? emptyWorkspace(homeTarget) : null}
          status={target.loading && !target.data ? 'checking' : target.data?.ok ? 'ready' : 'unusable'}
          onSelect={chooseHome}
          onOpenFolder={openFolder}
        />
      ) : undefined}
      offline={offline}
      draftScope={variant === 'hero' ? 'home' : `${workspace?.key ?? ''}:${sessionId ?? 'new'}`}
      autoFocus={variant === 'hero' || threadCaseIds.length === 0}
      onQuestion={ask}
      onWork={work}
      onRedirect={redirect}
    />
  );

  // ---- render -------------------------------------------------------------
  const stale = org.connected ? missingRouters(org.routers) : [];
  const section = view.name === 'workspace' ? view.section : null;
  const openKinds = new Set(surfaces.layout.side.filter((s) => !s.collapsed).map((s) => s.kind));
  const onTool = (tool: SessionTool) => {
    if (!workspace) return;
    if (view.name !== 'workspace' || view.section !== 'chat') navigate({ name: 'workspace', key: workspace.key, sessionId, section: 'chat', caseId: activeCase?.id ?? null, nodeId: null });
    surfaces.closeDeepDive();
    const existing = surfaces.layout.side.find((s) => s.kind === tool && !s.collapsed);
    if (existing) surfaces.close(existing.id);
    else surfaces.open(tool, tool === 'plan' ? activeCase?.id ?? null : null);
  };

  const attentionSurface = (
    <AttentionSurface
      items={view.name === 'home' ? allAttention : scopedAttention}
      onOpen={(caseId, nodeId) => { focusCase(caseId); if (nodeId && nodeId !== caseId) openSection('agents', nodeId); }}
      onChanged={() => { attentionQuery.reload(); org.refresh(); }}
    />
  );

  const state = workspaceState(scoped, { connected: !offline, authoritative: org.authoritative });

  const openLatest = (key: string) => navigate(openSession(key, grouped.get(key)?.[0]?.id ?? null));
  const homeHeader = (title: string) => (
    <WorkspaceHeader backLabel={null} onBack={() => {}} title={title} state={workspaceState(null, { connected: !offline, authoritative: org.authoritative })} cachedAt={org.cachedAt} />
  );

  const main = view.name === 'mandates' ? (
    <>
      {homeHeader('Mandates')}
      <div className="main-scroll">
        <ErrorBoundary what="Mandates">
          <MandatesPage
            selectedId={view.id}
            onSelect={(id) => setView({ name: 'mandates', id })}
            defaultId={mandateId}
            onMakeDefault={setMandateId}
            onChanged={() => { mandates.reload(); org.refresh(); }}
          />
        </ErrorBoundary>
      </div>
    </>
  ) : view.name === 'home' || !workspace || !api || !scoped ? (
    <>
      {homeHeader('Home')}
      <div className="main-scroll">
        <Home
          model={homeModel(workspaces, seenAt, globalAttention)}
          attention={globalAttention}
          composer={composer('hero')}
          onOpenWorkspace={(key, caseId) => (caseId ? focusCase(caseId) : openLatest(key))}
          onAttention={() => { if (WINDOW_KEY || workspaces[0]) openLatest(WINDOW_KEY ?? workspaces[0].key); setTimeout(() => surfaces.open('attention'), 0); }}
        />
      </div>
    </>
  ) : (
    <WorkspaceContext.Provider value={api}>
      <SessionHeader
        workspaceName={workspace.name}
        workspaceKey={workspace.key}
        title={session?.title ?? null}
        onRename={session ? (title) => renameSession(session.id, title) : undefined}
        section={section ?? 'chat'}
        onSection={(next) => (next === 'chat' ? navigate(parentOf(view)) : openSection(next))}
        open={{ files: openKinds.has('files'), plan: openKinds.has('plan'), memory: openKinds.has('memory') }}
        onTool={onTool}
        state={state}
        onState={state === 'attention' || wsAttention > 0 ? () => surfaces.open('attention') : undefined}
      />
      {section === 'chat' ? (
        <AdaptiveWorkspace attention={attentionSurface}>
          <div className="chat">
            <ErrorBoundary what="The conversation" key={`${workspace.key}:${sessionId ?? 'new'}`}>
              <Thread
                caseIds={threadCaseIds}
                exchanges={exchanges.filter((e) => e.sessionId === sessionId)}
                empty={(
                  <div className="chat-empty">
                    <h2 className="chat-empty-title">What should CherryOnTop do in {workspace.name}?</h2>
                    <p className="chat-empty-note">
                      Describe the outcome you want. Every message you send here continues this session: CherryOnTop remembers what was asked and answered earlier, so you can just say “now add tests” or “undo that”.
                    </p>
                  </div>
                )}
              />
            </ErrorBoundary>
            <div className="chat-composer">{composer('docked')}</div>
          </div>
        </AdaptiveWorkspace>
      ) : (
        <div className="main-scroll">
          <ErrorBoundary what={SECTION_LABEL[section!]} key={section!}>
            <OrganizationView section={section!} nodeId={view.name === 'workspace' ? view.nodeId : null} />
          </ErrorBoundary>
        </div>
      )}
    </WorkspaceContext.Provider>
  );

  return (
    <div className="desktop" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        groups={groups}
        currentKey={view.name === 'workspace' ? view.key : null}
        currentSessionId={sessionId}
        atHome={view.name === 'home'}
        onHome={() => navigate({ name: 'home' })}
        onNewSession={newSession}
        onOpenSession={(key, id) => navigate(openSession(key, id))}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onSearch={() => setPaletteOpen(true)}
        onMandates={() => navigate({ name: 'mandates', id: null })}
        atMandates={view.name === 'mandates'}
        onSettings={() => setSettings('settings')}
        attention={view.name === 'workspace' ? wsAttention : globalAttention}
        onAttention={() => {
          if (view.name !== 'workspace' && (WINDOW_KEY || workspaces[0])) openLatest(WINDOW_KEY ?? workspaces[0].key);
          setTimeout(() => surfaces.open('attention'), 0);
        }}
        connected={!offline}
        authoritative={org.authoritative}
      />
      <main className="main">
        {offline && (
          <div className="banner" role="status">
            {org.cachedAt ? `Offline. Showing what was known ${new Date(org.cachedAt).toLocaleString()}; nothing here is live.` : org.error ?? 'The daemon is not reachable.'}
          </div>
        )}
        {stale.length > 0 && <div className="banner">{outOfDateMessage(stale)}</div>}
        {main}
      </main>
      <SettingsDialog
        open={settings !== null}
        focus={settings ?? 'settings'}
        onClose={() => setSettings(null)}
        mandates={mandates.data ?? []}
        mandateId={mandateId}
        onMandate={setMandateId}
        onManageMandates={() => { setSettings(null); navigate({ name: 'mandates', id: null }); }}
        notifyOnFinish={notifyOnFinish}
        onNotifyOnFinish={setNotifyOnFinish}
      />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} onChoose={chooseFromPalette} />
    </div>
  );
}
