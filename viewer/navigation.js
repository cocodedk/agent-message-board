function idFromUrl(href, name) {
  const url = new URL(href);
  const value = url.searchParams.get(name);
  if (value === null) return null;
  const id = Number(value);
  if (url.searchParams.getAll(name).length !== 1 || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(id)) {
    throw new Error(`The ${name} in the URL must be a positive integer.`);
  }
  return id;
}
export const subjectFromUrl = (href) => idFromUrl(href, 'subject');
export const threadFromUrl = (href) => idFromUrl(href, 'thread');

export function bindNavigation(reader, browser = window) {
  const changed = reader.changed;
  let loadingUrl = true;
  let version = 0;
  let moving = false;
  const scrollKey = 'agentboard_scroll';
  const views = new Map();
  let serial = browser.history.state?.[scrollKey]?.key ?? 0;
  let lastReady = reader.snapshot();
  const position = () => ({x: browser.scrollX ?? 0, y: browser.scrollY ?? 0});
  const savedPosition = () => {
    const value = browser.history.state?.[scrollKey];
    return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? value : {x: 0, y: 0, key: ++serial};
  };
  let point = savedPosition();
  const save = () => browser.history.replaceState?.({...browser.history.state, [scrollKey]: point}, '');
  const details = () => browser.document?.getElementById('subject-details');
  const remember = () => {
    views.set(point.key, {state: lastReady, descriptionOpen: details()?.open ?? false});
    if (views.size > 50) views.delete(views.keys().next().value);
  };
  if ('scrollRestoration' in browser.history) browser.history.scrollRestoration = 'manual';
  save();
  browser.addEventListener('scroll', () => {
    if (!loadingUrl && !moving) { point = {...point, ...position()}; save(); remember(); }
  }, {passive: true});
  reader.changed = (current) => {
    if (!loadingUrl && !moving) { point = {...point, ...position()}; save(); remember(); }
    if (current.busy.messages) moving = true;
    changed(current);
    if (!current.busy.messages) lastReady = current.snapshot();
    if (loadingUrl || current.busy.messages) return;
    const selected = current.state.subject?.id ?? null;
    const thread = current.state.thread?.id ?? null;
    const url = new URL(browser.location.href);
    const matches = (name, id) => url.searchParams.get(name) === (id === null ? null : String(id));
    if (matches('subject', selected) && matches('thread', thread)) { moving = false; return; }
    for (const [name, id] of [['subject', selected], ['thread', thread]]) {
      if (id === null) url.searchParams.delete(name); else url.searchParams.set(name, String(id));
    }
    save();
    point = {x: 0, y: 0, key: ++serial};
    browser.history.pushState({[scrollKey]: point}, '', url.href);
    version += 1;
    browser.scrollTo?.(point.x, point.y);
    moving = false;
  };
  const load = async () => {
    const current = ++version;
    loadingUrl = true;
    moving = true;
    const destination = savedPosition();
    try {
      const id = subjectFromUrl(browser.location.href);
      const thread = threadFromUrl(browser.location.href);
      if (id === null && thread !== null) throw new Error('A thread URL must include a subject.');
      const cached = views.get(destination.key);
      if (cached && (cached.state.subject?.id ?? null) === id && (cached.state.thread?.id ?? null) === thread) {
        for (const scope of ['subjects', 'messages', 'context']) reader.cancel(scope);
        Object.assign(reader.state, cached.state, {description_open: cached.descriptionOpen}); reader.emit();
        if (details()) details().open = cached.descriptionOpen;
        return;
      }
      if (id === null) { reader.closeSubject(); return; }
      if (reader.state.subject?.id !== id || (thread === null && (reader.state.thread || reader.state.message_query || reader.busy.messages))) {
        await reader.openSubject(id);
      }
      if (current !== version) return;
      if (thread !== null && reader.state.thread?.id !== thread) await reader.openThread(thread);
    } catch (error) {
      if (current === version && error.name === 'AbortError') {
        loadingUrl = false; moving = false; reader.emit();
      }
      if (current === version && error.name !== 'AbortError') {
        reader.closeSubject();
        reader.errors.messages = error.message; reader.emit();
      }
    } finally {
      if (current === version) {
        const restore = () => {
          if (current !== version) return;
          point = destination; save(); browser.scrollTo?.(point.x, point.y);
          loadingUrl = false; moving = false;
        };
        if (browser.requestAnimationFrame) browser.requestAnimationFrame(restore); else restore();
      }
    }
  };
  browser.addEventListener('popstate', () => { void load().catch(() => {}); });
  return load;
}
