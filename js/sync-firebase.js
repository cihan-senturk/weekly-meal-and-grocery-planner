// Firestore backend for sync.js. The SDK is loaded from Google's CDN only when a device pairs,
// so people who never pair download nothing extra. Firestore keeps its own offline copy
// (IndexedDB): edits made without signal are queued and sent when the connection returns.

const SDK = 'https://www.gstatic.com/firebasejs/13.2.0';
const COLLECTION = 'spaces';

export async function createFirebaseBackend(config) {
  const [{ initializeApp, getApps }, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = getApps()[0] ?? initializeApp(config);
  let db;
  try {
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app); // already initialised, or IndexedDB unavailable (private mode): memory cache
  }
  const ref = (code) => fs.doc(db, COLLECTION, code);

  return {
    create(code, data) {
      return fs.setDoc(ref(code), { schemaVersion: 1, ...data, createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() });
    },

    subscribe(code, { onData, onMissing, onError }) {
      return fs.onSnapshot(ref(code), { includeMetadataChanges: true }, (snapshot) => {
        const { fromCache, hasPendingWrites } = snapshot.metadata;
        if (!snapshot.exists()) {
          // From the cache "missing" only means "not downloaded yet" (first visit while offline).
          if (!fromCache) onMissing();
          return;
        }
        onData(snapshot.data(), hasPendingWrites ? 'pending' : fromCache ? 'offline' : 'synced');
      }, (error) => {
        // Rules refuse reads of a deleted document only if they are written to; treat "not found" alike.
        if (error?.code === 'not-found') onMissing();
        else onError(error);
      });
    },

    update(code, changes) {
      const args = changes.flatMap(([path, value]) => [new fs.FieldPath(...path), value === undefined ? fs.deleteField() : value]);
      return fs.updateDoc(ref(code), ...args, 'updatedAt', fs.serverTimestamp());
    },

    remove(code) {
      return fs.deleteDoc(ref(code));
    },
  };
}
