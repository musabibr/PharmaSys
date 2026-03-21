import type { CategoryRepository } from '../repositories/sql/category.repository';
import type { AuditRepository }    from '../repositories/sql/audit.repository';
import type { EventBus }            from '../events/event-bus';
import type { Category }            from '../types/models';
import { Validate }                 from '../common/validation';
import { NotFoundError }            from '../types/errors';

export class CategoryService {
  constructor(
    private readonly repo:  CategoryRepository,
    private readonly audit: AuditRepository,
    private readonly bus:   EventBus
  ) {}

  async getAll(): Promise<Category[]> {
    return await this.repo.getAll();
  }

  async getById(id: number): Promise<Category> {
    const cat = await this.repo.getById(id);
    if (!cat) throw new NotFoundError('Category', id);
    return cat;
  }

  async create(name: string, userId: number): Promise<Category> {
    const cleaned = Validate.requiredString(name, 'Category name', 100);

    const existing = await this.repo.findByName(cleaned);
    if (existing) return existing; // idempotent

    const result = await this.repo.create(cleaned);
    this.bus.emit('entity:mutated', {
      action: 'CREATE_CATEGORY', table: 'categories',
      recordId: result.lastInsertRowid, userId,
      newValues: { name: cleaned },
    });
    return (await this.repo.getById(result.lastInsertRowid))!;
  }

  async update(id: number, name: string, userId: number): Promise<Category> {
    Validate.id(id);
    const cleaned = Validate.requiredString(name, 'Category name', 100);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('Category', id);

    await this.repo.update(id, cleaned);
    this.bus.emit('entity:mutated', {
      action: 'UPDATE_CATEGORY', table: 'categories',
      recordId: id, userId,
      oldValues: { name: existing.name }, newValues: { name: cleaned },
    });
    return (await this.repo.getById(id))!;
  }

  /** Find by name, create if not found. Used by bulk import. */
  async findOrCreate(name: string, userId: number): Promise<Category> {
    const cleaned = Validate.requiredString(name, 'Category name', 100);
    const existing = await this.repo.findByName(cleaned);
    if (existing) return existing;
    return await this.create(cleaned, userId);
  }
}
