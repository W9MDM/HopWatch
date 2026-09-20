import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalEdge, pathEdges } from "../src/lib/topology.ts";

test("canonicalEdge orders smaller id first", () => {
  assert.deepEqual(canonicalEdge(5, 2), [2, 5]);
  assert.deepEqual(canonicalEdge(2, 5), [2, 5]);
  assert.deepEqual(canonicalEdge(7, 7), [7, 7]);
});

test("pathEdges splits a path into consecutive undirected hops", () => {
  const e = pathEdges([10, 20, 30]);
  assert.equal(e.length, 2);
  assert.deepEqual([e[0]!.a, e[0]!.b], [10, 20]);
  assert.deepEqual([e[1]!.a, e[1]!.b], [20, 30]);
});

test("pathEdges drops zero and self hops", () => {
  assert.equal(pathEdges([0, 20]).length, 0);
  assert.equal(pathEdges([20, 20]).length, 0);
  assert.equal(pathEdges([10, 0, 30]).length, 0); // both hops touch a zero node
});

test("pathEdges attaches SNR by hop index", () => {
  const snr = [-5, -8];
  const e = pathEdges([1, 2, 3], (i) => snr[i] ?? null);
  assert.equal(e[0]!.snr, -5);
  assert.equal(e[1]!.snr, -8);
});

test("pathEdges normalizes direction so A-B and B-A are the same edge", () => {
  const forward = pathEdges([1, 2]);
  const back = pathEdges([2, 1]);
  assert.deepEqual([forward[0]!.a, forward[0]!.b], [back[0]!.a, back[0]!.b]);
});
