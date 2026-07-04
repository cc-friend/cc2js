/*
 * cc2js runtime polyfills — prepended to the transpiled Node 18/20/22 builds.
 *
 * esbuild lowers modern *syntax* (e.g. `using` / `await using`) for the target,
 * but it cannot add missing *runtime methods*. The Claude Code bundle calls a few
 * APIs that don't exist on older Node (chiefly Array.prototype.with, Node 20+).
 * Every patch below is idempotent: it only defines a method when the running Node
 * lacks it, so this file is a no-op on newer Node and safe to prepend everywhere.
 */
(function () {
  'use strict';
  var def = function (obj, name, fn) {
    if (obj && typeof obj[name] !== 'function') {
      try {
        Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true });
      } catch (e) { /* frozen intrinsic — ignore */ }
    }
  };

  // ---- Array.prototype (Node 20: with/toSorted/toReversed/toSpliced) ----
  def(Array.prototype, 'with', function (i, value) {
    var a = Array.prototype.slice.call(this);
    var idx = i < 0 ? a.length + i : i;
    if (idx < 0 || idx >= a.length) throw new RangeError('Invalid index : ' + i);
    a[idx] = value;
    return a;
  });
  def(Array.prototype, 'toSorted', function (cmp) {
    var a = Array.prototype.slice.call(this);
    a.sort(cmp);
    return a;
  });
  def(Array.prototype, 'toReversed', function () {
    return Array.prototype.slice.call(this).reverse();
  });
  def(Array.prototype, 'toSpliced', function () {
    var a = Array.prototype.slice.call(this);
    a.splice.apply(a, arguments);
    return a;
  });
  // ---- Array.prototype (Node 18: findLast/findLastIndex) — guard for 18.0 ----
  def(Array.prototype, 'findLast', function (cb, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) if (cb.call(thisArg, this[i], i, this)) return this[i];
    return undefined;
  });
  def(Array.prototype, 'findLastIndex', function (cb, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) if (cb.call(thisArg, this[i], i, this)) return i;
    return -1;
  });

  // ---- TypedArrays (Node 20: with/toReversed/toSorted) ----
  try {
    var TA = Object.getPrototypeOf(Int8Array.prototype);
    def(TA, 'with', function (i, value) {
      var a = this.slice();
      var idx = i < 0 ? a.length + i : i;
      if (idx < 0 || idx >= a.length) throw new RangeError('Invalid index : ' + i);
      a[idx] = value;
      return a;
    });
    def(TA, 'toReversed', function () { return this.slice().reverse(); });
    def(TA, 'toSorted', function (cmp) { var a = this.slice(); a.sort(cmp); return a; });
  } catch (e) { /* ignore */ }

  // ---- Promise.withResolvers (Node 22) — future-proof for newer bundles ----
  def(Promise, 'withResolvers', function () {
    var resolve, reject;
    var promise = new this(function (res, rej) { resolve = res; reject = rej; });
    return { promise: promise, resolve: resolve, reject: reject };
  });

  // ---- Object.groupBy / Map.groupBy (Node 21) ----
  def(Object, 'groupBy', function (items, cb) {
    var o = Object.create(null), i = 0;
    for (var it of items) { var k = cb(it, i++); (o[k] || (o[k] = [])).push(it); }
    return o;
  });
  def(Map, 'groupBy', function (items, cb) {
    var m = new Map(), i = 0;
    for (var it of items) { var k = cb(it, i++); var g = m.get(k); if (g) g.push(it); else m.set(k, [it]); }
    return m;
  });

  // ---- Array.fromAsync (Node 22) ----
  def(Array, 'fromAsync', function (iter, mapFn, thisArg) {
    return (async function () {
      var out = [], i = 0, v;
      if (iter && typeof iter[Symbol.asyncIterator] === 'function') {
        for await (v of iter) out.push(mapFn ? await mapFn.call(thisArg, v, i++) : v);
      } else {
        for (v of (iter || [])) { var vv = await v; out.push(mapFn ? await mapFn.call(thisArg, vv, i++) : vv); }
      }
      return out;
    })();
  });

  // ---- structuredClone (Node 17) — present in 18; lossy guard just in case ----
  if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = function (v) { return v == null ? v : JSON.parse(JSON.stringify(v)); };
  }
})();
