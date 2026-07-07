/* DealInbox — site behaviour
   Product catalogue, deal cards, countdowns, reveal animations,
   and the 3D viewer modal (backed by js/viewer3d.js). */

const CATALOG = [
  {
    key: 'aurora-pendant',
    name: 'Aurora Brass Pendant',
    brand: 'Nordlys Studio',
    price: 189, was: 420,
    rating: 4.9, reviews: 2140,
    claimed: 78,
    blurb: 'Hand-spun brass dome with a hidden opal diffuser. Casts a pool of warm light that makes every dinner feel like a celebration.',
  },
  {
    key: 'crystal-chandelier',
    name: 'Odette Crystal Chandelier',
    brand: 'Maison Lumière',
    price: 749, was: 1890,
    rating: 4.8, reviews: 962,
    claimed: 64,
    blurb: 'Six candle arms, forty-two hand-cut crystal drops. The showpiece of tonight’s drop — showroom price elsewhere: four figures.',
  },
  {
    key: 'arc-floor',
    name: 'Arco Marble Floor Lamp',
    brand: 'Castiglione & Co',
    price: 329, was: 780,
    rating: 4.9, reviews: 1587,
    claimed: 71,
    blurb: 'A sweeping steel arc anchored in solid Carrara marble. Reads as sculpture by day, reading light by night.',
  },
  {
    key: 'mushroom-table',
    name: 'Nebbia Mushroom Lamp',
    brand: 'Murano Atelier',
    price: 145, was: 310,
    rating: 4.7, reviews: 3411,
    claimed: 87,
    blurb: 'Mouth-blown opal glass in one continuous curve. Glows from within like fog at sunrise — the internet’s favourite lamp, at half price.',
  },
  {
    key: 'neon-quasar',
    name: 'Quasar Neon Sculpture',
    brand: 'VoltHaus',
    price: 99, was: 240,
    rating: 4.8, reviews: 1204,
    claimed: 59,
    blurb: 'A continuous loop of hand-bent neon on a matte hex base. Shift its spectrum from ember to ice in the 3D viewer.',
  },
  {
    key: 'lumen-desk',
    name: 'Lumen Task Lamp',
    brand: 'Archer & Sloane',
    price: 119, was: 260,
    rating: 4.9, reviews: 2893,
    claimed: 82,
    blurb: 'Fully articulated aluminium arms, springs and all. Positions itself exactly where you need it and stays there for decades.',
  },
];

const byKey = Object.fromEntries(CATALOG.map((p) => [p.key, p]));
const fmt = (n) => '$' + n.toLocaleString('en-US');
const pctOff = (p) => Math.round((1 - p.price / p.was) * 100);
const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- deal cards ---------- */

function starRow(rating) {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function renderCards() {
  const grid = document.getElementById('dealGrid');
  grid.innerHTML = CATALOG.map((p) => `
    <article class="card reveal" data-product="${p.key}">
      <div class="card__media card__media--loading js-open-viewer" data-product="${p.key}" role="button" tabindex="0"
           aria-label="Open ${p.name} in the 3D viewer">
        <img alt="${p.name} — 3D render" data-thumb="${p.key}" hidden />
        <span class="badge card__badge">−${pctOff(p)}%</span>
        <span class="card__3d">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 17 6v8l-7 3.5L3 14V6l7-3.5Zm0 0V10m0 0 7-4M10 10 3 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          3D
        </span>
      </div>
      <div class="card__body">
        <p class="card__brand">${p.brand}</p>
        <h3 class="card__name">${p.name}</h3>
        <div class="card__rating">
          <span class="card__stars" aria-hidden="true">${starRow(p.rating)}</span>
          <span>${p.rating} · ${p.reviews.toLocaleString('en-US')} reviews</span>
        </div>
        <div class="card__pricing">
          <span class="card__price">${fmt(p.price)}</span>
          <s class="card__was">${fmt(p.was)}</s>
        </div>
        <div class="card__meter">
          <div class="card__meter-bar"><div class="card__meter-fill" style="width:${p.claimed}%"></div></div>
          <p class="card__meter-label"><strong>${p.claimed}% claimed</strong> — moving fast</p>
        </div>
        <div class="card__actions">
          <button class="btn btn--ghost js-open-viewer" data-product="${p.key}">
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M10 2.5 17 6v8l-7 3.5L3 14V6l7-3.5Zm0 0V10m0 0 7-4M10 10 3 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            View in 3D
          </button>
          <button class="btn btn--primary js-claim" data-product="${p.key}">Claim deal</button>
        </div>
      </div>
    </article>
  `).join('');

  // keyboard access for the media area
  grid.querySelectorAll('.card__media').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });
}

