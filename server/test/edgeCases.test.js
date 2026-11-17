const http = require('node:http');

const {
  afterEach,
  describe,
  expect,
  jest: jestApi,
  test,
} = require('@jest/globals');

const originalPort = process.env.PORT;
const originalDotenvQuiet = process.env.DOTENV_CONFIG_QUIET;

/**
 * Restore process-wide state after each module-isolation test.
 */
afterEach(() => {
  jestApi.restoreAllMocks();
  jestApi.resetModules();

  if (originalPort === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = originalPort;
  }

  if (originalDotenvQuiet === undefined) {
    delete process.env.DOTENV_CONFIG_QUIET;
  } else {
    process.env.DOTENV_CONFIG_QUIET = originalDotenvQuiet;
  }
});

/**
 * Load server/index.js in an isolated module registry while preventing the
 * exported server from binding a real port. This keeps the test free of fixed
 * ports, port conflicts, and leaked listeners.
 */
function loadAppWithCapturedPort() {
  let capturedPort;
  const listenSpy = jestApi
    .spyOn(http.Server.prototype, 'listen')
    .mockImplementation(function mockListen(...args) {
      capturedPort = args[0];
      return this;
    });

  jestApi.isolateModules(() => {
    require('../index');
  });

  return { capturedPort, listenSpy };
}

describe('server port selection', () => {
  test('falls back to port 3000 when PORT is not configured', () => {
    process.env.DOTENV_CONFIG_QUIET = 'true';
    delete process.env.PORT;

    const { capturedPort, listenSpy } = loadAppWithCapturedPort();

    expect(listenSpy).toHaveBeenCalledTimes(1);
    expect(capturedPort).toBe(3000);
  });
});
