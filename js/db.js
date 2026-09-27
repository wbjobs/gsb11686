/*
 * db.js — IndexedDB 极简封装
 * 用途：持久化撤销/重做栈、当前滤镜链、原图 Blob。
 * 撤销栈存的是链配置 JSON（体积极小），而不是位图快照，避免内存膨胀。
 */
(function (root) {
  'use strict';

  const DB_NAME = 'filter-studio';
  const STORE = 'kv';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      t.oncomplete = () => resolve(result && result._value);
      t.onerror = () => reject(t.error);
      if (result) {
        result.onsuccess = () => { result._value = result.result; };
      }
    }));
  }

  root.DB = {
    get: (key) => tx('readonly', (s) => s.get(key)),
    set: (key, value) => tx('readwrite', (s) => { s.put(value, key); }),
    del: (key) => tx('readwrite', (s) => { s.delete(key); }),
  };
})(typeof self !== 'undefined' ? self : window);
