/** How likely the agent is to come back for what an elision left out, from
 *  what can be observed when the decision is made.
 *
 *  Per-(tool, representation) counts were the first estimator. Offline,
 *  cross-fitted over 308 recorded sessions, they scored worse than a constant
 *  predictor (Brier 0.23 vs 0.21 on one fold): whether an elided region is
 *  needed depends on *what is in it*, which a cell cannot see. This model
 *  conditions on it.
 *
 *  An L2-regularised logistic regression fit by Newton's method (IRLS). The
 *  pessimistic bound is the upper edge of the Laplace-approximate posterior
 *  over the logit, at the same confidence the market uses everywhere: the
 *  model is as cautious as its evidence is thin. Small, deterministic, no
 *  dependencies: a dozen features and a few thousand rows fit in milliseconds. */
import { zScore } from '../intelligence/difficulty.js';

export interface RefetchFeatures {
  tool: string;
  representation: string;
  originalTokens: number;
  keptFraction: number;
  /** Code-shaped identifiers only the elided part holds, not seen earlier in the session. */
  novelIdentifiers: number;
  /** step / (step + expected remaining turns). */
  progress: number;
}

export interface RefetchModel {
  weights: number[];
  /** Inverse Hessian at the optimum: the posterior covariance of the weights. */
  covariance: number[][];
  rows: number;
}

const TOOLS = ['read', 'bash', 'grep', 'glob'];
const REPS = ['salient', 'outline', 'pointer'];

export function featurize(f: RefetchFeatures): number[] {
  return [
    1,
    Math.log1p(Math.max(0, f.originalTokens)) / 8,
    Math.max(0, Math.min(1, f.keptFraction)),
    Math.log1p(Math.max(0, f.novelIdentifiers)) / 4,
    Math.max(0, Math.min(1, f.progress)),
    ...TOOLS.map((t) => (f.tool === t ? 1 : 0)),
    ...REPS.map((r) => (f.representation === r ? 1 : 0)),
  ];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Solves A x = b for a small dense symmetric positive-definite A (Gaussian elimination, partial pivoting). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = m[r][c] / d;
      for (let j = c; j <= n; j++) m[r][j] -= k * m[c][j];
    }
  }
  return m.map((row, i) => row[n] / (row[i] || 1e-12));
}

function invert(a: number[][]): number[][] {
  const n = a.length;
  const cols = Array.from({ length: n }, (_, j) => solve(a, Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))));
  return Array.from({ length: n }, (_, i) => cols.map((col) => col[i]));
}

/** `l2` is the prior precision on every weight but the intercept: a Gaussian
 *  prior centred on zero, i.e. "no feature matters" until the data say so. */
export function fitRefetchModel(rows: ReadonlyArray<{ features: RefetchFeatures; used: boolean }>, l2 = 1): RefetchModel | null {
  if (rows.length === 0) return null;
  const xs = rows.map((r) => featurize(r.features));
  const ys = rows.map((r) => (r.used ? 1 : 0));
  const d = xs[0].length;
  let w = new Array(d).fill(0);
  let hessian: number[][] = [];
  for (let iter = 0; iter < 30; iter++) {
    const grad = new Array(d).fill(0);
    hessian = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const p = sigmoid(x.reduce((s, v, j) => s + v * w[j], 0));
      const r = p * (1 - p);
      for (let j = 0; j < d; j++) {
        grad[j] += (p - ys[i]) * x[j];
        for (let k = j; k < d; k++) hessian[j][k] += r * x[j] * x[k];
      }
    }
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < j; k++) hessian[j][k] = hessian[k][j];
      if (j > 0) { hessian[j][j] += l2; grad[j] += l2 * w[j]; } else { hessian[j][j] += 1e-6; }
    }
    const step = solve(hessian, grad);
    w = w.map((v, j) => v - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { weights: w, covariance: invert(hessian), rows: rows.length };
}

export function predictRefetch(model: RefetchModel, f: RefetchFeatures, confidence: number): { mean: number; bound: number } {
  const x = featurize(f);
  const logit = x.reduce((s, v, j) => s + v * model.weights[j], 0);
  let variance = 0;
  for (let j = 0; j < x.length; j++) for (let k = 0; k < x.length; k++) variance += x[j] * model.covariance[j][k] * x[k];
  return { mean: sigmoid(logit), bound: sigmoid(logit + zScore(confidence) * Math.sqrt(Math.max(0, variance))) };
}
