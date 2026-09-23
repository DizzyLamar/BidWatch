import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from './backend/index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 10000);

app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https://*.supabase.co; form-action 'self' https://accounts.google.com");
  next();
});

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  service: 'bidwatch',
  build: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown',
  supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY),
}));

app.use(handler);

const dist = path.join(__dirname, 'dist');
app.use(express.static(dist, { index: 'index.html' }));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(port, '0.0.0.0', () => console.log('BidWatch listening on 0.0.0.0:' + port));
