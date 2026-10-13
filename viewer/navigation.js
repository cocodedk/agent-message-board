export function subjectFromUrl(href) {
  const value = new URL(href).searchParams.get('subject');
  if (value === null) return null;
  const id = Number(value);
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(id)) {
    throw new Error('The subject in the URL must be a positive integer.');
  }
  return id;
}

export function bindNavigation(reader, browser = window) {
  const changed = reader.changed;
  reader.changed = (current) => {
    changed(current);
    const selected = current.state.subject?.id;
    if (selected === undefined) return;
    const url = new URL(browser.location.href);
    if (url.searchParams.get('subject') === String(selected)) return;
    url.searchParams.set('subject', String(selected));
    browser.history.pushState(null, '', url.href);
  };
  const load = async () => {
    let id;
    try { id = subjectFromUrl(browser.location.href); }
    catch (error) {
      reader.closeSubject(); reader.errors.messages = error.message; reader.emit();
      return;
    }
    if (id === null) { reader.closeSubject(); return; }
    if (reader.state.subject?.id !== id) await reader.openSubject(id);
  };
  browser.addEventListener('popstate', () => { void load().catch(() => {}); });
  return load;
}
