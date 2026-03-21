import type { BaseRepository } from './base.repository';
import type { ICategoryRepository, RunResult } from '../../types/repositories';
import type { Category } from '../../types/models';

export class CategoryRepository implements ICategoryRepository {
  constructor(private readonly base: BaseRepository) {}

  async getAll(): Promise<Category[]> {
    return await this.base.getAll<Category>(
      `SELECT id, name, created_at FROM categories ORDER BY name`
    );
  }

  async getById(id: number): Promise<Category | undefined> {
    return await this.base.getOne<Category>(
      `SELECT id, name, created_at FROM categories WHERE id = ?`,
      [id]
    );
  }

  async findByName(name: string): Promise<Category | undefined> {
    return await this.base.getOne<Category>(
      `SELECT id, name, created_at FROM categories WHERE name = ?`,
      [name]
    );
  }

  async create(name: string) {
    return await this.base.runImmediate(
      `INSERT INTO categories (name) VALUES (?)`,
      [name]
    );
  }

  async update(id: number, name: string): Promise<void> {
    await this.base.runImmediate(
      `UPDATE categories SET name = ? WHERE id = ?`,
      [name, id]
    );
  }
}
