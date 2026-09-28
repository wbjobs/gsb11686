const DB_NAME = "image-filter-studio";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const PROJECT_ID = "current";

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function requestDatabase(mode, callback) {
  return openDatabase().then((database) => {
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = callback(store);
      transaction.oncomplete = () => resolve(request?.result ?? null);
      request.onsuccess = () => {
        if (!request.source.objectStore) resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB 操作失败"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB 事务失败"));
    });
  });
}

export async function loadProject() {
  try {
    return await requestDatabase("readonly", (store) => store.get(PROJECT_ID));
  } catch {
    return null;
  }
}

export async function saveProject(project) {
  try {
    await requestDatabase("readwrite", (store) =>
      store.put({ id: PROJECT_ID, updatedAt: Date.now(), ...project }, PROJECT_ID)
    );
    return true;
  } catch (error) {
    console.warn("项目保存失败：", error);
    return false;
  }
}

export async function clearProject() {
  try {
    await requestDatabase("readwrite", (store) => store.delete(PROJECT_ID));
  } catch {
    // 忽略清理失败，避免影响当前会话。
  }
}
