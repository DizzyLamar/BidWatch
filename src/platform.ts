import { createClient } from '@supabase/supabase-js';

const env = (import.meta as any).env || {};
const SUPABASE_URL = env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_PUBLISHABLE_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.warn('BidWatch auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
}

export const supabase = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_PUBLISHABLE_KEY || 'placeholder',
  { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } }
);

function apiError(status: number, data: any) {
  const err = new Error(data?.error || 'Request failed.');
  (err as any).status = status;
  (err as any).code = data?.code;
  return err;
}

export const api = {
  async request(method: string, url: string, body?: unknown) {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session?.access_token ? { Authorization: 'Bearer ' + session.access_token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw apiError(response.status, data);
    return { data };
  },
  get(url: string) { return this.request('GET', url); },
  post(url: string, body?: unknown) { return this.request('POST', url, body); },
  put(url: string, body?: unknown) { return this.request('PUT', url, body); },
  delete(url: string) { return this.request('DELETE', url); },
};

export const auth = {
  async getUser() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    return {
      userId: user.id,
      email: user.email || '',
      name: String(user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User'),
    };
  },
  isSignedIn() {
    return Boolean(localStorage.getItem('bidwatch-auth-present'));
  },
  async signIn() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname + window.location.hash },
    });
    if (error) throw error;
    return { user: null };
  },
  async signOut() {
    localStorage.removeItem('bidwatch-auth-present');
    await supabase.auth.signOut();
  },
};

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) localStorage.setItem('bidwatch-auth-present', '1');
  else localStorage.removeItem('bidwatch-auth-present');
});

export const notifications = {
  async subscribe() {
    if (!('Notification' in window)) throw new Error('Browser notifications are not supported.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted.');
    return true;
  },
};
