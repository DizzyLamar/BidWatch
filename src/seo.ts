const DEFAULT_SITE_URL = 'https://bidwatch-q2u0th.v2.appdeploy.ai';
const OG_IMAGE_PATH = '/og-bidwatch.svg';

const pageMeta: Record<string, { title: string; description: string }> = {
  dashboard: { title: 'Dashboard | BidWatch', description: 'BidWatch dashboard for procurement opportunities, ownership and deadlines.' },
  bids: { title: 'All Bids | BidWatch', description: 'Search and review procurement opportunities tracked in BidWatch.' },
  history: { title: 'Bid History | BidWatch', description: 'Review archived procurement opportunity records retained by BidWatch.' },
  mine: { title: 'My Tenders | BidWatch', description: 'Review procurement opportunities assigned to you in BidWatch.' },
  insights: { title: 'Insights | BidWatch', description: 'Review role-appropriate operational bid and deadline information in BidWatch.' },
  add: { title: 'Add Bid | BidWatch', description: 'Create a procurement opportunity record in BidWatch.' },
  profile: { title: 'Profile | BidWatch', description: 'Manage your BidWatch profile details.' },
  settings: { title: 'Settings | BidWatch', description: 'Manage your BidWatch workspace preferences.' },
  about: { title: 'About BidWatch', description: 'Learn about the BidWatch internal procurement opportunity tracking workspace.' },
  admin: { title: 'Administration | BidWatch', description: 'Manage BidWatch users, roles, permissions and configuration.' },
  auth: { title: 'Sign in to BidWatch', description: 'Sign in to the BidWatch internal procurement opportunity tracker with your provisioned Google account.' },
};

function upsertMeta(attribute: 'name' | 'property', key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
}

function upsertLink(rel: string, href: string) {
  let element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement('link');
    element.rel = rel;
    document.head.appendChild(element);
  }
  element.href = href;
}

function upsertJsonLd(data: Record<string, unknown>) {
  const id = 'bidwatch-jsonld';
  let element = document.getElementById(id) as HTMLScriptElement | null;
  if (!element) {
    element = document.createElement('script');
    element.id = id;
    element.type = 'application/ld+json';
    document.head.appendChild(element);
  }
  element.textContent = JSON.stringify(data);
}

export function applySeo(view: string, authenticated: boolean, selectedTitle?: string) {
  if (window.location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    window.location.replace(`https://${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`);
    return;
  }

  const siteUrl = window.location.origin === 'null' ? DEFAULT_SITE_URL : window.location.origin;
  const ogImage = `${siteUrl}${OG_IMAGE_PATH}`;
  const meta = authenticated ? pageMeta[view] || pageMeta.dashboard : pageMeta.auth;
  const title = authenticated && view === 'bids' && selectedTitle ? `${selectedTitle} | BidWatch` : meta.title;

  document.title = title;
  upsertMeta('name', 'description', meta.description);
  upsertMeta('name', 'robots', 'noindex, nofollow, noarchive');
  upsertMeta('name', 'googlebot', 'noindex, nofollow, noarchive');
  upsertMeta('property', 'og:title', title);
  upsertMeta('property', 'og:description', meta.description);
  upsertMeta('property', 'og:type', 'website');
  upsertMeta('property', 'og:url', siteUrl);
  upsertMeta('property', 'og:image', ogImage);
  upsertMeta('property', 'og:image:alt', 'BidWatch internal procurement opportunity tracking workspace');
  upsertMeta('property', 'og:site_name', 'BidWatch');
  upsertMeta('name', 'twitter:card', 'summary_large_image');
  upsertMeta('name', 'twitter:title', title);
  upsertMeta('name', 'twitter:description', meta.description);
  upsertMeta('name', 'twitter:image', ogImage);
  upsertLink('canonical', siteUrl);

  upsertJsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        url: siteUrl,
        name: 'BidWatch',
        description: 'Internal procurement opportunity tracking workspace.',
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${siteUrl}/#application`,
        name: 'BidWatch',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        url: siteUrl,
        description: 'Internal procurement opportunity tracking workspace.',
      },
    ],
  });
}

function routeFromHashForSeo() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const first = raw.split('/').filter(Boolean)[0] || 'dashboard';
  return pageMeta[first] ? first : 'dashboard';
}

export function installSeo() {
  const update = () => applySeo(routeFromHashForSeo(), false);
  update();
  window.addEventListener('hashchange', update);
  return () => window.removeEventListener('hashchange', update);
}

installSeo();
