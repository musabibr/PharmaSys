/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tests/tsconfig.json' }],
  },
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Integration + REST suites boot a real better-sqlite3 database, but the
  // native binding is built for Electron's ABI (postinstall), so Node-based
  // Jest cannot load it — see issues.md #40 and tests/helpers/test-db.ts.
  // Run them explicitly after `npm rebuild better-sqlite3`:
  //   npx jest tests/integration tests/rest --testPathIgnorePatterns=[]
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/', '<rootDir>/tests/rest/'],
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@transport/(.*)$': '<rootDir>/src/transport/$1',
    '^@platform/(.*)$': '<rootDir>/src/platform/$1',
  },
  collectCoverageFrom: [
    'src/core/**/*.ts',
    'src/transport/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
