(() => {
  const key = 'resonate.theme', system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (['system', 'light', 'dark'].includes(saved)) preference = saved; } catch { /* Storage can be disabled. */ }
  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    document.documentElement.dataset.themePreference = preference;
    window.dispatchEvent(new CustomEvent('resonate:themechange'));
  }
  window.resonateTheme = {
    get: () => preference,
    set(value) {
      if (!['system', 'light', 'dark'].includes(value)) return;
      preference = value; try { localStorage.setItem(key, value); } catch { /* Keep the in-memory preference. */ }
      apply();
    }
  };
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key) return;
    preference = ['light', 'dark'].includes(event.newValue) ? event.newValue : 'system'; apply();
  });
  apply();
})();
