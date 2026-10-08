import type { App } from '../app';
import { diaryFeature } from './diary';
import { exportFeature } from './exporting';
import { snapshotsFeature } from './snapshots';

/** Optional features, registered in order. */
export function install(app: App): void {
  app.use(diaryFeature);
  app.use(snapshotsFeature);
  app.use(exportFeature);
}
