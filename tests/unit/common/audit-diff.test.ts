import { diffValues } from '@core/common/audit-diff';

describe('diffValues', () => {
  it('reports only the fields that actually changed', () => {
    const before = { name: 'Panadol', barcode: '123', min_stock_level: 5 };
    const patch  = { name: 'Panadol Extra', barcode: '123' };

    const { oldValues, newValues } = diffValues(before, patch);

    expect(oldValues).toEqual({ name: 'Panadol' });
    expect(newValues).toEqual({ name: 'Panadol Extra' });
  });

  it('captures the previous value for every changed field', () => {
    const before = { selling_price_parent: 3000, cost_per_parent: 2000 };
    const patch  = { selling_price_parent: 4500, cost_per_parent: 2500 };

    const { oldValues, newValues } = diffValues(before, patch);

    expect(oldValues).toEqual({ selling_price_parent: 3000, cost_per_parent: 2000 });
    expect(newValues).toEqual({ selling_price_parent: 4500, cost_per_parent: 2500 });
  });

  it('skips undefined patch values (field not supplied)', () => {
    const before = { name: 'A', barcode: '1' };
    const patch  = { name: 'B', barcode: undefined };

    const { oldValues, newValues } = diffValues(before, patch);

    expect(oldValues).toEqual({ name: 'A' });
    expect(newValues).toEqual({ name: 'B' });
  });

  it('ignores version and timestamp columns by default', () => {
    const before = { version: 1, updated_at: 'x', quantity_base: 10 };
    const patch  = { version: 2, updated_at: 'y', quantity_base: 20 };

    const { oldValues, newValues } = diffValues(before, patch);

    expect(oldValues).toEqual({ quantity_base: 10 });
    expect(newValues).toEqual({ quantity_base: 20 });
  });

  it('normalizes a missing previous value to null rather than dropping the key', () => {
    const before = { name: 'A' };
    const patch  = { barcode: '999' };

    const { oldValues, newValues } = diffValues(before, patch);

    expect(oldValues).toEqual({ barcode: null });
    expect(newValues).toEqual({ barcode: '999' });
  });

  it('reports a no-op patch as unchanged', () => {
    const { oldValues, newValues, unchanged } = diffValues(
      { name: 'A', barcode: '1' },
      { name: 'A', barcode: '1' },
    );

    expect(oldValues).toEqual({});
    expect(newValues).toEqual({});
    expect(unchanged).toBe(true);
  });

  it('reports a real change as changed', () => {
    expect(diffValues({ a: 1 }, { a: 2 }).unchanged).toBe(false);
  });

  it('distinguishes 0 and null from "not supplied"', () => {
    const { oldValues, newValues } = diffValues(
      { discount: 20, note: 'x' },
      { discount: 0, note: null },
    );

    expect(oldValues).toEqual({ discount: 20, note: 'x' });
    expect(newValues).toEqual({ discount: 0, note: null });
  });

  it('honours a custom ignore list', () => {
    const { newValues } = diffValues({ a: 1, b: 1 }, { a: 2, b: 2 }, ['b']);
    expect(newValues).toEqual({ a: 2 });
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(diffValues(null, null)).toEqual({ oldValues: {}, newValues: {}, unchanged: true });
    expect(diffValues(undefined, { a: 1 })).toEqual({
      oldValues: { a: null }, newValues: { a: 1 }, unchanged: false,
    });
  });
});
