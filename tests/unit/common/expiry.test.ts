import { TODAY_SQL, todayLocalISO } from '@core/common/expiry';

describe('expiry clock helpers (audit F4)', () => {
  describe('TODAY_SQL', () => {
    it('is the localtime form of date(\'now\'), not the UTC default', () => {
      expect(TODAY_SQL).toBe("date('now','localtime')");
    });
  });

  describe('todayLocalISO', () => {
    it('returns today in YYYY-MM-DD, matching the local calendar date', () => {
      const now = new Date();
      const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      expect(todayLocalISO()).toBe(expected);
    });

    it('matches the YYYY-MM-DD shape', () => {
      expect(todayLocalISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
