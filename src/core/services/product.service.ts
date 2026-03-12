import type { ProductRepository }  from '../repositories/sql/product.repository';
import type { CategoryRepository } from '../repositories/sql/category.repository';
import type { BatchRepository }    from '../repositories/sql/batch.repository';
import type { EventBus }           from '../events/event-bus';
import type { Product, ProductFilters, PaginatedResult, CreateProductInput, UpdateProductInput, BulkCreateProductInput } from '../types/models';
import { Validate }                from '../common/validation';
import { NotFoundError, ValidationError } from '../types/errors';
import { Money }                   from '../common/money';

export class ProductService {
  constructor(
    private readonly repo:     ProductRepository,
    private readonly catRepo:  CategoryRepository,
    private readonly batchRepo: BatchRepository,
    private readonly bus:      EventBus
  ) {}

  async getAll(search?: string): Promise<Product[]> {
    return search ? await this.repo.search(search) : await this.repo.getAll();
  }

  async getList(filters: ProductFilters): Promise<PaginatedResult<Product>> {
    return await this.repo.getList(filters);
  }

  async getById(id: number): Promise<Product> {
    const p = await this.repo.getById(id);
    if (!p) throw new NotFoundError('Product', id);
    return p;
  }

  async search(query: string): Promise<Product[]> {
    if (!query?.trim()) return [];
    return await this.repo.search(query.trim());
  }

  async findByBarcode(barcode: string): Promise<Product | undefined> {
    if (!barcode?.trim()) return undefined;
    return await this.repo.findByBarcode(barcode.trim());
  }

  async create(data: CreateProductInput, userId: number): Promise<Product> {
    const name = Validate.requiredString(data.name, 'Product name', 200);

    let categoryId: number | null = null;
    if (data.category_id) {
      const cat = await this.catRepo.getById(data.category_id);
      if (!cat) throw new NotFoundError('Category', data.category_id);
      categoryId = data.category_id;
    }

    if (data.conversion_factor !== undefined) {
      Validate.positiveInteger(data.conversion_factor, 'Conversion factor');
    }

    const result = await this.repo.create({ ...data, name }, categoryId);
    const newId = result.lastInsertRowid as number;

    this.bus.emit('entity:mutated', {
      action: 'CREATE_PRODUCT', table: 'products',
      recordId: newId, userId,
      newValues: { name },
    });

    return await this.getById(newId);
  }

  async update(id: number, data: UpdateProductInput, userId: number): Promise<Product> {
    Validate.id(id);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('Product', id);

    if (data.category_id !== undefined && data.category_id !== null) {
      const cat = await this.catRepo.getById(data.category_id);
      if (!cat) throw new NotFoundError('Category', data.category_id);
    }

    await this.repo.update(id, data);

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_PRODUCT', table: 'products',
      recordId: id, userId,
      oldValues: { name: existing.name }, newValues: data as Record<string, unknown>,
    });

    return await this.getById(id);
  }

  async delete(id: number, userId: number): Promise<void> {
    Validate.id(id);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('Product', id);

    if (await this.repo.hasActiveBatches(id)) {
      throw new ValidationError('Cannot delete product with active stock. Sell or adjust all batches first.', 'id');
    }

    await this.repo.softDelete(id);

    this.bus.emit('entity:mutated', {
      action: 'DELETE_PRODUCT', table: 'products',
      recordId: id, userId,
      oldValues: { name: existing.name },
    });
  }

  async bulkCreate(
    items: BulkCreateProductInput[],
    userId: number
  ): Promise<Array<{ success: boolean; name: string; error?: string }>> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError('Items array is required and must not be empty', 'items');
    }
    const results = await this.repo.bulkCreate(items);
    const successCount = results.filter(r => r.success).length;
    if (successCount > 0) {
      this.bus.emit('entity:mutated', {
        action: 'BULK_CREATE_PRODUCTS', table: 'products',
        recordId: null, userId,
        newValues: { count: successCount },
      });
    }
    return results;
  }
}