/* ---------- countdown to local midnight ---------- */

function startCountdowns() {
  const els = document.querySelectorAll('.js-countdown');
  const tick = () => {
    const now = new Date();
    const end = new Date(now); end.setHours(24, 0, 0, 0);
    let s = Math.max(0, Math.floor((end - now) / 1000));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    const text = `${h}:${m}:${sec}`;
    els.forEach((el) => { el.textContent = text; });
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- count-up hero stats ---------- */

function startCountups() {
  const els = document.querySelectorAll('.js-countup');
  const animate = (el) => {
    const target = +el.dataset.target;
    const suffix = el.dataset.suffix || '';
    if (prefersReducedMotion) { el.textContent = target + suffix; return; }
    const t0 = performance.now();
    const dur = 1400;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(target * eased) + suffix;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { animate(e.target); io.unobserve(e.target); }
    });
  }, { threshold: 0.6 });
  els.forEach((el) => io.observe(el));
}

/* ---------- reveal on scroll ---------- */

function startReveals() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
}

/* ---------- header ---------- */

function initHeader() {
  const header = document.querySelector('.header');
  addEventListener('scroll', () => {
    header.classList.toggle('is-scrolled', scrollY > 8);
  }, { passive: true });

  const burger = document.querySelector('.header__burger');
  const menu = document.getElementById('mobileMenu');
  burger.addEventListener('click', () => {
    const open = burger.getAttribute('aria-expanded') === 'true';
    burger.setAttribute('aria-expanded', String(!open));
    menu.hidden = open;
    if (open) delete menu.dataset.open; else menu.dataset.open = '';
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) burger.click();
  });
}

/* ---------- newsletter ---------- */

function initNewsletter() {
  const form = document.querySelector('.js-newsletter');
  const ok = document.querySelector('.cta__ok');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    if (!input.value || !input.checkValidity()) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    form.hidden = true;
    ok.hidden = false;
  });
}

/* ---------- 3D: thumbnails, hero stage, viewer modal ---------- */

let three = null;           // lazy module handle
let heroViewer = null;
let modalViewer = null;
let lastFocus = null;

async function load3D() {
  if (three) return three;
  three = await import('./viewer3d.js');
  return three;
}

async function initThumbnails() {
  try {
    const { renderThumbnail } = await load3D();
    // Render each card's 3D thumbnail only as it approaches the viewport —
    // generating all six at page load blocks the main thread for seconds
    // on phones. Renders queue one-at-a-time to keep scrolling responsive.
    let queue = Promise.resolve();
    const renderOne = (img) => {
      queue = queue.then(() => new Promise((done) => {
        requestAnimationFrame(() => {
          try {
            img.src = renderThumbnail(img.dataset.thumb, 640, 544);
            img.hidden = false;
          } catch (err) {
            console.error('thumbnail failed:', img.dataset.thumb, err);
          }
          img.closest('.card__media').classList.remove('card__media--loading');
          setTimeout(done, 40); // breathe between renders
        });
      }));
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { io.unobserve(e.target); renderOne(e.target); }
      });
    }, { rootMargin: '400px 0px' });
    document.querySelectorAll('img[data-thumb]').forEach((img) => io.observe(img));
  } catch (err) {
    console.error('3D module failed to load — falling back to 2D:', err);
    document.body.classList.add('no-3d');
    document.querySelectorAll('.card__media--loading').forEach((el) => el.classList.remove('card__media--loading'));
    document.querySelectorAll('.card__3d, .stage__hint, .stage__cta').forEach((el) => { el.style.display = 'none'; });
  }
}

async function initHeroStage() {
  try {
    const { ProductViewer } = await load3D();
    const canvas = document.getElementById('heroCanvas');
    heroViewer = new ProductViewer(canvas, 'crystal-chandelier', {
      interactive: true,
      autoRotate: !prefersReducedMotion,
    });
    heroViewer.setTemperature(2900);
    heroViewer.setIntensity(0.85);
  } catch (err) {
    console.error('hero 3D failed:', err);
  }
}

/* Viewer modal */

const viewerEl = document.getElementById('viewer');
const tempRange = document.getElementById('tempRange');
const brightRange = document.getElementById('brightRange');
const powerSwitch = document.getElementById('powerSwitch');
const rotateSwitch = document.getElementById('rotateSwitch');
const roomSwitch = document.getElementById('roomSwitch');

function setSwitch(btn, on) {
  btn.setAttribute('aria-checked', String(on));
}
function isOn(btn) {
  return btn.getAttribute('aria-checked') === 'true';
}

