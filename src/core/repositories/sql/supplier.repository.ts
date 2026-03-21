import type { BaseRepository } from './base.repository';
import type { ISupplierRepository } from '../../types/repositories';
import type { Supplier, CreateSupplierInput, UpdateSupplierInput } from '../../types/models';
import type { RunResult } from '../../types/repositories';

export class SupplierRepository implements ISupplierRepository {
  constructor(private readonly base: BaseRepository) {}

  async getAll(includeInactive = false): Promise<Supplier[]> {
    const where = includeInactive ? '' : 'WHERE is_active = 1';
    return await this.base.getAll<Supplier>(
      `SELECT * FROM suppliers ${where} ORDER BY name`
    );
  }

  async getById(id: number): Promise<Supplier | undefined> {
    return await this.base.getOne<Supplier>(
      `SELECT * FROM suppliers WHERE id = ?`,
      [id]
    );
  }

  async create(data: CreateSupplierInput): Promise<RunResult> {
    return await this.base.runImmediate(
      `INSERT INTO suppliers (name, phone, address, notes) VALUES (?, ?, ?, ?)`,
      [data.name, data.phone ?? null, data.address ?? null, data.notes ?? null]
    );
  }

  async update(id: number, data: UpdateSupplierInput): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];

    if (data.name !== undefined)      { fields.push('name = ?');      params.push(data.name); }
    if (data.phone !== undefined)     { fields.push('phone = ?');     params.push(data.phone); }
    if (data.address !== undefined)   { fields.push('address = ?');   params.push(data.address); }
    if (data.notes !== undefined)     { fields.push('notes = ?');     params.push(data.notes); }
    if (data.is_active !== undefined) { fields.push('is_active = ?'); params.push(data.is_active ? 1 : 0); }

    if (fields.length === 0) return;

    fields.push("updated_at = datetime('now')");
    params.push(id);

    await this.base.runImmediate(
      `UPDATE suppliers SET ${fields.join(', ')} WHERE id = ?`,
      params
    );
  }
}
