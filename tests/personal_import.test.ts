import { describe, expect, it, beforeEach } from 'vitest';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { importBackup, BACKUP_FORMAT, BACKUP_VERSION, type BackupFile } from '../src/lib/backup';

describe('Backup Data Import', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('restores synthetic fixture cleanly', async () => {
    const fixture: BackupFile = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      userId: 12345678,
      profile: {
        name: 'Test User',
        base_currency: 'EUR',
        timezone: 'UTC',
      },
      counts: {
        task_categories: 1,
        tasks: 1,
        accounts: 1,
      },
      tables: {
        task_categories: [
          { id: 1, name: 'Work', color: '#ff0000', icon: 'briefcase', position: 1 },
        ],
        tasks: [
          {
            id: 1,
            user_id: 12345678,
            title: 'Sample Task',
            status: 'todo',
            category_id: 1,
          },
        ],
        accounts: [
          {
            id: 1,
            user_id: 12345678,
            name: 'Main Account',
            currency: 'EUR',
            balance_cents: 100000,
            account_type: 'checking',
            is_active: 1,
          },
        ],
      },
    };

    const res = await importBackup(12345678, fixture, { mode: 'replace' });
    expect(res.userId).toBe(12345678);
    expect(res.tables.task_categories.inserted).toBe(1);
    expect(res.tables.tasks.inserted).toBe(1);
    expect(res.tables.accounts.inserted).toBe(1);
  });
});
