module.exports = {
  ...require('./jest.config.cjs'),
  collectCoverage: true,
  collectCoverageFrom: ['src/infrastructure/**/*.ts', '!src/**/*.spec.ts'],
  coverageDirectory: 'coverage/infrastructure',
};
