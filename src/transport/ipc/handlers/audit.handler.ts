import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { AuditLogFilters }  from '../../../core/types/models';

export function registerAuditHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('audit:getAll', async (_user, filters?: AuditLogFilters) => {
    return await services.audit.getAll(filters ?? {});
  }, { adminOnly: true });

  router.handle('audit:purge', async (_user, olderThanDays: number) => {
    await services.audit.purgeOlderThan(olderThanDays);
    return { ok: true };
  }, { adminOnly: true });
}
