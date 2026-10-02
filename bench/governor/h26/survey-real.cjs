// Survey of every preserved real-run database: how often the governor could act.
//   node bench/governor/h26/survey-real.cjs
const D = require("better-sqlite3");
const { execSync } = require('child_process');
const files = execSync('find ~/Desktop/CherryOnTop-bench ~/.cherryontop-bench-arch -name state.db 2>/dev/null', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const agg = { dbs: 0, nodes: 0, failedValidation: 0, retryDispatch: 0, governedRetry: 0, recoverCandidate: 0, recoverChosen: 0, recoverCarried: 0, econDecisions: 0, econFaulted: 0, turnCapStops: 0, stallStops: 0 };
for (const f of files) {
  let db; try { db = new D(f, { readonly: true, fileMustExist: true }); } catch { continue; }
  try {
    agg.dbs++;
    const q = (s) => { try { return db.prepare(s).all(); } catch { return []; } };
    for (const n of q('select id from nodes')) {
      agg.nodes++;
      const ev = q(`select type, payload, created_at from events where node_id='${n.id}' order by created_at, id`);
      let failedSeen = false;
      for (const e of ev) {
        if (e.type === 'validation.result' && /"passed":false/.test(e.payload)) { if (!failedSeen) agg.failedValidation++; failedSeen = true; }
        if (e.type === 'market.decision' && /"role":"execute"/.test(e.payload) && failedSeen) agg.retryDispatch++;
        if (e.type === 'economic.decision') {
          agg.econDecisions++;
          if (/fault:/.test(e.payload)) agg.econFaulted++;
          if (failedSeen) agg.governedRetry++;
          if (/recover/.test(e.payload)) agg.recoverCandidate++;
          if (/"action":"recover"/.test(e.payload)) agg.recoverChosen++;
        }
        if (e.type === 'step.progress' && /Turn cap reached|spend cap|budget/i.test(e.payload)) agg.turnCapStops++;
        if (e.type === 'step.progress' && /stall|stuck/i.test(e.payload)) agg.stallStops++;
        if (e.type === 'step.progress' && /pivoting rather than repeating/.test(e.payload)) agg.recoverCarried++;
      }
    }
  } finally { db.close(); }
}
console.log(JSON.stringify(agg, null, 1));
