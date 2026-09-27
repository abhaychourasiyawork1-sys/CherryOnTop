import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { daemon } from './lib/client.js';
import { useOrg } from './lib/useOrg.js';
import { useDaemonQuery } from './lib/useDaemonQuery.js';
import { subtreeOf } from './lib/tasks.js';
import { REPO } from './lib/bridge.js';
import { toWorkspaces, workspaceKeyOf, workspaceNameOf, workspaceState, type Workspace } from './lib/workspaces.js';
import { homeModel } from './lib/home.js';
import { groupAttention, attentionCount, scopeAttention } from './lib/attention.js';
import { lastSeen, markSeen, localKey, store } from './lib/sync.js';
import { useLocalState } from './lib/useLocalState.js';
import { useLayout } from './lib/useLayout.js';
import { caseStamp } from './lib/useCase.js';
import { openWorkspace, parentOf, SECTION_LABEL, type Section, type View } from './lib/view.js';
import { MAIN, assign, casesIn, createBranch, decodeConversations, deleteBranch, branchConflicts, type Conversations } from './lib/conversations.js';
import { titleOf, phaseOf, isLive } from './lib/run.js';
import { missingRouters, outOfDateMessage } from './lib/compat.js';
import { goalWithContext, redirectGoal, type ContextRef } from './composer/ContextResolver.js';
import { displayPath } from './lib/artifacts.js';
import type { SearchItem } from './lib/search.js';
import type { Mandate } from './lib/mandates.js';
import { Sidebar, type CoreItem } from './navigation/Sidebar.js';
import { Home } from './navigation/Home.js';
import { WorkspacePicker } from './navigation/WorkspacePicker.js';
import { CommandPalette } from './navigation/CommandPalette.js';
import { ConversationSwitcher } from './navigation/ConversationSwitcher.js';
import { WorkspaceHeader } from './shell/WorkspaceHeader.js';
import { AdaptiveWorkspace } from './shell/AdaptiveWorkspace.js';
import { OrganizationView } from './shell/OrganizationView.js';
import { WorkspaceContext, type WorkspaceApi } from './shell/WorkspaceContext.js';
import { ErrorBoundary } from './shell/ErrorBoundary.js';
import { Composer } from './panels/Composer.js';
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
  const workspaces = useMemo(() => {
    const known = toWorkspaces(org.nodes);
    const extra = [...new Set([WINDOW_KEY, ...recentKeys].filter((k): k is string => Boolean(k)))]
      .filter((key) => !known.some((ws) => ws.key === key))
      .map((key) => emptyWorkspace(key));
    return [...known, ...extra];
  }, [org.nodes, recentKeys]);
  const byKey = useMemo(() => new Map(workspaces.map((ws) => [ws.key, ws])), [workspaces]);

  const [view, setView] = useState<View>(() => (WINDOW_KEY ? openWorkspace(WINDOW_KEY) : { name: 'home' }));
  const history = useRef<View[]>([]);
  const navigate = useCallback((next: View) => {
    setView((current) => {
      if (JSON.stringify(current) !== JSON.stringify(next)) history.current = [...history.current.slice(-20), current];
      return next;
    });
  }, []);

  const [collapsed, setCollapsed] = useLocalState<boolean>(localKey('sidebar'), (raw) => raw === 'true', String);
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  const attentionQuery = useAttention(org.revision);
  const allAttention = attentionQuery.data ?? [];
  const globalAttention = attentionCount(groupAttention(allAttention));

  // ---- the Workspace in view --------------------------------------------
  const wsKey = view.name === 'workspace' ? view.key : WINDOW_KEY ?? workspaces[0]?.key ?? null;
  const workspace: Workspace | null = wsKey
    ? byKey.get(wsKey) ?? emptyWorkspace(wsKey)
    : null;
  const surfaces = useLayout(workspace?.key ?? null);

  const [conversations, setConversations] = useLocalState<Conversations>(localKey('branches', workspace?.key ?? 'none'), decodeConversations);
  const [branch, setBranch] = useLocalState<string>(localKey('branches', `${workspace?.key ?? 'none'}:current`), (raw) => raw ?? MAIN, (v) => v);
  const currentBranch = branch === MAIN || conversations.branches.some((b) => b.id === branch) ? branch : MAIN;
  const allCaseIds = useMemo(() => workspace?.cases.map((c) => c.id) ?? [], [workspace]);
  const threadCaseIds = useMemo(() => casesIn(conversations, currentBranch, allCaseIds), [conversations, currentBranch, allCaseIds]);

  const activeCaseId = view.name === 'workspace' && view.caseId && allCaseIds.includes(view.caseId)
    ? view.caseId
    : threadCaseIds.length > 0
      ? workspace!.cases.filter((c) => threadCaseIds.includes(c.id))[0]?.id ?? null
      : null;
  const activeCase = activeCaseId ? org.nodes.find((n) => n.id === activeCaseId) ?? null : null;
  const activeSubtree = useMemo(() => (activeCase ? subtreeOf(org.nodes, activeCase.id) : []), [org.nodes, activeCase]);
  const liveCase = useMemo(() => {
    const ids = new Set(threadCaseIds);
    return workspace?.cases.find((c) => ids.has(c.id) && isLive(phaseOf(c, subtreeOf(org.nodes, c.id)))) ?? null;
  }, [workspace, threadCaseIds, org.nodes]);

  const scopedAttention = useMemo(() => scopeAttention(allAttention, new Set(allCaseIds)), [allAttention, allCaseIds]);
  const wsAttention = attentionCount(groupAttention(scopedAttention));

  // Where new work goes: the Workspace you are in, or — on Home — the one
  // chosen in the composer. The daemon decides whether it can run there.
  const [homeKey, setHomeKey] = useLocalState<string | null>(localKey('draft', 'home-workspace'), (raw) => raw || null, (v) => v ?? '');
  const homeTarget = homeKey ?? WINDOW_KEY ?? workspaces[0]?.key ?? null;
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
    setView((current) => ({
      name: 'workspace',
      key: root ? key : current.name === 'workspace' ? current.key : key,
      section: current.name === 'workspace' && root && key === current.key ? current.section : 'chat',
      caseId,
      nodeId: null,
    }));
  }, [org.nodes]);

  const startWork = useCallback(async (goal: string) => {
    const resolved = target.data;
    if (!resolved || !resolved.ok) throw new Error(blockedReason ?? 'This Workspace cannot take new work.');
    const key = workspaceKeyOf(resolved.containerPath);
    const created = await daemon().node.create.mutate({
      goal,
      definition_of_done: [goal],
      // The contract requires authority; the daemon replaces it with the
      // mandate's own, so the two can never disagree.
      authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 5 },
      constraints: [],
      mandateId,
      repoPath: resolved.containerPath,
    });
    const id = (created as { id: string }).id;
    // Filed under the conversation it was asked in — only meaningful when it
    // was asked inside this Workspace rather than from Home.
    if (view.name === 'workspace' && key === view.key) setConversations((state) => assign(state, currentBranch, id));
    org.refresh();
    setView({ name: 'workspace', key, section: 'chat', caseId: id, nodeId: null });
    return id;
  }, [mandateId, currentBranch, org, setConversations, target.data, blockedReason, view]);

  /** A folder picked on Home: the daemon checks it; if usable it becomes a
   *  Workspace (remembered even before it has runs) and the target. */
  const openFolder = async (hostPath: string): Promise<string | null> => {
    const resolved = await resolveRepo(hostPath);
    if (!resolved.ok) return resolved.error;
    const key = workspaceKeyOf(resolved.containerPath);
    setRecentKeys((keys) => [key, ...keys.filter((k) => k !== key)].slice(0, 12));
    setHomeKey(key);
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
    navigate({ name: 'workspace', key: workspace.key, section, caseId: activeCase?.id ?? null, nodeId });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.key, activeCase?.id, navigate]);

  const api: WorkspaceApi | null = workspace ? {
    org, workspace, activeCase, activeSubtree, activeStamp: caseStamp(activeSubtree),
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
  } : null;

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((v) => !v); }
      if (mod && event.key === '\\') { event.preventDefault(); setCollapsed((v) => !v); }
      // Layout is UI state, so it gets ordinary undo.
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'z' && !editing) {
        if (surfaces.undo()) event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [surfaces, setCollapsed]);

  // ---- palette ------------------------------------------------------------
  const paletteItems = useMemo<SearchItem[]>(() => {
    const items: SearchItem[] = [
      ...(workspace ? [
        { id: 'go-plan', kind: 'action' as const, title: 'Show the plan', keywords: 'plan steps' },
        { id: 'go-files', kind: 'action' as const, title: 'Show changed files', keywords: 'files changes diff' },
        { id: 'go-memory', kind: 'action' as const, title: 'Show what this Workspace has learned', keywords: 'memory' },
        { id: 'go-activity', kind: 'action' as const, title: 'Show the history of this run', keywords: 'activity timeline story details' },
        { id: 'go-authority', kind: 'action' as const, title: 'Review Workspace authority', keywords: 'mandate permissions authority' },
        { id: 'new-branch', kind: 'action' as const, title: 'Start a focused conversation', keywords: 'branch conversation' },
        { id: 'reset-layout', kind: 'action' as const, title: 'Reset the layout', keywords: 'surfaces panels clean' },
      ] : []),
      { id: 'go-home', kind: 'action', title: 'Go Home' },
      { id: 'toggle-sidebar', kind: 'action', title: collapsed ? 'Expand the sidebar' : 'Collapse the sidebar' },
      { id: 'toggle-theme', kind: 'action', title: document.documentElement.dataset.theme === 'light' ? 'Use the dark theme' : 'Use the light theme', keywords: 'theme appearance' },
      ...workspaces.map((ws) => ({ id: ws.key, kind: 'workspace' as const, title: ws.name, subtitle: ws.running ? 'Working' : undefined, workspaceKey: ws.key })),
    ];
    for (const ws of workspaces) {
      for (const root of ws.cases.slice(0, 60)) {
        items.push({ id: root.id, kind: 'run', title: titleOf(root.goal), subtitle: ws.name, workspaceKey: ws.key, keywords: root.goal.slice(0, 400) });
      }
    }
    return items;
  }, [workspaces, workspace, collapsed]);

  const chooseFromPalette = (item: SearchItem) => {
    switch (item.kind) {
      case 'workspace': navigate(openWorkspace(item.id)); return;
      case 'run': focusCase(item.id); return;
      default: break;
    }
    if (item.id === 'go-home') navigate({ name: 'home' });
    if (item.id === 'toggle-sidebar') setCollapsed((v) => !v);
    if (item.id === 'reset-layout') surfaces.reset();
    if (item.id === 'toggle-theme') {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      store.set('cot.theme.v1', next);
    }
    if (item.id === 'go-plan') surfaces.open('plan', activeCase?.id ?? null);
    if (item.id === 'go-files') surfaces.open('files');
    if (item.id === 'go-memory') surfaces.open('memory');
    if (item.id === 'go-activity') surfaces.open('activity', activeCase?.id ?? null);
    if (item.id === 'go-authority') openSection('authority');
    if (item.id === 'new-branch') branchFrom('Focused conversation');
  };

  const branchFrom = (name: string) => {
    const id = `b-${Date.now().toString(36)}`;
    setConversations((state) => createBranch(state, name, activeCase?.id ?? null, id, new Date().toISOString()));
    setBranch(id);
  };

  // ---- composer handlers ---------------------------------------------------
  const ask = async (text: string) => {
    const result = await daemon().org.ask.query({ question: text, focusedNodeId: activeCase?.id });
    setExchanges((current) => [...current, { key: `${Date.now()}-${current.length}`, question: text, result: result as AskResult, caseId: activeCase?.id ?? null }]);
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
      onAuthority={variant === 'docked' ? () => openSection('authority') : undefined}
      blockedReason={blockedReason}
      leading={variant === 'hero' ? (
        <WorkspacePicker
          workspaces={workspaces}
          selected={homeTarget ? byKey.get(homeTarget) ?? emptyWorkspace(homeTarget) : null}
          status={target.loading && !target.data ? 'checking' : target.data?.ok ? 'ready' : 'unusable'}
          onSelect={setHomeKey}
          onOpenFolder={openFolder}
        />
      ) : undefined}
      offline={offline}
      draftScope={variant === 'hero' ? 'home' : `${workspace?.key ?? ''}:${currentBranch}`}
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
  // Branch conflicts need to know which files each run changed; only worth
  // reading once there is more than one conversation.
  const branchedStamp = conversations.branches.length > 0 ? allCaseIds.slice(0, 25).join('|') : '';
  const filesByCase = useDaemonQuery<Map<string, string[]>>(
    () => (branchedStamp
      ? Promise.all(allCaseIds.slice(0, 25).map((id) => daemon().artifact.listForSubtree.query({ nodeId: id })
        .then((rows) => [id, [...new Set((rows as { kind: string; path: string | null }[])
          .filter((r) => (r.kind === 'file_edit' || r.kind === 'file_write') && r.path).map((r) => r.path!))]] as const)))
        .then((pairs) => new Map(pairs.map(([id, files]) => [id, [...files]])))
      : Promise.resolve(new Map())),
    [branchedStamp, org.revision],
  );
  const conflicts = useMemo(
    () => (filesByCase.data && conversations.branches.length > 0 ? branchConflicts(conversations, allCaseIds, filesByCase.data) : []),
    [filesByCase.data, conversations, allCaseIds],
  );

  const onCore = (item: CoreItem) => {
    if (!workspace) return;
    if (view.name !== 'workspace' || view.section !== 'chat') navigate({ name: 'workspace', key: workspace.key, section: 'chat', caseId: activeCase?.id ?? null, nodeId: null });
    surfaces.closeDeepDive();
    if (item === 'chat') return;
    const kind = item === 'files' ? 'files' : item === 'plan' ? 'plan' : 'memory';
    const existing = surfaces.layout.side.find((s) => s.kind === kind && !s.collapsed);
    if (existing) surfaces.close(existing.id);
    else surfaces.open(kind, kind === 'plan' ? activeCase?.id ?? null : null);
  };

  const attentionSurface = (
    <AttentionSurface
      items={view.name === 'home' ? allAttention : scopedAttention}
      conflicts={conflicts}
      onOpen={(caseId, nodeId) => { focusCase(caseId); if (nodeId && nodeId !== caseId) openSection('agents', nodeId); }}
      onChanged={() => { attentionQuery.reload(); org.refresh(); }}
      branchName={(id) => (id === MAIN ? 'Main' : conversations.branches.find((b) => b.id === id)?.name ?? 'a conversation')}
    />
  );

  const state = workspaceState(workspace, { connected: !offline, authoritative: org.authoritative });

  const main = view.name === 'home' || !workspace || !api ? (
    <>
      <WorkspaceHeader backLabel={null} onBack={() => {}} title="Home" state={workspaceState(null, { connected: !offline, authoritative: org.authoritative })} cachedAt={org.cachedAt} />
      <div className="main-scroll">
        <Home
          model={homeModel(workspaces, seenAt, globalAttention)}
          attention={globalAttention}
          composer={composer('hero')}
          onOpenWorkspace={(key, caseId) => navigate(openWorkspace(key, caseId ?? null))}
          onAttention={() => { if (WINDOW_KEY || workspaces[0]) navigate(openWorkspace(WINDOW_KEY ?? workspaces[0].key)); setTimeout(() => surfaces.open('attention'), 0); }}
        />
      </div>
    </>
  ) : (
    <WorkspaceContext.Provider value={api}>
      <WorkspaceHeader
        backLabel={section === 'chat' ? 'Home' : workspace.name}
        onBack={() => navigate(parentOf(view))}
        title={section === 'chat' ? workspace.name : SECTION_LABEL[section!]}
        context={section === 'chat' ? (
          <ConversationSwitcher
            state={conversations}
            current={currentBranch}
            onSwitch={setBranch}
            onBranch={(name) => branchFrom(name)}
            onDelete={(id) => { setConversations((s) => deleteBranch(s, id)); if (id === currentBranch) setBranch(MAIN); }}
            canBranchFrom={activeCase?.id ?? null}
          />
        ) : null}
        state={state}
        onState={state === 'attention' || wsAttention > 0 ? () => surfaces.open('attention') : undefined}
        cachedAt={org.cachedAt}
      />
      {section === 'chat' ? (
        <AdaptiveWorkspace attention={attentionSurface}>
          <div className="chat">
            <ErrorBoundary what="The conversation" key={`${workspace.key}:${currentBranch}`}>
              <Thread
                caseIds={threadCaseIds}
                exchanges={exchanges}
                empty={(
                  <div className="chat-empty">
                    <h2 className="chat-empty-title">
                      {currentBranch === MAIN ? `What should CherryOnTop do in ${workspace.name}?` : 'A focused conversation'}
                    </h2>
                    <p className="chat-empty-note">
                      {currentBranch === MAIN
                        ? 'Describe the outcome you want. CherryOnTop plans it, staffs it and checks it, and asks you only when it needs to.'
                        : 'It shares this Workspace’s files, decisions and memory, and keeps its own thread.'}
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
        workspaces={workspaces}
        workspace={view.name === 'workspace' ? workspace : null}
        onOpenWorkspace={(key) => navigate(openWorkspace(key))}
        atHome={view.name === 'home'}
        onHome={() => navigate({ name: 'home' })}
        active={{
          chat: section === 'chat' && !surfaces.layout.deepDive,
          files: section === 'chat' && openKinds.has('files'),
          plan: section === 'chat' && openKinds.has('plan'),
          memory: section === 'chat' && openKinds.has('memory'),
        }}
        onCore={onCore}
        section={section}
        onSection={(s) => openSection(s)}
        attention={view.name === 'workspace' ? wsAttention : globalAttention}
        onAttention={() => {
          if (view.name !== 'workspace' && (WINDOW_KEY || workspaces[0])) navigate(openWorkspace(WINDOW_KEY ?? workspaces[0].key));
          setTimeout(() => surfaces.open('attention'), 0);
        }}
        onSearch={() => setPaletteOpen(true)}
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
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} onChoose={chooseFromPalette} />
    </div>
  );
}
