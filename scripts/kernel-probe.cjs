// Reads a SQLite database with plain Node: no --permission, no module block.
// Run as the app user, it isolates the OS layer of the boundary from the Node layers.
// Used by verify-uid-isolation.mjs. Prints LEAKED or "blocked by kernel".
const { DatabaseSync } = require('node:sqlite');
try {
  const rows = new DatabaseSync(process.argv[2], { readOnly: true }).prepare('select email from api_tokens').all();
  console.log('LEAKED ' + JSON.stringify(rows));
} catch (e) {
  console.log('blocked by kernel: ' + (e.code || e.message));
}
