const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Playwright treats positional file arguments as regular expressions. On
// Windows, paths copied from Explorer/VS Code contain backslashes, which are
// then interpreted as regex escapes and match no test files. Normalize only
// positional arguments; option values such as grep expressions stay intact.
const args = process.argv.slice(2).map((argument) =>
  argument.startsWith('-') ? argument : argument.replaceAll('\\', '/'),
);

const playwrightCli = path.resolve(__dirname, '../node_modules/playwright/cli.js');
const result = spawnSync(process.execPath, [playwrightCli, 'test', ...args], {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
