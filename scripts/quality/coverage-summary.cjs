/* Publica no resumo do job e como anotação os totais de cobertura informados. */
const fs = require('node:fs');

const pairs = process.argv.slice(2);
if (pairs.length === 0 || pairs.length % 2 !== 0) throw new Error('Uso: coverage-summary.cjs <coverage-summary.json> <escopo> ...');
const metrics = ['statements', 'branches', 'functions', 'lines'];
const rows = [];
for (let index = 0; index < pairs.length; index += 2) {
  const total = JSON.parse(fs.readFileSync(pairs[index], 'utf8')).total;
  const values = metrics.map(metric => total[metric].pct.toFixed(2));
  rows.push(`| ${pairs[index + 1]} | ${values.join(' | ')} |`);
  console.log(`::notice title=Cobertura ${pairs[index + 1]}::${metrics.map((metric, i) => `${metric} ${values[i]}%`).join(', ')}`);
}
const sha = process.env.GITHUB_SHA ?? 'local';
const table = [`### Cobertura de testes (${sha})`, '', '| Escopo | Statements | Branches | Functions | Lines |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
else console.log(table);
