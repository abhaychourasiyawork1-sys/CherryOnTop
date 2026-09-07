import { useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { Envelope } from './Envelope.js';
import { Custody, type CustodyChain } from './Custody.js';
import { DodList, type DodItem } from './DodList.js';
import { WhyPanel } from './WhyPanel.js';
import { money, duration, when, clip } from '../lib/format.js';
import type { Envelope as EnvelopeData, Mandate } from '../lib/mandates.js';

interface ReceiptData {
  node: { id: string; goal: string; state: string; repoPath?: string | null; runtime?: string | null; createdAt: string; updatedAt: string };
  nodes: { id: string; goal: string; state: string; runtime?: string | null }[];
  mandate: Mandate | null;
  envelope: EnvelopeData;
  custody: { nodeId: string; chain: CustodyChain }[];
  decisions: { id: string; nodeId: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string }[];
  dod: { items: DodItem[]; progress: { met: number; unmet: number; unverified: number; total: number } };
  artifacts: { id: string; nodeId: string; kind: string; path: string | null; summary: string }[];
  approvals: { id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string }[];
  denials: { id?: number; nodeId: string; payload: unknown; createdAt: string }[];
  costUsd: number;
  budgetUsd: number;
  answer: string | null;
  generatedAt: string;
}

/**
 * One case, as a thing you can hand to someone else.
 *
 * The claim it exists to support is narrow and checkable: every consequential
 * action here has an owner, a mandate that permitted it, evidence, a cost, and —
 * where a person decided — their decision and when they made it. It does not
 * claim to show the model's reasoning, and it says so, because a receipt that
 * oversells itself is worth less than no receipt at all.
 */
export function Receipt({ caseId, onOpenNode, revision = 0 }: { caseId: string; onOpenNode: (id: string) => void; revision?: number }) {
  const receipt = useDaemonQuery<ReceiptData>(
    () => daemon().case.receipt.query({ id: caseId }) as Promise<ReceiptData>,
    [caseId, revision],
  );
  const [exported, setExported] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (receipt.error) return <p className="inbox-error">{receipt.error}</p>;
  if (!receipt.data) return <div className="receipt" />;
  const r = receipt.data;

  const chainFor = (nodeId: string) => r.custody.find((c) => c.nodeId === nodeId)?.chain;
  const humanDecisions = r.approvals.filter((a) => a.status === 'approved' || a.status === 'rejected');

  const exportReceipt = window.mission?.exportReceipt;

  const save = async () => {
    if (!exportReceipt) return;
    setError(null);
    try {
      const path = await exportReceipt(r.node.id, renderReceiptHtml(r));
      setExported(path ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="receipt">
      <header className="receipt-head">
        <div>
          <p className="receipt-eyebrow">Case receipt</p>
          <h1>{r.node.goal}</h1>
          <p className="receipt-sub figure">
            {r.node.id} · generated {when(r.generatedAt)}
          </p>
        </div>
        {exportReceipt && (
          <button type="button" className="ghost-button" onClick={() => void save()}>
            Export as a file
          </button>
        )}
      </header>

      {exported && <p className="receipt-saved">Saved to <span className="figure">{exported}</span></p>}
      {error && <p className="inbox-error">{error}</p>}

      <Section title="What it was permitted to do">
        <p className="receipt-mandate figure">{r.mandate?.name ?? 'Ad-hoc mandate'}</p>
        <Envelope envelope={r.envelope} />
      </Section>

      <Section title="Who did what">
        <ul className="receipt-org">
          {r.nodes.map((node) => (
            <li key={node.id}>
              <button type="button" className="linkish" onClick={() => onOpenNode(node.id)}>
                {clip(node.goal, 70)}
              </button>
              <span className="tag tag-quiet">{node.state}</span>
              {node.runtime && <span className="tag tag-quiet">{node.runtime}</span>}
              {chainFor(node.id) && <Custody chain={chainFor(node.id)!} onOpenNode={onOpenNode} />}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="What it promised, and whether it delivered">
        <DodList items={r.dod.items} />
      </Section>

      <Section title={`What it produced (${r.artifacts.length})`}>
        {r.artifacts.length === 0 ? (
          <p className="tab-empty">Nothing was produced.</p>
        ) : (
          <ul className="artifacts">
            {r.artifacts.map((artifact) => (
              <li key={artifact.id} data-kind={artifact.kind}>
                <span className="figure">{artifact.path ?? clip(artifact.summary, 90)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Every scored decision">
        {r.decisions.length === 0 ? (
          <p className="tab-empty">No decision was scored.</p>
        ) : (
          r.decisions.map((decision) => (
            <div key={decision.id} className="receipt-decision">
              <p className="receipt-decision-head figure">{when(decision.createdAt)}</p>
              <WhyPanel decision={decision} />
            </div>
          ))
        )}
      </Section>

      <Section title="Where a person decided">
        {humanDecisions.length === 0 ? (
          <p className="tab-empty">
            No boundary was reached, so nothing was put to a person. That is the record, not an omission.
          </p>
        ) : (
          <ul className="facts">
            {humanDecisions.map((approval) => (
              <li key={approval.id}>
                <span>{approval.reason}</span>
                <span className="figure">
                  {approval.status === 'approved' ? 'allowed' : 'refused'}
                  {approval.resolvedAt ? ` · ${when(approval.resolvedAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {r.denials.length > 0 && (
        <Section title="Refused by its mandate">
          <ul className="facts">
            {r.denials.map((denial, index) => (
              <li key={denial.id ?? index}>
                <span>{String((denial.payload as { tool?: string } | null)?.tool ?? 'a tool')}</span>
                <span className="figure">{when(denial.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Cost and time">
        <ul className="facts">
          <li><span>Spent</span><span className="figure">{money(r.costUsd, 4)}</span></li>
          <li><span>Ceiling</span><span className="figure">{money(r.budgetUsd)}</span></li>
          <li>
            <span>Ran for</span>
            <span className="figure">{duration(Date.parse(r.node.updatedAt) - Date.parse(r.node.createdAt))}</span>
          </li>
        </ul>
      </Section>

      <footer className="receipt-foot">
        <p>
          This record is assembled from append-only events, hash-chained so an edit after the
          fact is detectable. Run <span className="figure">org verify</span> to check it.
        </p>
        <p className="receipt-limits">
          It shows structured decisions, the authority in force, tools used and refused,
          artifacts, and human decisions. It does not show the model&rsquo;s internal reasoning,
          and nothing here should be read as a claim that it does.
        </p>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="receipt-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** The exported file. Self-contained by construction — no stylesheet, no script,
 *  no network — because the whole point is that it still opens in five years on
 *  a machine that has never heard of this program. */
export function renderReceiptHtml(r: ReceiptData): string {
  const esc = (value: unknown) =>
    String(value).replace(/[&<>"]/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] as string));

  const list = (items: string[]) =>
    items.length === 0 ? '<p class="none">None.</p>' : `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;

  const decisions = r.decisions.map((decision) => {
    const rows = Object.entries(decision.breakdown)
      .map(([key, value]) => `<tr><td>${esc(key)}</td><td class="num">${esc(value)}</td></tr>`).join('');
    return `<div class="decision"><h4>${esc(decision.outcome)} <span class="when">${esc(when(decision.createdAt))}</span></h4><table>${rows}</table></div>`;
  }).join('');

  return `<meta charset="utf-8"><title>Case receipt — ${esc(clip(r.node.goal, 60))}</title>
<style>
 body{font:14px/1.55 ui-sans-serif,system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1.5rem;color:#1b2430}
 h1{font-size:1.5rem;margin:0 0 .25rem} h2{font-size:1rem;margin:2rem 0 .5rem;text-transform:uppercase;letter-spacing:.06em;color:#5d6c7e}
 h4{margin:1rem 0 .25rem;font-size:.9rem}
 .sub,.when,.none{color:#5d6c7e;font-size:.85rem}
 .mono,.num,td{font-family:ui-monospace,SFMono-Regular,monospace}
 table{border-collapse:collapse;width:100%;max-width:22rem} td{padding:.1rem .5rem .1rem 0}
 .num{text-align:right} ul{margin:.25rem 0;padding-left:1.1rem}
 .met::before{content:"✓ ";color:#137a5f} .unmet::before{content:"✕ ";color:#b23c23} .unverified::before{content:"? ";color:#9a7407}
 footer{margin-top:2.5rem;border-top:1px solid #d8dfe7;padding-top:1rem;color:#5d6c7e;font-size:.85rem}
</style>
<h1>${esc(r.node.goal)}</h1>
<p class="sub mono">${esc(r.node.id)} · ${esc(when(r.generatedAt))}${r.node.repoPath ? ` · ${esc(r.node.repoPath)}` : ''}</p>

<h2>What it was permitted to do</h2>
<p><strong>${esc(r.mandate?.name ?? 'Ad-hoc mandate')}</strong></p>
<p>It may:</p>${list(r.envelope.permits)}
<p>It stops and asks before:</p>${list(r.envelope.stops)}
${r.envelope.advisory.length ? `<p>Told, but not enforced:</p>${list(r.envelope.advisory)}` : ''}

<h2>Who did what</h2>
<ul>${r.nodes.map((n) => `<li>${esc(n.goal)} <span class="when">— ${esc(n.state)}${n.runtime ? `, ${esc(n.runtime)}` : ''}</span></li>`).join('')}</ul>

<h2>What it promised</h2>
<ul>${r.dod.items.map((item) => `<li class="${item.state}">${esc(item.text)}${item.note ? ` <span class="when">${esc(item.note)}</span>` : ''}</li>`).join('') || '<li class="none">Nothing recorded.</li>'}</ul>

<h2>What it produced</h2>
${list(r.artifacts.map((a) => a.path ?? a.summary))}

<h2>Every scored decision</h2>
${decisions || '<p class="none">None.</p>'}

<h2>Where a person decided</h2>
${list(r.approvals.filter((a) => a.status === 'approved' || a.status === 'rejected')
    .map((a) => `${a.reason} — ${a.status === 'approved' ? 'allowed' : 'refused'}${a.resolvedAt ? ` on ${when(a.resolvedAt)}` : ''}`))}

${r.denials.length ? `<h2>Refused by its mandate</h2>${list(r.denials.map((d) => `${String((d.payload as { tool?: string } | null)?.tool ?? 'a tool')} — ${when(d.createdAt)}`))}` : ''}

<h2>Cost and time</h2>
<table>
 <tr><td>Spent</td><td class="num">${esc(money(r.costUsd, 4))}</td></tr>
 <tr><td>Ceiling</td><td class="num">${esc(money(r.budgetUsd))}</td></tr>
 <tr><td>Ran for</td><td class="num">${esc(duration(Date.parse(r.node.updatedAt) - Date.parse(r.node.createdAt)))}</td></tr>
</table>

<footer>
 <p>Assembled from an append-only, hash-chained event log; an edit after the fact is detectable with <span class="mono">org verify</span>.</p>
 <p>Shows structured decisions, the authority in force, tools used and refused, artifacts, and human decisions. It does not show the model's internal reasoning.</p>
</footer>`;
}
