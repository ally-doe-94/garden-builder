// Keeps the app and the shared Supabase garden in step.
// main.js hands over an `api` object; this module never touches the 3D scene directly.
//
// Plants are synced one row each with last-write-wins. `synced` remembers the canonical JSON of
// every plant as last seen on the server, so local edits push only what changed and our own
// realtime echoes are recognised and ignored.

import * as cloud from './cloud.js';

const $ = (id) => document.getElementById(id);
const round = (n) => Math.round(n * 10000) / 10000;

function toRecord(p) {
  return {
    id: p.id, type: p.type, position: p.position.map(round), rotation: round(p.rotation), size: round(p.size),
    seed: p.seed, planted: p.planted, notes: p.notes ?? '',
  };
}
const canon = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
const transformOf = (scan) => ({
  quaternion: scan.quaternion.map(round), scale: scan.scale, offset: scan.offset, pointSize: scan.pointSize, lit: scan.lit,
});
const sharedSettings = (settings) => ({ lat: settings.lat, north: settings.north });

const message = (err) => err?.message || String(err);

export function initSync(api) {
  const s = {
    user: null, garden: null, ready: false, unsubscribe: null, needResync: false,
    synced: new Map(), lastSettings: '', lastTransform: '', scanPrefix: null,
    pushTimer: null, pushing: false, again: false, retryTimer: null,
  };

  // -------------------------------------------------------------------------
  // Status button
  // -------------------------------------------------------------------------

  function setStatus(kind) {
    const text = {
      local: ['Sign in', 'Not signed in: your garden is only on this device'],
      syncing: ['Syncing…', 'Saving changes to your shared garden'],
      synced: ['Synced', 'Your shared garden is up to date'],
      offline: ['Offline', "Can't reach the server. Changes will sync when it's back"],
    }[kind];
    $('account-label').textContent = text[0];
    $('btn-account').title = text[1];
    $('btn-account').dataset.status = kind;
  }

  // -------------------------------------------------------------------------
  // Pulling from the cloud
  // -------------------------------------------------------------------------

  function applyPlantRows(rows, { initial = false } = {}) {
    const remote = new Map(rows.map((r) => [r.id, toRecord(r)]));

    if (initial && remote.size === 0) {
      // A brand new shared garden: your existing plants move in, the sample plants don't.
      for (const p of api.state.plants.filter((x) => x.demo)) api.removePlantLocal(p.id);
      return;
    }
    if (initial && api.state.plants.some((p) => !p.demo && !remote.has(p.id))) {
      try { localStorage.setItem('garden-builder.local-backup', JSON.stringify(api.state.plants)); } catch { /* storage full */ }
    }

    for (const p of [...api.state.plants]) {
      if (remote.has(p.id)) continue;
      if (initial && !s.synced.has(p.id)) api.removePlantLocal(p.id); // local-only plant not in the shared garden
      else if (s.synced.has(p.id)) { s.synced.delete(p.id); api.removePlantLocal(p.id); } // deleted by your partner
    }
    for (const [id, rec] of remote) {
      const key = canon(rec);
      if (s.synced.get(id) === key && !initial) continue;
      s.synced.set(id, key);
      api.upsertRemotePlant(rec);
    }
  }

  async function pullAll() {
    if (!s.garden) return;
    try {
      await pushNow();
      const [rows, st] = await Promise.all([cloud.fetchPlants(s.garden.id), cloud.fetchState(s.garden.id)]);
      applyPlantRows(rows);
      if (st) await applyRemoteState(st);
      setStatus('synced');
    } catch (err) {
      console.error(err);
      setStatus('offline');
    }
  }

  function applyRemoteSettings(settings) {
    if (!settings || settings.lat == null) return false;
    const key = canon(sharedSettings(settings));
    if (key === s.lastSettings) return true;
    s.lastSettings = key;
    api.state.settings.lat = settings.lat;
    api.state.settings.north = settings.north ?? 0;
    api.syncSettingsUI();
    return true;
  }

  async function applyRemoteState(st) {
    applyRemoteSettings(st.settings);
    const scan = st.scan;
    if (!scan) {
      if (s.scanPrefix) { s.scanPrefix = null; await api.clearScanLocal(); }
      return;
    }
    lastScanMeta = { name: scan.name, prefix: scan.prefix, files: scan.files };
    if (scan.prefix === s.scanPrefix) {
      const key = canon(scan.transform);
      if (key !== s.lastTransform && api.state.scan) {
        s.lastTransform = key;
        api.applyTransform(scan.transform);
      }
      return;
    }
    s.scanPrefix = scan.prefix;
    s.lastTransform = canon(scan.transform);
    if (api.state.scan?.cloudPrefix === scan.prefix) {
      api.applyTransform(scan.transform);
      return;
    }
    api.showLoading('Downloading the shared scan…');
    try {
      const files = await cloud.downloadScan(scan, (i, n) => api.setLoadingText(`Downloading the shared scan… ${i} of ${n}`));
      await api.adoptScan(files, scan);
    } catch (err) {
      console.error(err);
      api.toast(`Couldn't download the shared scan: ${message(err)}`, 7000);
      s.scanPrefix = null;
    } finally {
      api.hideLoading();
    }
  }

  // -------------------------------------------------------------------------
  // Pushing to the cloud
  // -------------------------------------------------------------------------

  function notifyChange() {
    if (!s.ready) return;
    setStatus('syncing');
    clearTimeout(s.pushTimer);
    s.pushTimer = setTimeout(pushNow, 400);
  }

  async function pushNow() {
    if (!s.ready) return;
    if (s.pushing) { s.again = true; return; }
    s.pushing = true;
    try {
      do {
        s.again = false;
        const gid = s.garden.id;

        const changed = [];
        const previous = new Map();
        for (const p of api.state.plants) {
          const rec = toRecord(p);
          const key = canon(rec);
          if (s.synced.get(p.id) === key) continue;
          changed.push(rec);
          previous.set(p.id, s.synced.get(p.id));
          s.synced.set(p.id, key); // optimistic, so the realtime echo is ignored
        }
        const present = new Set(api.state.plants.map((p) => p.id));
        const removed = [...s.synced.keys()].filter((id) => !present.has(id));

        try {
          if (changed.length) await cloud.upsertPlants(gid, changed);
          if (removed.length) { await cloud.deletePlants(removed); removed.forEach((id) => s.synced.delete(id)); }
        } catch (err) {
          for (const [id, old] of previous) old === undefined ? s.synced.delete(id) : s.synced.set(id, old);
          throw err;
        }

        const settingsKey = canon(sharedSettings(api.state.settings));
        if (settingsKey !== s.lastSettings) {
          s.lastSettings = settingsKey;
          await cloud.saveState(gid, { settings: sharedSettings(api.state.settings) });
        }
        if (api.state.scan && s.scanPrefix && api.state.scan.cloudPrefix === s.scanPrefix) {
          const transform = transformOf(api.state.scan);
          const key = canon(transform);
          if (key !== s.lastTransform) {
            s.lastTransform = key;
            await cloud.saveState(gid, { scan: { ...scanMeta(), transform } });
          }
        }
      } while (s.again);
      setStatus('synced');
    } catch (err) {
      console.error(err);
      setStatus('offline');
      clearTimeout(s.retryTimer);
      s.retryTimer = setTimeout(pushNow, 5000);
    } finally {
      s.pushing = false;
    }
  }

  let lastScanMeta = null;
  const scanMeta = () => lastScanMeta;

  // Called by main.js after you load a scan file: store it in the shared garden.
  async function shareScan(files) {
    if (!s.ready) return;
    const scan = api.state.scan;
    api.showLoading('Sharing the scan with your partner…');
    try {
      const up = await cloud.uploadScan(s.garden.id, files, (i, n) => api.setLoadingText(`Sharing the scan… file ${i} of ${n}`));
      const old = s.scanPrefix;
      const transform = transformOf(scan);
      lastScanMeta = { name: scan.name, prefix: up.prefix, files: up.files };
      s.scanPrefix = up.prefix; // before saving, so our own update isn't treated as a new scan
      s.lastTransform = canon(transform);
      scan.cloudPrefix = up.prefix;
      await cloud.saveState(s.garden.id, { scan: { ...lastScanMeta, transform } });
      api.saveLocal();
      if (old) cloud.removeScanFolder(old).catch(() => {});
      api.toast('Scan shared. Your partner will get it automatically.');
    } catch (err) {
      console.error(err);
      const big = /size|large|exceed|413/i.test(message(err));
      api.toast(big
        ? "That scan is too big to share on the free plan. It still works for you here. Try exporting a smaller or compressed one."
        : `Couldn't share the scan: ${message(err)}`, 9000);
    } finally {
      api.hideLoading();
    }
  }

  async function removeScan() {
    if (!s.ready) return;
    const old = s.scanPrefix;
    s.scanPrefix = null;
    lastScanMeta = null;
    try {
      await cloud.saveState(s.garden.id, { scan: null });
      if (old) await cloud.removeScanFolder(old);
    } catch (err) { console.error(err); }
  }

  // -------------------------------------------------------------------------
  // Connecting
  // -------------------------------------------------------------------------

  async function connect() {
    setStatus('syncing');
    const gid = s.garden.id;
    s.synced.clear();
    const [rows, st] = await Promise.all([cloud.fetchPlants(gid), cloud.fetchState(gid)]);
    applyPlantRows(rows, { initial: true });

    const hasSettings = applyRemoteSettings(st?.settings);
    if (!hasSettings) s.lastSettings = ''; // nothing shared yet: our settings get pushed
    if (st?.scan) {
      lastScanMeta = { name: st.scan.name, prefix: st.scan.prefix, files: st.scan.files };
      await applyRemoteState({ settings: null, scan: st.scan });
    } else if (api.state.scan) {
      const files = await api.getLocalScanFiles();
      s.ready = true; // shareScan needs this
      if (files?.length) await shareScan(files);
    }

    s.ready = true;
    s.unsubscribe = cloud.subscribe(gid, {
      onPlant: (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = payload.old.id;
          s.synced.delete(id);
          api.removePlantLocal(id);
          return;
        }
        const rec = toRecord(payload.new.data);
        const key = canon(rec);
        if (s.synced.get(rec.id) === key) return; // our own change coming back
        s.synced.set(rec.id, key);
        api.upsertRemotePlant(rec);
      },
      onState: (payload) => {
        if (payload.eventType === 'DELETE') return;
        const st2 = payload.new;
        if (st2.scan) lastScanMeta = { name: st2.scan.name, prefix: st2.scan.prefix, files: st2.scan.files };
        applyRemoteState(st2);
      },
      onStatus: (status) => {
        if (status === 'SUBSCRIBED') {
          if (s.needResync) { s.needResync = false; pullAll(); }
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          s.needResync = true;
          setStatus('offline');
        }
      },
    });
    await pushNow();
    renderAccount();
  }

  function disconnect() {
    s.unsubscribe?.();
    s.unsubscribe = null;
    s.ready = false;
    s.synced.clear();
    s.scanPrefix = null;
    s.lastSettings = s.lastTransform = '';
    lastScanMeta = null;
  }

  async function handleUser(user) {
    if ((user?.id ?? null) === (s.user?.id ?? null)) return;
    disconnect();
    s.user = user;
    s.garden = null;
    if (!user) {
      setStatus('local');
      renderAccount();
      return;
    }
    try {
      s.garden = await cloud.myGarden();
      renderAccount();
      if (!s.garden) { setStatus('local'); openDialog(); return; }
      await connect();
      api.toast(`Signed in. Shared garden “${s.garden.name}” is ready.`);
    } catch (err) {
      console.error(err);
      setStatus('offline');
      api.toast(`Couldn't load your shared garden: ${message(err)}`, 7000);
    }
  }

  // -------------------------------------------------------------------------
  // Account dialog
  // -------------------------------------------------------------------------

  const dialog = $('account-dialog');
  const openDialog = () => { renderAccount(); if (!dialog.open) dialog.showModal(); };
  const closeDialog = () => dialog.open && dialog.close();

  function renderAccount() {
    const view = !s.user ? 'signed-out' : !s.garden ? 'no-garden' : 'garden';
    dialog.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('hidden', el.dataset.view !== view));
    if (view === 'garden') {
      $('garden-name').textContent = s.garden.name;
      $('garden-code').textContent = s.garden.join_code;
      $('account-email').textContent = s.user.email ?? '';
      cloud.members(s.garden.id).then((rows) => {
        $('garden-members').innerHTML = rows.map((m) => `<li>${escapeHtml(m.email ?? 'Someone')}</li>`).join('');
      }).catch(() => {});
    }
    if (view === 'no-garden') $('no-garden-email').textContent = s.user.email ?? '';
  }

  const escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function run(button, fn) {
    button.disabled = true;
    try { await fn(); } catch (err) { api.toast(message(err), 7000); } finally { button.disabled = false; }
  }

  $('btn-account').addEventListener('click', openDialog);
  $('account-close').addEventListener('click', closeDialog);

  $('auth-send').addEventListener('click', () => run($('auth-send'), async () => {
    const email = $('auth-email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { $('auth-msg').textContent = 'Enter your email address first.'; return; }
    await cloud.sendLink(email);
    $('auth-msg').textContent = `Link sent to ${email}. Open it on this device to finish signing in. It can take a minute to arrive.`;
  }));
  $('auth-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('auth-send').click(); });

  $('garden-create').addEventListener('click', () => run($('garden-create'), async () => {
    s.garden = await cloud.createGarden($('new-garden-name').value);
    await connect();
    renderAccount();
  }));
  $('garden-join').addEventListener('click', () => run($('garden-join'), async () => {
    const code = $('join-code').value.trim();
    if (!code) { api.toast('Enter the code your partner shared.'); return; }
    s.garden = await cloud.joinGarden(code);
    await connect();
    renderAccount();
    closeDialog();
  }));
  $('garden-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(s.garden.join_code); api.toast('Code copied.'); } catch { api.toast(`Your code is ${s.garden.join_code}`); }
  });
  $('account-signout').addEventListener('click', () => run($('account-signout'), async () => {
    await cloud.signOut();
    closeDialog();
    api.toast('Signed out. Your garden stays on this device.');
  }));

  // -------------------------------------------------------------------------
  // Keep alive
  // -------------------------------------------------------------------------

  addEventListener('online', () => { if (s.ready) pullAll(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && s.ready) pullAll(); });

  setStatus('local');
  cloud.onAuth((user) => handleUser(user));

  return { notifyChange, shareScan, removeScan };
}
