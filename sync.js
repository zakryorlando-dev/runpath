/* ---------- cloud sync ----------
   The phone stays the source of truth: runs are recorded, measured and stored
   locally exactly as before, and everything works with no signal and no
   account. This mirrors that store into Firestore so a second device can see
   it, and pulls anything the second device recorded.

   Merging is by document id and additive in both directions, so two phones
   that were both used offline end up with the union rather than one erasing
   the other. Deletes are the exception - they have to be remembered
   explicitly, or the other device would helpfully restore what you deleted -
   so a deleted id is written to a tombstone list that both sides respect.

   This module is loaded as ESM and hands a small API to the rest of the app,
   which is a plain script. */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.3.1/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/11.3.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDocs, setDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/11.3.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDZ_FUtGvNPAV7mPAp8C45lBGfQ0uSKJ2k",
  authDomain: "runpath-aeda1.firebaseapp.com",
  projectId: "runpath-aeda1",
  storageBucket: "runpath-aeda1.firebasestorage.app",
  messagingSenderId: "124512053591",
  appId: "1:124512053591:web:6f74be6270bedd2e487612",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let user = null;

/* Firestore rejects undefined and chokes on deeply nested arrays, and a run's
   segments are arrays of arrays. Storing the record as one JSON string keeps
   it exactly as recorded, and keeps a run comfortably inside a document. */
function pack(record) {
  return { id: String(record.id), json: JSON.stringify(record) };
}

function unpack(snapshot) {
  try { return JSON.parse(snapshot.data().json); }
  catch { return null; }
}

const userPath = (kind) => collection(db, "users", user.uid, kind);

async function readCollection(kind) {
  const snap = await getDocs(userPath(kind));
  const out = [];
  snap.forEach((d) => { const rec = unpack(d); if (rec) out.push(rec); });
  return out;
}

async function readTombstones() {
  const snap = await getDocs(collection(db, "users", user.uid, "deleted"));
  const ids = new Set();
  snap.forEach((d) => ids.add(d.id));
  return ids;
}

/* One pass in both directions. Returns what moved, so the app can say
   something specific instead of a spinner and a shrug. */
async function syncNow({ readLocal, writeLocal, readMeta, writeMeta }) {
  if (!user) throw new Error("not signed in");

  const gone = await readTombstones();
  const result = { pulled: {}, pushed: {}, removed: {}, meta: [] };

  for (const kind of ["runs", "routes"]) {
    const local = readLocal(kind).filter((r) => !gone.has(String(r.id)));
    const removedLocally = readLocal(kind).length - local.length;

    const remote = await readCollection(kind);
    const localIds = new Set(local.map((r) => String(r.id)));
    const remoteIds = new Set(remote.map((r) => String(r.id)));

    // anything the other device has and this one doesn't
    const incoming = remote.filter((r) => !localIds.has(String(r.id)) && !gone.has(String(r.id)));
    if (incoming.length || removedLocally) {
      writeLocal(kind, [...local, ...incoming]);
    }

    // and the reverse
    const outgoing = local.filter((r) => !remoteIds.has(String(r.id)));
    for (const record of outgoing) {
      const packed = pack(record);
      await setDoc(doc(db, "users", user.uid, kind, packed.id), packed);
    }

    result.pulled[kind] = incoming.length;
    result.pushed[kind] = outgoing.length;
    result.removed[kind] = removedLocally;
  }

  /* The profile and the plan are single documents rather than collections, and
     they're what a second device most needs on the way in - signing in on a
     new phone should bring the training plan with it, not just the history. */
  if (readMeta && writeMeta) {
    const remote = {};
    const snap = await getDocs(collection(db, "users", user.uid, "meta"));
    snap.forEach((d) => { const rec = unpack(d); if (rec) remote[d.id] = rec; });

    result.meta = writeMeta(remote) || [];

    const local = readMeta();
    for (const [id, record] of Object.entries(local)) {
      if (record && !remote[id]) {
        await setDoc(doc(db, "users", user.uid, "meta", id), pack({ ...record, id }));
      }
    }
  }

  return result;
}

// a delete has to outlive the sync that would otherwise put it back
async function remember(kind, id) {
  if (!user) return;
  const key = String(id);
  try {
    await deleteDoc(doc(db, "users", user.uid, kind, key));
    await setDoc(doc(db, "users", user.uid, "deleted", key), { kind });
  } catch {}
}

async function push(kind, record) {
  if (!user) return;
  try {
    const packed = pack(record);
    await setDoc(doc(db, "users", user.uid, kind, packed.id), packed);
  } catch {}
}

window.RunPathSync = {
  ready: true,
  get user() { return user; },
  onUser(callback) {
    onAuthStateChanged(auth, (u) => { user = u; callback(u); });
  },
  async signUp(email, password) {
    await createUserWithEmailAndPassword(auth, email, password);
  },
  async signIn(email, password) {
    await signInWithEmailAndPassword(auth, email, password);
  },
  async signOut() { await signOut(auth); },
  async resetPassword(email) { await sendPasswordResetEmail(auth, email); },
  syncNow,
  push,
  remember,
};

window.dispatchEvent(new Event("runpath-sync-ready"));
