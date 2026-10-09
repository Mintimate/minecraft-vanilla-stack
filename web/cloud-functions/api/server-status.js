import { getStore } from '@edgeone/pages-blob';
import { createOnlineProbe } from '../../lib/admin/handler.mjs';
import { createStatusHandler } from '../../lib/server-status.mjs';

// Visitors read a shared Blob snapshot; when it expires, one request refreshes
// it by reading the online list over RCON from this same function runtime.
export const onRequest = createStatusHandler({ getStore, probe: createOnlineProbe() });
