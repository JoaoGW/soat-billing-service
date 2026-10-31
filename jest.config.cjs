module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.spec.ts'],
  coverageThreshold: { global: { statements: 80, branches: 80, functions: 80, lines: 80 } },
};
