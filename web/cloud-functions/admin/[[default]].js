import { getStore } from '@edgeone/pages-blob';
import { createAdminHandler } from '../../lib/admin/handler.mjs';
import { createStatusPublisher } from '../../lib/server-status.mjs';

// Mounted at /admin/*. The page itself (/admin/, app.js, styles.css) is a public
// static asset copied from web/admin by build.mjs; this function serves only
// /admin/auth/* and /admin/api/*. Administrator refreshes publish straight to
// the same Blob snapshot that /api/server-status reads for visitors.
export const onRequest = createAdminHandler({ publish: createStatusPublisher({ getStore }) });