async function openViewer(key) {
  const p = byKey[key];
  if (!p) return;
  lastFocus = document.activeElement;

  document.getElementById('viewerBrand').textContent = p.brand;
  document.getElementById('viewerTitle').textContent = p.name;
  document.getElementById('viewerPrice').textContent = fmt(p.price);
  document.getElementById('viewerWas').textContent = fmt(p.was);
  document.getElementById('viewerOff').textContent = `−${pctOff(p)}%`;
  document.getElementById('viewerBlurb').textContent = p.blurb;

  viewerEl.hidden = false;
  document.body.classList.add('viewer-open');

  // reset controls to defaults
  tempRange.value = 3000;
  brightRange.value = 80;
  setSwitch(powerSwitch, true);
  setSwitch(rotateSwitch, !prefersReducedMotion);
  setSwitch(roomSwitch, true);
  document.getElementById('powerState').textContent = 'On';
  document.getElementById('tempValue').textContent = '3000K';
  document.getElementById('brightValue').textContent = '80%';
  document.getElementById('roomState').textContent = 'In a room';

  const stage = document.querySelector('.viewer__stage');
  stage.classList.add('is-loading');
  try {
    const { ProductViewer } = await load3D();
    if (modalViewer) { modalViewer.dispose(); modalViewer = null; }
    const canvas = document.getElementById('viewerCanvas');
    // let the spinner paint before the (synchronous) scene build blocks the thread
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    modalViewer = new ProductViewer(canvas, key, {
      interactive: true,
      autoRotate: !prefersReducedMotion,
      room: true,
    });
    modalViewer.setTemperature(3000);
    modalViewer.setIntensity(0.8);
    // pause hero rendering while the modal owns the GPU
    if (heroViewer) heroViewer.setAutoRotate(false);
  } catch (err) {
    console.error('viewer failed:', err);
  } finally {
    stage.classList.remove('is-loading');
  }

  document.querySelector('.viewer__close').focus();
}

function closeViewer() {
  viewerEl.hidden = true;
  document.body.classList.remove('viewer-open');
  if (modalViewer) { modalViewer.dispose(); modalViewer = null; }
  if (heroViewer && !prefersReducedMotion) heroViewer.setAutoRotate(true);
  if (lastFocus) lastFocus.focus();
}

function initViewerControls() {
  document.addEventListener('click', (e) => {
    const open = e.target.closest('.js-open-viewer');
    if (open) { openViewer(open.dataset.product); return; }
    if (e.target.closest('.js-viewer-close')) { closeViewer(); return; }
    const claim = e.target.closest('.js-claim, .viewer__claim');
    if (claim) {
      claim.textContent = 'Added to cart ✓';
      claim.disabled = true;
      setTimeout(() => { claim.textContent = 'Claim this deal'; claim.disabled = false; }, 2200);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !viewerEl.hidden) closeViewer();
    // rudimentary focus trap
    if (e.key === 'Tab' && !viewerEl.hidden) {
      const focusables = viewerEl.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  roomSwitch.addEventListener('click', () => {
    const next = !isOn(roomSwitch);
    setSwitch(roomSwitch, next);
    document.getElementById('roomState').textContent = next ? 'In a room' : 'Studio';
    if (modalViewer && typeof modalViewer.setRoom === 'function') modalViewer.setRoom(next);
  });

  powerSwitch.addEventListener('click', () => {
    const next = !isOn(powerSwitch);
    setSwitch(powerSwitch, next);
    document.getElementById('powerState').textContent = next ? 'On' : 'Off';
    if (modalViewer) modalViewer.setPower(next);
  });

  rotateSwitch.addEventListener('click', () => {
    const next = !isOn(rotateSwitch);
    setSwitch(rotateSwitch, next);
    if (modalViewer) modalViewer.setAutoRotate(next);
  });

  tempRange.addEventListener('input', () => {
    const k = +tempRange.value;
    document.getElementById('tempValue').textContent = `${k}K`;
    if (modalViewer) modalViewer.setTemperature(k);
  });

  brightRange.addEventListener('input', () => {
    const v = +brightRange.value;
    document.getElementById('brightValue').textContent = `${v}%`;
    if (modalViewer) modalViewer.setIntensity(v / 100);
  });

  addEventListener('resize', () => {
    if (heroViewer) heroViewer.resize();
    if (modalViewer) modalViewer.resize();
  });
}

/* ---------- boot ---------- */

renderCards();
startCountdowns();
startCountups();
startReveals();
initHeader();
initNewsletter();
initViewerControls();
initThumbnails();
initHeroStage();
