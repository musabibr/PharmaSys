/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tests/tsconfig.json' }],
  },
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
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
