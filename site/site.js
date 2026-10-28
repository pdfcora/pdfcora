// PDFCora site: tabs, copy buttons, navigation, scroll effects. No dependencies.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tabs (WAI-ARIA tabs pattern, arrow keys wrap)
for (const group of document.querySelectorAll('[data-tabs]')) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
  const select = (index, focus) => {
    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[i].hidden = !active;
    });
    if (focus) tabs[index].focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i, false));
    tab.addEventListener('keydown', (event) => {
      const last = tabs.length - 1;
      const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(next, true);
    });
  });
  select(Math.max(0, tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')), false);
}

// Copy buttons copy the visible code in their card
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const card = button.closest('.code-card');
    const code = card.querySelector('[role="tabpanel"]:not([hidden]) code') || card.querySelector('code');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
      button.setAttribute('data-copied', '');
    } catch {
      button.textContent = 'Press ⌘C';
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    setTimeout(() => { button.textContent = 'Copy'; button.removeAttribute('data-copied'); }, 1600);
  });
}

// Mobile navigation
const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('site-nav');
if (toggle && nav) {
  const setOpen = (open) => { toggle.setAttribute('aria-expanded', String(open)); nav.toggleAttribute('data-open', open); };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (event) => { if (event.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setOpen(false); toggle.focus(); }
  });
}

// Header gains a background once the page scrolls
const header = document.querySelector('.site-header');
const onScroll = () => header.toggleAttribute('data-scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();


// Reveal on scroll, staggering siblings. Without IntersectionObserver, show everything.
const reveals = [...document.querySelectorAll('.reveal')];
const show = (el) => el.classList.add('in');
if (!('IntersectionObserver' in window) || reduceMotion) {
  reveals.forEach((el) => el.classList.add('in'));
} else {
  reveals.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
    if (siblings.length > 1) el.style.setProperty('--d', `${Math.min(siblings.indexOf(el), 6) * 70}ms`);
  });
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      show(entry.target);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  reveals.forEach((el) => observer.observe(el));
}
