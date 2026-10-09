// Loads the SAME support module the real integration/security-db global setup loads. Merely importing it
// pulls in `embedded-postgres`, whose import-time exit hook is what once forced exit code 0.
import '../../support/embedded-postgres.js';

export default function setup(): void {
  // nothing to start: the import side effect is the thing under test
}
