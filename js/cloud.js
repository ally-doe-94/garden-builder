// Supabase client and thin data helpers for shared gardens.
// The URL and publishable key below are meant to be public: what each person can see or change
// is enforced by row level security in supabase/schema.sql.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm';

const SUPABASE_URL = 'https://bkczoclzcxutdfqfwidw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8Q-AH3MKBgpvB-q87rSnOg_LzlMI8rc';
const BUCKET = 'scans';

export const AUTH_STORAGE_KEY = 'garden-builder.auth';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: AUTH_STORAGE_KEY },
});

const must = ({ data, error }) => {
  if (error) throw error;
  return data;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function onAuth(callback) {
  sb.auth.onAuthStateChange((_event, session) => callback(session?.user ?? null));
}

// Supabase accounts are keyed by email, so a username maps to an address on a reserved domain
// (.invalid can never receive mail). With "Confirm email" turned off, no email is ever sent.
const USER_DOMAIN = 'users.garden-builder.invalid';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "Ally Doe" -> "ally.doe", "Kōwhai" -> "kowhai". An email address is used as typed.
export function normaliseUsername(input) {
  const t = input.trim().toLowerCase();
  if (t.includes('@')) return t;
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').slice(0, 30);
}
export const isValidUsername = (u) => EMAIL.test(u) || /^[a-z0-9][a-z0-9._-]{2,29}$/.test(u);
const toEmail = (username) => (username.includes('@') ? username : `${username}@${USER_DOMAIN}`);

// With "Confirm email" on, Supabase would try to mail the made-up address, so don't sign up at all.
async function confirmationOff() {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } });
    return (await r.json()).mailer_autoconfirm === true;
  } catch {
    return true;
  }
}

export function displayName(emailOrUser) {
  const email = typeof emailOrUser === 'string' ? emailOrUser : emailOrUser?.email ?? '';
  if (!email.endsWith(`@${USER_DOMAIN}`)) return email;
  const name = email.slice(0, -USER_DOMAIN.length - 1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function friendly(err) {
  const msg = err?.message ?? String(err);
  if (/invalid login credentials/i.test(msg)) return new Error('Wrong username or password.');
  if (/already registered|already exists/i.test(msg)) return new Error('That username is taken. Choose another, or sign in if it is yours.');
  if (/email not confirmed/i.test(msg)) return new Error('Sign-in is waiting for email confirmation. Turn off "Confirm email" in Supabase (Authentication → Sign In / Providers).');
  return err instanceof Error ? err : new Error(msg);
}

export async function signIn(username, password) {
  const { error } = await sb.auth.signInWithPassword({ email: toEmail(username), password });
  if (error) throw friendly(error);
}

export async function signUp(username, password) {
  if (!username.includes('@') && !(await confirmationOff())) {
    throw new Error('Creating accounts is waiting on one Supabase setting: turn off "Confirm email" under Authentication → Sign In / Providers, then try again.');
  }
  const { data, error } = await sb.auth.signUp({ email: toEmail(username), password, options: { data: { username } } });
  if (error) throw friendly(error);
  if (!data.session) throw friendly(new Error('email not confirmed'));
}

export async function signOut() {
  await sb.auth.signOut();
}

// ---------------------------------------------------------------------------
// Gardens
// ---------------------------------------------------------------------------

export async function myGarden() {
  const rows = must(await sb.from('garden_members').select('gardens(id, name, join_code)').order('joined_at').limit(1));
  return rows[0]?.gardens ?? null;
}

export async function members(gardenId) {
  return must(await sb.from('garden_members').select('email, joined_at').eq('garden_id', gardenId).order('joined_at'));
}

export const createGarden = async (name) => must(await sb.rpc('create_garden', { garden_name: name }));
export const joinGarden = async (code) => must(await sb.rpc('join_garden', { code }));

// ---------------------------------------------------------------------------
// Plants and shared settings
// ---------------------------------------------------------------------------

export async function fetchPlants(gardenId) {
  return must(await sb.from('plants').select('id, data').eq('garden_id', gardenId)).map((r) => r.data);
}

export async function fetchState(gardenId) {
  return must(await sb.from('garden_state').select('settings, scan').eq('garden_id', gardenId).maybeSingle());
}

export async function upsertPlants(gardenId, records) {
  const now = new Date().toISOString();
  for (let i = 0; i < records.length; i += 200) {
    const rows = records.slice(i, i + 200).map((data) => ({ id: data.id, garden_id: gardenId, data, updated_at: now }));
    must(await sb.from('plants').upsert(rows));
  }
}

export async function deletePlants(ids) {
  for (let i = 0; i < ids.length; i += 200) must(await sb.from('plants').delete().in('id', ids.slice(i, i + 200)));
}

// patch holds only the column(s) being changed: { settings } or { scan }.
export async function saveState(gardenId, patch) {
  must(await sb.from('garden_state').upsert({ garden_id: gardenId, ...patch, updated_at: new Date().toISOString() }));
}

export function subscribe(gardenId, { onPlant, onState, onStatus }) {
  const filter = `garden_id=eq.${gardenId}`;
  const channel = sb
    .channel(`garden-${gardenId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'plants', filter }, onPlant)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'garden_state', filter }, onState)
    .subscribe(onStatus);
  return () => sb.removeChannel(channel);
}

// ---------------------------------------------------------------------------
// Scan files
// ---------------------------------------------------------------------------

// files: [{ name, blob }]. Stored under <garden id>/<timestamp>/; the original names are kept in
// the returned list because glTF and OBJ files refer to their .bin / .mtl / textures by name.
export async function uploadScan(gardenId, files, onProgress) {
  const prefix = `${gardenId}/${Date.now()}`;
  const stored = [];
  for (const [i, f] of files.entries()) {
    onProgress?.(i + 1, files.length, f.name);
    const key = `${i}-${f.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    must(await sb.storage.from(BUCKET).upload(`${prefix}/${key}`, f.blob, {
      upsert: true, contentType: f.blob.type || 'application/octet-stream',
    }));
    stored.push({ name: f.name, key });
  }
  return { prefix, files: stored };
}

export async function downloadScan(scan, onProgress) {
  const out = [];
  for (const [i, f] of scan.files.entries()) {
    onProgress?.(i + 1, scan.files.length, f.name);
    out.push({ name: f.name, blob: must(await sb.storage.from(BUCKET).download(`${scan.prefix}/${f.key}`)) });
  }
  return out;
}

export async function removeScanFolder(prefix) {
  const list = must(await sb.storage.from(BUCKET).list(prefix));
  if (list.length) must(await sb.storage.from(BUCKET).remove(list.map((f) => `${prefix}/${f.name}`)));
}
