import type { App } from '../../app';
import { h } from '../../lib/dom';
import { inManuscript, statusSymbol } from '../../lib/roles';
import { type FolderNode, docsInFolder, folderPath } from '../../lib/tree';
import type { DocSummary } from '../../types';
import { contextProject } from './context';

/** Manuscript documents of a project that have an in-story date. */
export function datedScenes(app: App, project: FolderNode): DocSummary[] {
  return docsInFolder(project)
    .filter((d) => inManuscript(app.kind, d) && !!d.story_date)
    .sort((a, b) => (a.story_date! < b.story_date! ? -1 : a.story_date! > b.story_date! ? 1 : a.sort_order - b.sort_order));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function storyDay(date: string): string {
  const m = date.match(/^(-?\d+)-(\d\d)-(\d\d)/);
  if (!m) return date;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Scenes in in-story order. Only offered when at least two scenes have dates. */
export function openTimeline(app: App, start?: FolderNode | null): void {
  const project = contextProject(app, start);
  if (!project) return;
  const scenes = datedScenes(app, project);
  const all = docsInFolder(project).filter((d) => inManuscript(app.kind, d));
  const list = h('div', { class: 'timeline' });
  let day = '';
  for (const d of scenes) {
    const thisDay = d.story_date!.slice(0, d.story_date!.indexOf('T') > 0 ? d.story_date!.indexOf('T') : undefined);
    if (thisDay !== day) {
      day = thisDay;
      list.appendChild(h('h2', { class: 'timeline-day' }, storyDay(thisDay)));
    }
    const time = d.story_date!.includes('T') ? d.story_date!.split('T')[1] : '';
    const path = folderPath(app.sidebar.root, d.folder_id).slice(1).map((f) => f.folder.name).join(' / ');
    const symbol = statusSymbol(app.kind, d.status);
    list.appendChild(h('button', { type: 'button', class: 'timeline-item', onclick: () => void app.jumpTo(d.id) },
      h('span', { class: 'timeline-when' }, time),
      h('span', { class: 'timeline-what' },
        h('span', { class: 'hit-title' }, symbol ? `${symbol} ` : '', d.title || 'Untitled'),
        h('span', { class: 'item-meta' }, [path, d.pov ? `POV: ${d.pov}` : ''].filter(Boolean).join(' · ')),
        d.synopsis ? h('span', { class: 'hit-snippet' }, d.synopsis) : null)));
  }
  const undated = all.length - scenes.length;
  const screen = h('section', { class: 'screen', 'aria-label': 'Timeline' },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'quiet', onclick: () => app.back() }, '‹ Back to writing'),
      h('h1', null, `Timeline · ${project.folder.name}`)),
    undated ? h('p', { class: 'quiet-text' }, `${undated} ${app.kind.item_label.toLowerCase()}${undated === 1 ? ' has' : 's have'} no in-story date and ${undated === 1 ? 'is' : 'are'} not shown.`) : null,
    list);
  app.openScreen(screen);
}
